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
}

const LIST_LIMIT = 30;
const APPLIED_LIMIT = 200;
const TITLE_MAX = 60;
const PAGE_LIMIT = 256;
const MAX_PAGES = 20;
const HEADER_BYTES = 64 * 1024;
const CLOSE_WAIT_MS = 6000;
const KILL_WAIT_MS = 2000;

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
	dialog: DialogView | null;
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
	const running = new Map<string, LiveSession>();
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
		return live.dialog ? { ...view, status: "needs_answer" as const } : view;
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

	function clearDialog(live: LiveSession): void {
		if (!live.dialog) return;
		live.dialog = null;
		emit(live, { type: "dialog", dialog: null });
		emitStatus(live);
	}

	function ownPids(): Set<number> {
		return new Set([...running.values()].map((live) => live.proc.pid));
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
					if (live.dialog && live.dialog.id === event.targetId) clearDialog(live);
					return;
				}
				if (!alerter.needsAnswer(method)) return;
				const dialog = toDialogView(event);
				if (!dialog) return;
				live.dialog = dialog;
				emit(live, { type: "dialog", dialog });
				emitStatus(live);
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
		running.delete(live.id);
		if (live.dialog) {
			live.dialog = null;
			emit(live, { type: "dialog", dialog: null });
		}
		live.updatedAt = now();
		emitSummary(live);
		if (notice !== null) emit(live, live.transcript.appendNotice(notice));
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

	/** Checks the file is a session file under sessionsDir whose header cwd is the allowlisted repo, and nobody else holds it. */
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
		const owners = await sessionFileOwners(realDir, { excludePids: ownPids(), ownPid: process.pid });
		if (owners.has(realFile)) return fail("open_at_laptop", "That session is open in another omp process");
		return { ok: true, value: realFile };
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

		let resumeFile: string | undefined;
		if (input.sessionFile !== undefined) {
			const checked = await checkResumeFile(input.sessionFile, repo.value.path);
			if (!checked.ok) return checked;
			resumeFile = checked.value;
			for (const live of running.values()) {
				if (live.sessionFile === resumeFile) return { ok: true, value: summaryOf(live) };
			}
		}

		let proc: OmpProcess;
		try {
			proc = await spawn({
				command: config.ompCommand,
				cwd: repo.value.path,
				env: spawnEnv(),
				...(resumeFile === undefined ? {} : { resumeFile }),
			});
		} catch (error) {
			return fail("spawn_failed", errorMessage(error));
		}

		const live: LiveSession = {
			id: proc.sessionId ?? randomUUID(),
			repo: repo.value,
			proc,
			transcript: createTranscript({ now }),
			status: createStatusTracker(),
			dialog: null,
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
		try {
			problem = await setup(live, resumeFile !== undefined);
		} catch (error) {
			problem = errorMessage(error);
		}
		if (problem !== null || live.finalised) {
			live.finalised = true;
			await closeProcess(proc);
			return fail("setup_failed", problem ?? "omp exited during setup");
		}
		if (running.has(live.id)) {
			live.finalised = true;
			await closeProcess(proc);
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
		if (!live) return null;
		const { items, subagents, truncated } = live.transcript.snapshot();
		return {
			session: summaryOf(live),
			items,
			dialog: live.dialog,
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
				const res = await live.proc.send({ type: "abort" });
				return res.ok ? { status: "ok" } : { status: "error", error: res.error };
			}
			case "answer": {
				if (!live.dialog || live.dialog.id !== message.dialogId) {
					return { status: "error", error: "No open dialog with that id" };
				}
				const res = await live.proc.send(toUiResponse(live.dialog, message.answer));
				if (!res.ok) return { status: "error", error: res.error };
				clearDialog(live);
				return { status: "ok" };
			}
			case "discard_dialog": {
				if (!live.dialog || live.dialog.id !== message.dialogId) {
					return { status: "error", error: "No open dialog with that id" };
				}
				const res = await live.proc.send(toCancelResponse(live.dialog.id));
				if (!res.ok) return { status: "error", error: res.error };
				clearDialog(live);
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
		if (!live) return { status: "error", error: "session_not_found" };
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
			await Promise.allSettled([...running.keys()].map((id) => stop(id, "shutdown")));
		},
	};
}
