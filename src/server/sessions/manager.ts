// The session manager owns the omp processes and the per session state the
// phone sees: transcript, status, open dialog, queued messages. It implements
// SessionManagerPort and is the only place that talks to omp processes.

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, sep } from "node:path";
import type { ClientMessage, ServerMessage } from "../../shared/protocol";
import type { DialogView, QueuedMessages, SessionSnapshot, SessionSummary } from "../../shared/types";
import { type Alerter, createAlerter } from "../alerts";
import type { BurrowConfig } from "../config";
import { startOmpProcess } from "../omp/client";
import type { OmpEvent, OmpProcess } from "../omp/port";
import { listRepos, resolveRepo } from "../repos/allowlist";
import { sessionFileOwners } from "../repos/open-proc";
import { listRecentSessions } from "../repos/session-files";
import { toCancelResponse, toDialogView, toUiResponse } from "./dialogs";
import type { BurrowError, Delivery, Result, SessionManagerPort, StartSessionInput, StopReason } from "./port";
import { createStatusTracker, type StatusTracker } from "./status";
import { createTranscript, extractParts, type Transcript } from "./transcript";

export interface SessionManagerOptions {
	config: BurrowConfig;
	spawn?: typeof startOmpProcess;
	alerter?: Alerter;
	env?: Record<string, string>;
	now?: () => Date;
	/** Deadline for the post-handshake setup commands. Defaults to SETUP_TIMEOUT_MS. */
	setupTimeoutMs?: number;
}

const LIST_LIMIT = 30;
const APPLIED_LIMIT = 200;
const TITLE_MAX = 60;
const PAGE_LIMIT = 256;
const MAX_PAGES = 20;
const HEADER_BYTES = 64 * 1024;
const CLOSE_WAIT_MS = 6000;
const KILL_WAIT_MS = 2000;
const SETUP_TIMEOUT_MS = 30_000;
const WITHDRAWN_NOTICE_MAX = 300;

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string): { ok: false; error: BurrowError } {
	return { ok: false, error: { code, message } };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface LiveSession {
	id: string;
	repo: { path: string; name: string };
	proc: OmpProcess;
	transcript: Transcript;
	status: StatusTracker;
	/** Open dialogs, oldest first; the phone sees the first one. */
	dialogs: DialogView[];
	queued: QueuedMessages;
	sessionFile: string | null;
	title: string | null;
	updatedAt: Date;
	/** Time of the first agent_start since the previous session_settled. */
	activityStart: number | null;
	applied: Set<string>;
	lastStatus: string;
	/** Events are applied from spawn on, but only emitted once setup finished. */
	ready: boolean;
	finalised: boolean;
	stopping: boolean;
	/** Resolves once finalise() ran. */
	ended: PromiseWithResolvers<void>;
}

function queueTexts(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") out.push(entry);
		else if (isRec(entry) && typeof entry.text === "string") out.push(entry.text);
	}
	return out;
}

function sleep(ms: number): Promise<"timeout"> {
	return Bun.sleep(ms).then(() => "timeout" as const);
}

export function createSessionManager(options: SessionManagerOptions): SessionManagerPort {
	const { config } = options;
	const spawn = options.spawn ?? startOmpProcess;
	const alerter = options.alerter ?? createAlerter({ ntfyUrl: config.ntfyUrl, origin: config.origin });
	const now = options.now ?? (() => new Date());
	const setupTimeoutMs = options.setupTimeoutMs ?? SETUP_TIMEOUT_MS;
	const running = new Map<string, LiveSession>();
	/** Resumes in flight, by resolved session file: concurrent callers share one. */
	const resumes = new Map<string, Promise<Result<SessionSummary>>>();
	/** Processes spawned but not yet registered in `running`. */
	const launching = new Set<OmpProcess>();
	/** Launches in flight, so shutdown() can wait for them to give up. */
	const launches = new Set<Promise<unknown>>();
	const listeners = new Set<(sessionId: string | null, message: ServerMessage) => void>();
	let closed = false;

	function emitRaw(sessionId: string | null, message: ServerMessage): void {
		for (const listener of [...listeners]) {
			try {
				listener(sessionId, message);
			} catch {
				// a broken subscriber must not disturb a session
			}
		}
	}

	function emit(live: LiveSession, message: ServerMessage): void {
		if (live.ready) emitRaw(live.id, message);
	}

	function currentStatus(live: LiveSession) {
		const view = live.status.snapshot();
		return live.dialogs.length > 0 ? { ...view, status: "needs_answer" as const } : view;
	}

	function summaryOf(live: LiveSession): SessionSummary {
		if (live.title === null) {
			const first = live.transcript.snapshot().items.find((item) => item.kind === "user" && item.text.trim() !== "");
			if (first) live.title = first.text.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
		}
		return {
			id: live.id,
			repo: live.repo.path,
			repoName: live.repo.name,
			title: live.title ?? live.repo.name,
			status: live.finalised ? "stopped" : currentStatus(live).status,
			running: !live.finalised,
			openAtLaptop: false,
			sessionFile: live.sessionFile,
			updatedAt: live.updatedAt.toISOString(),
		};
	}

	function emitSummary(live: LiveSession): void {
		if (!live.ready) return;
		const message: ServerMessage = { type: "session", session: summaryOf(live) };
		emitRaw(live.id, message);
		emitRaw(null, message);
	}

	function emitStatus(live: LiveSession): void {
		emit(live, { type: "status", status: currentStatus(live) });
		const status = currentStatus(live).status;
		if (status !== live.lastStatus) {
			live.lastStatus = status;
			emitSummary(live);
		}
	}

	function showDialog(live: LiveSession): void {
		emit(live, { type: "dialog", dialog: live.dialogs[0] ?? null });
		emitStatus(live);
	}

	/** Drops a dialog; when it was the open one, the next one (or none) is shown. */
	function removeDialog(live: LiveSession, id: unknown): void {
		const index = live.dialogs.findIndex((dialog) => dialog.id === id);
		if (index === -1) return;
		live.dialogs.splice(index, 1);
		if (index === 0) showDialog(live);
	}

	function ownPids(): Set<number> {
		return new Set([...[...running.values()].map((live) => live.proc.pid), ...[...launching].map((proc) => proc.pid)]);
	}

	async function refreshState(live: LiveSession): Promise<void> {
		const state = await live.proc.send<Rec>({ type: "get_state" });
		if (!state.ok || !isRec(state.data)) return;
		live.status.setState(state.data);
		if (typeof state.data.sessionFile === "string") live.sessionFile = state.data.sessionFile;
	}

	function handleEvent(live: LiveSession, event: OmpEvent): void {
		live.updatedAt = now();
		switch (event.type) {
			case "extension_ui_request": {
				const method = typeof event.method === "string" ? event.method : "";
				if (method === "cancel") {
					removeDialog(live, event.targetId);
					return;
				}
				if (!alerter.needsAnswer(method)) return;
				const dialog = toDialogView(event);
				if (!dialog || live.dialogs.some((open) => open.id === dialog.id)) return;
				live.dialogs.push(dialog);
				if (live.dialogs.length > 1) return;
				showDialog(live);
				if (live.ready) alerter.dialogOpened({ sessionId: live.id, repoName: live.repo.name, method });
				return;
			}
			case "message_start":
			case "message_update":
			case "message_end":
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end":
			case "subagent_lifecycle":
			case "subagent_progress":
				for (const message of live.transcript.handle(event)) emit(live, message);
				return;
			case "agent_start":
				if (live.activityStart === null) live.activityStart = now().getTime();
				live.status.handle(event);
				emitStatus(live);
				return;
			case "agent_end":
				live.status.handle(event);
				emitStatus(live);
				return;
			case "session_settled": {
				live.status.handle(event);
				emitStatus(live);
				const durationMs = live.activityStart === null ? undefined : Math.max(0, now().getTime() - live.activityStart);
				live.activityStart = null;
				if (live.ready) {
					alerter.sessionSettled({
						sessionId: live.id,
						repoName: live.repo.name,
						...(durationMs === undefined ? {} : { durationMs }),
					});
				}
				void refreshState(live)
					.catch(() => {})
					.then(() => {
						if (!live.finalised) emitSummary(live);
					});
				return;
			}
			case "queue_update":
				live.queued = { steering: queueTexts(event.steering), followUp: queueTexts(event.followUp) };
				emit(live, { type: "queued", queued: live.queued });
				return;
			case "notice":
			case "rpc_frame_error":
			case "extension_error": {
				const raw = event.type === "notice" ? (event.message ?? event.text) : (event.error ?? event.message);
				const text = typeof raw === "string" ? raw : "";
				if (text === "") return;
				emit(live, live.transcript.appendNotice(event.type === "notice" ? text : `omp: ${text}`));
				return;
			}
			default:
				return;
		}
	}

	function finalise(live: LiveSession, notice: string | null): void {
		if (live.finalised) return;
		live.finalised = true;
		// A process that lost the race for its id during setup must not unregister the winner.
		if (running.get(live.id) === live) running.delete(live.id);
		if (live.dialogs.length > 0) {
			live.dialogs = [];
			emit(live, { type: "dialog", dialog: null });
		}
		live.updatedAt = now();
		emitSummary(live);
		if (notice !== null) emit(live, live.transcript.appendNotice(notice));
		live.ended.resolve();
	}

	async function sessionHeaderCwd(file: string): Promise<string | null> {
		const text = await Bun.file(file).slice(0, HEADER_BYTES).text();
		for (const line of text.split("\n", 200)) {
			try {
				const parsed: unknown = JSON.parse(line);
				if (isRec(parsed) && parsed.type === "session" && typeof parsed.cwd === "string") return parsed.cwd;
			} catch {}
		}
		return null;
	}

	/** Checks the file is a session file under sessionsDir whose header cwd is the allowlisted repo. */
	async function checkResumeFile(file: string, repoPath: string): Promise<Result<string>> {
		let realFile: string;
		let realDir: string;
		try {
			[realFile, realDir] = await Promise.all([realpath(file), realpath(config.sessionsDir)]);
		} catch {
			return fail("invalid_session_file", `Session file not found: ${file}`);
		}
		if (!realFile.startsWith(realDir.endsWith(sep) ? realDir : realDir + sep) || !realFile.endsWith(".jsonl")) {
			return fail("invalid_session_file", "Session file is outside the sessions folder");
		}
		let cwd: string | null = null;
		try {
			cwd = await sessionHeaderCwd(realFile);
		} catch {}
		let allowed = false;
		if (cwd !== null) {
			const resolved = await resolveRepo(config.repos, cwd);
			allowed = resolved.ok && resolved.value.path === repoPath;
		}
		if (!allowed) return fail("repo_not_allowed", "Session file does not belong to this allowlisted repo");
		return { ok: true, value: realFile };
	}

	/** Whether a process other than Burrow's own children has the session file open. */
	async function heldElsewhere(file: string): Promise<boolean> {
		let dir = config.sessionsDir;
		try {
			dir = await realpath(config.sessionsDir);
		} catch {}
		const owners = await sessionFileOwners(dir, { excludePids: ownPids(), ownPid: process.pid });
		return owners.has(file);
	}

	function spawnEnv(): Record<string, string> {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
		return { ...env, ...options.env, BURROW: "1" };
	}

	async function closeProcess(proc: OmpProcess): Promise<void> {
		const settled = await Promise.race([proc.close().then(() => "closed" as const), sleep(CLOSE_WAIT_MS)]);
		if (settled === "timeout" && !proc.exited) {
			proc.kill();
			await Promise.race([proc.close(), sleep(KILL_WAIT_MS)]);
		}
	}

	/** Seeds the transcript from storage, oldest first. Only valid right after spawning. */
	async function seedFromStorage(live: LiveSession): Promise<string | null> {
		let cursor: string | undefined;
		const pages: unknown[][] = [];
		for (let page = 0; page < MAX_PAGES; page++) {
			const res = await live.proc.send<Rec>({
				type: "get_messages_page",
				limit: PAGE_LIMIT,
				...(cursor === undefined ? {} : { cursor }),
			});
			if (!res.ok) return `get_messages_page failed: ${res.error}`;
			if (!isRec(res.data)) break;
			if (Array.isArray(res.data.messages)) pages.push(res.data.messages);
			if (typeof res.data.nextCursor !== "string" || res.data.nextCursor === "") break;
			cursor = res.data.nextCursor;
		}
		let index = 0;
		for (const messages of pages) {
			for (const message of messages) {
				index += 1;
				if (!isRec(message) || (message.role !== "user" && message.role !== "assistant")) continue;
				const parts = extractParts(message);
				if (!parts || (parts.text === "" && parts.thinking === "")) continue;
				const messageId = typeof message.id === "string" && message.id !== "" ? message.id : `history:${index}`;
				live.transcript.handle({ type: "message_end", messageId, message });
			}
		}
		return null;
	}

	async function setup(live: LiveSession, resume: boolean): Promise<string | null> {
		const steps = [
			{ type: "set_event_filter", events: null, messageUpdates: "delta" },
			{ type: "set_ask_dialog", enabled: true },
			{ type: "set_subagent_subscription", level: "progress" },
		];
		for (const step of steps) {
			const res = await live.proc.send(step);
			if (!res.ok) return `${step.type} failed: ${res.error}`;
		}
		if (resume) {
			const seeded = await seedFromStorage(live);
			if (seeded !== null) return seeded;
		}
		const state = await live.proc.send<Rec>({ type: "get_state" });
		if (!state.ok) return `get_state failed: ${state.error}`;
		if (isRec(state.data)) {
			live.status.setState(state.data);
			if (typeof state.data.sessionId === "string" && state.data.sessionId !== "") live.id = state.data.sessionId;
			if (typeof state.data.sessionFile === "string") live.sessionFile = state.data.sessionFile;
		}
		return null;
	}

	async function start(input: StartSessionInput): Promise<Result<SessionSummary>> {
		if (closed) return fail("shutting_down", "Burrow is shutting down");
		const repo = await resolveRepo(config.repos, input.repoPath);
		if (!repo.ok) return repo;
		if (input.sessionFile === undefined) return launch(repo.value, undefined);

		const checked = await checkResumeFile(input.sessionFile, repo.value.path);
		if (!checked.ok) return checked;
		const file = checked.value;
		const inflight = resumes.get(file);
		if (inflight) return inflight;
		const work = resume(repo.value, file);
		resumes.set(file, work);
		const forget = () => resumes.delete(file);
		void work.then(forget, forget);
		return work;
	}

	/** One writer per session file: reuse a live session, wait out a stopping one, refuse a foreign holder. */
	async function resume(repo: LiveSession["repo"], file: string): Promise<Result<SessionSummary>> {
		for (;;) {
			const existing = [...running.values()].find((live) => live.sessionFile === file);
			if (!existing) break;
			if (!existing.stopping) return { ok: true, value: summaryOf(existing) };
			await existing.ended.promise;
		}
		if (await heldElsewhere(file)) return fail("open_at_laptop", "That session is open in another omp process");
		return launch(repo, file);
	}

	function launch(repo: LiveSession["repo"], resumeFile: string | undefined): Promise<Result<SessionSummary>> {
		const work = spawnSession(repo, resumeFile).catch((error: unknown) => fail("setup_failed", errorMessage(error)));
		launches.add(work);
		void work.then(() => launches.delete(work));
		return work;
	}

	async function spawnSession(repo: LiveSession["repo"], resumeFile: string | undefined): Promise<Result<SessionSummary>> {
		if (closed) return fail("shutting_down", "Burrow is shutting down");
		let proc: OmpProcess;
		try {
			proc = await spawn({
				command: config.ompCommand,
				cwd: repo.path,
				env: spawnEnv(),
				...(resumeFile === undefined ? {} : { resumeFile }),
			});
		} catch (error) {
			return fail("spawn_failed", errorMessage(error));
		}
		launching.add(proc);
		try {
			return await register(proc, repo, resumeFile);
		} finally {
			launching.delete(proc);
		}
	}

	async function register(
		proc: OmpProcess,
		repo: LiveSession["repo"],
		resumeFile: string | undefined,
	): Promise<Result<SessionSummary>> {
		if (closed) {
			await closeProcess(proc);
			return fail("shutting_down", "Burrow is shutting down");
		}
		// The writer check before spawn can race another omp opening the file.
		if (resumeFile !== undefined && (await heldElsewhere(resumeFile))) {
			await closeProcess(proc);
			return fail("open_at_laptop", "That session is open in another omp process");
		}

		const live: LiveSession = {
			id: proc.sessionId ?? randomUUID(),
			repo,
			proc,
			transcript: createTranscript({ now }),
			status: createStatusTracker(),
			dialogs: [],
			queued: { steering: [], followUp: [] },
			sessionFile: proc.sessionFile ?? resumeFile ?? null,
			title: null,
			updatedAt: now(),
			activityStart: null,
			applied: new Set(),
			lastStatus: "idle",
			ready: false,
			finalised: false,
			stopping: false,
			ended: Promise.withResolvers<void>(),
		};
		proc.onEvent((event) => {
			try {
				handleEvent(live, event);
			} catch {
				// an unexpected frame shape never takes the session down
			}
		});
		proc.onExit((info) => {
			const code = info.code === null ? `signal ${info.signal ?? "unknown"}` : `code ${info.code}`;
			finalise(live, live.stopping ? null : `omp exited with ${code}`);
		});

		let problem: string | null;
		let timedOut = false;
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), setupTimeoutMs);
		});
		try {
			const outcome = await Promise.race([
				setup(live, resumeFile !== undefined),
				deadline,
				live.ended.promise.then(() => "exited" as const),
			]);
			timedOut = outcome === "timeout";
			if (outcome === "timeout") problem = `omp did not finish setup within ${setupTimeoutMs} ms`;
			else if (outcome === "exited") problem = "omp exited during setup";
			else problem = outcome;
		} catch (error) {
			problem = errorMessage(error);
		} finally {
			clearTimeout(timer);
		}
		if (closed || problem !== null || live.finalised) {
			live.stopping = true;
			if (timedOut) {
				proc.kill();
				await Promise.race([proc.close(), sleep(KILL_WAIT_MS)]);
			} else {
				await closeProcess(proc);
			}
			finalise(live, null);
			if (closed) return fail("shutting_down", "Burrow is shutting down");
			return fail("setup_failed", problem ?? "omp exited during setup");
		}
		if (running.has(live.id)) {
			live.stopping = true;
			await closeProcess(proc);
			finalise(live, null);
			return fail("already_running", "That session is already running");
		}
		live.lastStatus = currentStatus(live).status;
		running.set(live.id, live);
		live.ready = true;
		const summary = summaryOf(live);
		emitRaw(live.id, { type: "session", session: summary });
		emitRaw(null, { type: "session", session: summary });
		return { ok: true, value: summary };
	}

	async function list(): Promise<SessionSummary[]> {
		const live = [...running.values()];
		const liveFiles = new Set(live.map((s) => s.sessionFile).filter((f): f is string => f !== null));
		const liveIds = new Set(live.map((s) => s.id));
		let dir = config.sessionsDir;
		try {
			dir = await realpath(config.sessionsDir);
		} catch {}
		const [recent, owners] = await Promise.all([
			listRecentSessions(dir, config.repos, { limit: LIST_LIMIT + live.length }),
			sessionFileOwners(dir, { excludePids: ownPids(), ownPid: process.pid }),
		]);
		const rows: SessionSummary[] = live.map(summaryOf);
		for (const session of recent) {
			if (liveFiles.has(session.sessionFile) || liveIds.has(session.sessionId)) continue;
			rows.push({
				id: session.sessionId,
				repo: session.cwd,
				repoName: basename(session.cwd),
				title: session.title,
				status: "idle",
				running: false,
				openAtLaptop: owners.has(session.sessionFile),
				sessionFile: session.sessionFile,
				updatedAt: session.updatedAt,
			});
		}
		rows.sort((a, b) => {
			if (a.running !== b.running) return a.running ? -1 : 1;
			return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
		});
		return rows.slice(0, LIST_LIMIT);
	}

	function snapshot(sessionId: string): SessionSnapshot | null {
		const live = running.get(sessionId);
		if (!live || live.stopping) return null;
		const { items, subagents, truncated } = live.transcript.snapshot();
		return {
			session: summaryOf(live),
			items,
			dialog: live.dialogs[0] ?? null,
			subagents,
			queued: live.queued,
			status: currentStatus(live),
			truncated,
		};
	}

	async function apply(live: LiveSession, message: ClientMessage): Promise<Delivery> {
		switch (message.type) {
			case "prompt": {
				const res = await live.proc.send({ type: "prompt", message: message.text, streamingBehavior: "followUp" });
				return res.ok ? { status: "ok" } : { status: "error", error: res.error };
			}
			case "abort": {
				// A plain abort lets queued follow-ups run in a fresh turn; this withdraws them first.
				const res = await live.proc.send<Rec>({ type: "abort_and_restore_queue" });
				if (!res.ok) {
					// Older runtimes reject the command.
					const fallback = await live.proc.send({ type: "abort" });
					return fallback.ok ? { status: "ok" } : { status: "error", error: fallback.error };
				}
				const data = isRec(res.data) ? res.data : {};
				const withdrawn = [...queueTexts(data.steering), ...queueTexts(data.followUp)]
					.map((text) => text.replace(/\s+/g, " ").trim())
					.filter((text) => text !== "");
				if (withdrawn.length > 0) {
					let text = `Stopped. Not sent, copy back if still wanted: ${withdrawn.map((t) => `“${t}”`).join(" · ")}`;
					if (data.truncated === true) text += " (more were lost)";
					if (text.length > WITHDRAWN_NOTICE_MAX) text = `${text.slice(0, WITHDRAWN_NOTICE_MAX - 1)}…`;
					emit(live, live.transcript.appendNotice(text));
				}
				return { status: "ok" };
			}
			case "answer": {
				const dialog = live.dialogs[0];
				if (!dialog || dialog.id !== message.dialogId) {
					return { status: "error", error: "No open dialog with that id" };
				}
				const res = await live.proc.send(toUiResponse(dialog, message.answer));
				if (!res.ok) return { status: "error", error: res.error };
				removeDialog(live, dialog.id);
				return { status: "ok" };
			}
			case "discard_dialog": {
				const dialog = live.dialogs[0];
				if (!dialog || dialog.id !== message.dialogId) {
					return { status: "error", error: "No open dialog with that id" };
				}
				const res = await live.proc.send(toCancelResponse(dialog.id));
				if (!res.ok) return { status: "error", error: res.error };
				removeDialog(live, dialog.id);
				return { status: "ok" };
			}
			case "stop_session": {
				const res = await stop(live.id, "handoff");
				return res.ok ? { status: "ok" } : { status: "error", error: res.error.message };
			}
		}
	}

	async function deliver(sessionId: string, message: ClientMessage): Promise<Delivery> {
		const live = running.get(sessionId);
		if (!live || live.stopping) return { status: "error", error: "session_not_found" };
		if (live.applied.has(message.clientId)) return { status: "duplicate" };
		live.applied.add(message.clientId);
		if (live.applied.size > APPLIED_LIMIT) {
			const oldest = live.applied.values().next().value;
			if (oldest !== undefined) live.applied.delete(oldest);
		}
		let result: Delivery;
		try {
			result = await apply(live, message);
		} catch (error) {
			result = { status: "error", error: errorMessage(error) };
		}
		// A failed delivery can be retried under the same id.
		if (result.status === "error") live.applied.delete(message.clientId);
		return result;
	}

	async function stop(sessionId: string, _reason: StopReason): Promise<Result<null>> {
		const live = running.get(sessionId);
		if (!live) return fail("session_not_found", `No running session ${sessionId}`);
		if (live.stopping) {
			await live.ended.promise;
			return { ok: true, value: null };
		}
		live.stopping = true;
		await closeProcess(live.proc);
		finalise(live, null);
		return { ok: true, value: null };
	}

	return {
		list,
		start,
		snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		deliver,
		stop,
		runningIds: () => [...running.keys()],
		async shutdown() {
			closed = true;
			await Promise.allSettled([
				...[...running.keys()].map((id) => stop(id, "shutdown")),
				...[...launching].map((proc) => closeProcess(proc)),
				...launches,
			]);
		},
	};
}
