// The session manager owns the omp processes and the per session state the
// phone sees: transcript, status, open dialog, queued messages. It implements
// SessionManagerPort and is the only place that talks to omp processes.

import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, sep } from "node:path";
import type { ClientMessage, ServerMessage } from "../../shared/protocol";
import type { CommandView, DialogView, ModelView, QueuedMessages, SessionSnapshot, SessionSummary } from "../../shared/types";
import { type Alerter, createAlerter } from "../alerts";
import type { BurrowConfig } from "../config";
import { startOmpProcess } from "../omp/client";
import type { OmpCommand, OmpEvent, OmpProcess } from "../omp/port";
import { listRepos, resolveRepo } from "../repos/allowlist";
import { isOmpProcess, processName } from "../repos/holder";
import { sessionFileOwners } from "../repos/open-proc";
import { listRecentSessions } from "../repos/session-files";
import { toCancelResponse, toDialogView, toUiResponse } from "./dialogs";
import type { BurrowError, Delivery, Result, SessionManagerPort, StartSessionInput, StopReason } from "./port";
import { readHeader } from "./session-tail";
import { createStatusTracker, type StatusTracker } from "./status";
import { createTranscript, extractParts, type Transcript } from "./transcript";
import { createWatcher, type Watcher } from "./watch";

export interface SessionManagerOptions {
	config: BurrowConfig;
	spawn?: typeof startOmpProcess;
	alerter?: Alerter;
	env?: Record<string, string>;
	now?: () => Date;
	/** Deadline for the post-handshake setup commands. Defaults to SETUP_TIMEOUT_MS. */
	setupTimeoutMs?: number;
	/** How long a takeover waits for the signalled holder to release the file. Defaults to ADOPT_TIMEOUT_MS. */
	adoptTimeoutMs?: number;
	/** How often a takeover checks whether the file was released. Defaults to ADOPT_POLL_MS. */
	adoptPollMs?: number;
	/** How often a read only view looks for new lines in the file it follows. Defaults to WATCH_POLL_MS. */
	watchPollMs?: number;
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
const ADOPT_TIMEOUT_MS = 10_000;
const ADOPT_POLL_MS = 200;
const WATCH_POLL_MS = 1000;
const WITHDRAWN_NOTICE_MAX = 300;
// The model list changes with configuration, not per turn; a phone picker does not need it fresh.
const MODEL_CACHE_TTL_MS = 5 * 60_000;
const MODEL_LIST_LIMIT = 400;

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A field the phone must fill in: the wire is a cast, so every payload is checked here. */
function isText(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
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
	/** omp's slash commands; null until the update frame or the setup request answered. */
	commands: CommandView[] | null;
	/** Last model list read from omp, kept for MODEL_CACHE_TTL_MS. */
	models: { models: ModelView[]; fetchedAt: number } | null;
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

/** A session file another process holds, followed read only; no omp process of ours. */
interface WatchedSession {
	id: string;
	file: string;
	repo: { path: string; name: string };
	watcher: Watcher;
	summary: SessionSummary;
	timer: ReturnType<typeof setInterval> | null;
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

/** omp's slash commands, from an `available_commands_update` frame or the request answer. */
function parseCommands(raw: unknown): CommandView[] {
	if (!Array.isArray(raw)) return [];
	const out: CommandView[] = [];
	for (const entry of raw) {
		if (!isRec(entry) || typeof entry.name !== "string" || entry.name === "") continue;
		const input = isRec(entry.input) ? entry.input : {};
		const subcommands: CommandView["subcommands"] = [];
		if (Array.isArray(entry.subcommands)) {
			for (const sub of entry.subcommands) {
				if (!isRec(sub) || typeof sub.name !== "string" || sub.name === "") continue;
				subcommands.push({ name: sub.name, description: typeof sub.description === "string" ? sub.description : "" });
			}
		}
		out.push({
			name: entry.name,
			description: typeof entry.description === "string" ? entry.description : "",
			hint: typeof input.hint === "string" ? input.hint : "",
			subcommands,
		});
	}
	return out;
}

/** The model list, capped: a provider registry can be far larger than a picker is useful for. */
function parseModels(raw: unknown): ModelView[] {
	if (!Array.isArray(raw)) return [];
	const out: ModelView[] = [];
	for (const entry of raw) {
		if (out.length === MODEL_LIST_LIMIT) break;
		if (!isRec(entry) || typeof entry.id !== "string" || typeof entry.provider !== "string") continue;
		out.push({
			provider: entry.provider,
			id: entry.id,
			name: typeof entry.name === "string" ? entry.name : entry.id,
			contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : null,
			reasoning: entry.reasoning === true,
		});
	}
	return out;
}

export function createSessionManager(options: SessionManagerOptions): SessionManagerPort {
	const { config } = options;
	const spawn = options.spawn ?? startOmpProcess;
	const alerter = options.alerter ?? createAlerter({ ntfyUrl: config.ntfyUrl, origin: config.origin });
	const now = options.now ?? (() => new Date());
	const setupTimeoutMs = options.setupTimeoutMs ?? SETUP_TIMEOUT_MS;
	const adoptTimeoutMs = options.adoptTimeoutMs ?? ADOPT_TIMEOUT_MS;
	const adoptPollMs = options.adoptPollMs ?? ADOPT_POLL_MS;
	const watchPollMs = options.watchPollMs ?? WATCH_POLL_MS;
	const running = new Map<string, LiveSession>();
	/** Resumes in flight, by resolved session file: concurrent callers share one. */
	const resumes = new Map<string, Promise<Result<SessionSummary>>>();
	/** Processes spawned but not yet registered in `running`. */
	const launching = new Set<OmpProcess>();
	/** Read only views of session files other processes hold, by session id. */
	const watching = new Map<string, WatchedSession>();
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
			openElsewhere: false,
			canTakeOver: false,
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

	/** Reads omp's state and pushes it; false when the read failed, leaving the last view in place. */
	async function refreshState(live: LiveSession): Promise<boolean> {
		const state = await live.proc.send<Rec>({ type: "get_state" });
		if (!state.ok || !isRec(state.data)) return false;
		live.status.setState(state.data);
		if (typeof state.data.sessionFile === "string") live.sessionFile = state.data.sessionFile;
		// omp owns the name once one is set; the phone's title follows it.
		if (isText(state.data.sessionName)) live.title = state.data.sessionName;
		emitStatus(live);
		return true;
	}

	/**
	 * One mutation of a live session: omp applies it, then the state is read back so the
	 * phone's status line follows. A failed RPC keeps the last known status.
	 */
	async function mutate(live: LiveSession, command: OmpCommand): Promise<Delivery> {
		const res = await live.proc.send(command);
		if (!res.ok) return { status: "error", error: res.error };
		await refreshState(live);
		return { status: "ok" };
	}

	/** Stores a command list and shows it to the phone (a no-op until setup finished). */
	function setCommands(live: LiveSession, raw: unknown): void {
		const commands = parseCommands(raw);
		live.commands = commands;
		emit(live, { type: "commands", commands });
	}

	/** The model list, read from omp again once the cache is older than MODEL_CACHE_TTL_MS. */
	async function availableModels(live: LiveSession): Promise<{ models: ModelView[]; error?: string }> {
		const cached = live.models;
		if (cached !== null && now().getTime() - cached.fetchedAt < MODEL_CACHE_TTL_MS) return { models: cached.models };
		const res = await live.proc.send<Rec>({ type: "get_available_models" });
		if (!res.ok) return { models: cached?.models ?? [], error: `get_available_models failed: ${res.error}` };
		if (!isRec(res.data) || !Array.isArray(res.data.models)) {
			return { models: cached?.models ?? [], error: "get_available_models returned no model list" };
		}
		const models = parseModels(res.data.models);
		live.models = { models, fetchedAt: now().getTime() };
		return { models };
	}

	/** Thinking levels are not cached: plugins register and drop them while a session runs. */
	async function availableThinkingLevels(live: LiveSession): Promise<string[]> {
		const res = await live.proc.send<Rec>({ type: "get_available_thinking_levels" });
		if (!res.ok || !isRec(res.data) || !Array.isArray(res.data.levels)) return [];
		return res.data.levels.filter((level): level is string => typeof level === "string");
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
			case "available_commands_update":
				// omp pushes the whole list at startup and whenever plugin metadata changes.
				setCommands(live, event.commands);
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

	/** The pid of a process other than Burrow's own children that has the session file open. */
	async function holderOf(file: string): Promise<number | undefined> {
		let dir = config.sessionsDir;
		try {
			dir = await realpath(config.sessionsDir);
		} catch {}
		const owners = await sessionFileOwners(dir, { excludePids: ownPids(), ownPid: process.pid });
		return owners.get(file);
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
		if (live.commands === null) {
			// A runtime that never pushes the update frame still has the list on request.
			// A failure here leaves the completion menu empty, it does not fail the session.
			const res = await live.proc.send<unknown>({ type: "get_available_commands" });
			const data = res.ok ? res.data : null;
			const raw = Array.isArray(data) ? data : isRec(data) ? data.commands : null;
			if (Array.isArray(raw)) live.commands = parseCommands(raw);
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

	/** The live session writing that file, stopping or not. */
	function liveWithFile(file: string): LiveSession | undefined {
		return [...running.values()].find((live) => live.sessionFile === file);
	}

	/** One writer per session file: reuse a live session, wait out a stopping one, refuse a foreign holder. */
	async function resume(repo: LiveSession["repo"], file: string): Promise<Result<SessionSummary>> {
		for (;;) {
			const existing = liveWithFile(file);
			if (!existing) break;
			if (!existing.stopping) return { ok: true, value: summaryOf(existing) };
			await existing.ended.promise;
		}
		if ((await holderOf(file)) !== undefined) return fail("open_elsewhere", "That session is open in another omp process");
		return launch(repo, file);
	}

	async function adopt(sessionFile: string): Promise<Result<SessionSummary>> {
		if (closed) return fail("shutting_down", "Burrow is shutting down");
		const existing = liveWithFile(sessionFile);
		if (existing && !existing.stopping) return { ok: true, value: summaryOf(existing) };
		const repo = await headerRepo(sessionFile);
		if (!repo.ok) return repo;
		const checked = await checkResumeFile(sessionFile, repo.value.path);
		if (!checked.ok) return checked;
		const released = await releaseHolder(checked.value);
		if (!released.ok) return released;
		return start({ repoPath: repo.value.path, sessionFile: checked.value });
	}

	/** The allowlisted repo the session file's header cwd names. */
	async function headerRepo(file: string): Promise<Result<LiveSession["repo"]>> {
		let cwd: string | null;
		try {
			cwd = await sessionHeaderCwd(file);
		} catch {
			return fail("invalid_session_file", `Session file not found: ${file}`);
		}
		const repo = cwd === null ? null : await resolveRepo(config.repos, cwd);
		if (!repo?.ok) return fail("repo_not_allowed", "Session file does not belong to an allowlisted repo");
		return repo;
	}

	/** Stops the omp holding the file and waits for the file to be released; no holder is already released. */
	async function releaseHolder(file: string): Promise<Result<null>> {
		const pid = await holderOf(file);
		if (pid === undefined) return { ok: true, value: null };
		if (!(await isOmpProcess(pid))) {
			return fail("holder_not_omp", `That session is held by ${await processName(pid)}, not an omp process`);
		}
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// it exited between the scan and the signal, which is the outcome wanted
		}
		const deadline = performance.now() + adoptTimeoutMs;
		while ((await holderOf(file)) !== undefined) {
			if (performance.now() >= deadline) return fail("takeover_failed", "omp at the host still holds the session; quit it there first");
			await Bun.sleep(adoptPollMs);
		}
		return { ok: true, value: null };
	}

	/** Whether another process holds the file, and whether it is one Burrow could stop. */
	async function holderFlags(file: string): Promise<{ openElsewhere: boolean; canTakeOver: boolean }> {
		const holder = await holderOf(file);
		return {
			openElsewhere: holder !== undefined,
			canTakeOver: holder !== undefined && (await isOmpProcess(holder)),
		};
	}

	/** The row the phone sees for a session file another process holds. */
	async function watchedSummary(
		id: string,
		file: string,
		repo: { path: string; name: string },
		title: string,
	): Promise<SessionSummary> {
		let modified = now();
		try {
			modified = (await stat(file)).mtime;
		} catch {
			// A file that vanished keeps the time of the last read.
		}
		return {
			id,
			repo: repo.path,
			repoName: repo.name,
			title: title === "" ? repo.name : title,
			status: "idle",
			running: false,
			...(await holderFlags(file)),
			sessionFile: file,
			updatedAt: modified.toISOString(),
		};
	}

	/**
	 * Keeps the row honest while following: a holder appears, or quits, or the file moves on.
	 * The phone hears about it, so the read only view can offer to take over exactly when an
	 * omp is there to stop.
	 */
	async function refreshWatched(watched: WatchedSession): Promise<void> {
		const flags = await holderFlags(watched.file);
		let modified = watched.summary.updatedAt;
		try {
			modified = (await stat(watched.file)).mtime.toISOString();
		} catch {
			// A file that vanished keeps the time it had.
		}
		const changed =
			flags.openElsewhere !== watched.summary.openElsewhere || flags.canTakeOver !== watched.summary.canTakeOver;
		if (!changed && modified === watched.summary.updatedAt) return;
		watched.summary = { ...watched.summary, ...flags, updatedAt: modified };
		if (changed) emitRaw(watched.id, { type: "session", session: watched.summary });
	}

	/**
	 * Follows a session file another process at the host holds, read only: nothing is
	 * spawned, nothing is written, and a phone that opens it reads the transcript without
	 * being able to prompt it. Take over is what turns the same session writable.
	 */
	async function watch(sessionFile: string): Promise<Result<SessionSummary>> {
		if (closed) return fail("shutting_down", "Burrow is shutting down");
		const already = [...watching.values()].find((watched) => watched.file === sessionFile);
		if (already !== undefined) return { ok: true, value: already.summary };
		if (liveWithFile(sessionFile) !== undefined) return fail("already_running", "That session is already running");
		const repo = await headerRepo(sessionFile);
		if (!repo.ok) return repo;
		const checked = await checkResumeFile(sessionFile, repo.value.path);
		if (!checked.ok) return checked;
		const header = await readHeader(checked.value);
		if (header === null) return fail("invalid_session_file", `Session file has no header: ${checked.value}`);
		const watcher = await createWatcher({ file: checked.value });
		const summary = await watchedSummary(header.id, checked.value, repo.value, header.title);
		const watched: WatchedSession = { id: summary.id, file: checked.value, repo: repo.value, watcher, summary, timer: null };
		watched.timer = setInterval(() => void pollWatch(watched), watchPollMs);
		watching.set(summary.id, watched);
		return { ok: true, value: summary };
	}

	/** One poll of a read only view, pushed to whichever phone has that session open. */
	async function pollWatch(watched: WatchedSession): Promise<void> {
		let updates;
		try {
			updates = await watched.watcher.poll();
		} catch {
			return;
		}
		for (const update of updates) {
			if (update.kind === "reset") {
				const rebuilt = snapshot(watched.id);
				if (rebuilt !== null) emitRaw(watched.id, { type: "snapshot", snapshot: rebuilt });
			} else if (update.kind === "update") {
				emitRaw(watched.id, { type: "item_update", item: update.item });
			} else {
				for (const item of update.added) emitRaw(watched.id, { type: "item", item });
			}
		}
		await refreshWatched(watched);
	}

	function stopWatching(watched: WatchedSession): void {
		clearInterval(watched.timer ?? undefined);
		watched.timer = null;
		watching.delete(watched.id);
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
		if (resumeFile !== undefined && (await holderOf(resumeFile)) !== undefined) {
			await closeProcess(proc);
			return fail("open_elsewhere", "That session is open in another omp process");
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
			commands: null,
			models: null,
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
		const idle = recent.filter((s) => !liveFiles.has(s.sessionFile) && !liveIds.has(s.sessionId));
		const takeable = await ompPids(idle.map((s) => owners.get(s.sessionFile)));
		for (const session of idle) {
			const holder = owners.get(session.sessionFile);
			rows.push({
				id: session.sessionId,
				repo: session.cwd,
				repoName: basename(session.cwd),
				title: session.title,
				status: "idle",
				running: false,
				openElsewhere: holder !== undefined,
				canTakeOver: holder !== undefined && takeable.has(holder),
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

	/** The holders among these pids that are omp processes, each checked once. */
	async function ompPids(pids: Array<number | undefined>): Promise<Set<number>> {
		const distinct = [...new Set(pids.filter((pid): pid is number => pid !== undefined))];
		const omp = await Promise.all(distinct.map(isOmpProcess));
		return new Set(distinct.filter((_, i) => omp[i]));
	}

	function snapshot(sessionId: string): SessionSnapshot | null {
		const watched = watching.get(sessionId);
		if (watched !== undefined) {
			return {
				session: watched.summary,
				items: watched.watcher.items(),
				dialog: null,
				subagents: [],
				queued: { steering: [], followUp: [] },
				status: watched.watcher.status(),
				commands: [],
				truncated: watched.watcher.truncated(),
				readOnly: true,
			};
		}
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
			commands: live.commands ?? [],
			truncated,
			readOnly: false,
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
			case "list_models": {
				const [models, thinkingLevels] = await Promise.all([availableModels(live), availableThinkingLevels(live)]);
				// The models message carries a read failure itself, so the ack stays ok.
				emit(live, {
					type: "models",
					models: models.models,
					thinkingLevels,
					...(models.error === undefined ? {} : { error: models.error }),
				});
				return { status: "ok" };
			}
			case "refresh_state": {
				// A read that fails keeps the previous view; that is not a delivery failure.
				await refreshState(live);
				return { status: "ok" };
			}
			case "set_model": {
				if (!isText(message.provider) || !isText(message.modelId)) {
					return { status: "error", error: "set_model needs a provider and a modelId" };
				}
				return mutate(live, { type: "set_model", provider: message.provider, modelId: message.modelId });
			}
			case "cycle_model":
				return mutate(live, { type: "cycle_model" });
			case "set_thinking": {
				if (!isText(message.level)) return { status: "error", error: "set_thinking needs a level" };
				return mutate(live, { type: "set_thinking_level", level: message.level });
			}
			case "cycle_thinking":
				return mutate(live, { type: "cycle_thinking_level" });
			case "compact":
				return mutate(live, { type: "compact" });
			case "remove_queued": {
				if (message.queue !== "steering" && message.queue !== "followUp") {
					return { status: "error", error: 'remove_queued needs queue "steering" or "followUp"' };
				}
				if (!isText(message.text)) return { status: "error", error: "remove_queued needs the queued text" };
				// omp answers the removal and pushes the queue it now holds; no local guess.
				const res = await live.proc.send({ type: "remove_queued_message", message: message.text, queue: message.queue });
				return res.ok ? { status: "ok" } : { status: "error", error: res.error };
			}
			case "promote_queued": {
				if (!isText(message.text)) return { status: "error", error: "promote_queued needs the queued text" };
				const res = await live.proc.send({ type: "promote_queued_message", message: message.text });
				return res.ok ? { status: "ok" } : { status: "error", error: res.error };
			}
			case "restore_queue": {
				const res = await live.proc.send<Rec>({ type: "abort_and_restore_queue" });
				// An older runtime rejects the command; the queue then stays exactly as it is.
				if (!res.ok) return { status: "error", error: res.error };
				const data = isRec(res.data) ? res.data : {};
				live.queued = { steering: [], followUp: [] };
				emit(live, { type: "queued", queued: live.queued });
				// The texts are what the composer puts back, so the phone gets them as plain strings.
				emit(live, { type: "queue_restored", steering: queueTexts(data.steering), followUp: queueTexts(data.followUp) });
				return { status: "ok" };
			}
			case "cancel_subagent": {
				if (!isText(message.subagentId)) return { status: "error", error: "cancel_subagent needs a subagentId" };
				const res = await live.proc.send({ type: "cancel_subagent", subagentId: message.subagentId });
				return res.ok ? { status: "ok" } : { status: "error", error: res.error };
			}
			case "steer_subagent": {
				if (!isText(message.subagentId) || !isText(message.message)) {
					return { status: "error", error: "steer_subagent needs a subagentId and a message" };
				}
				const res = await live.proc.send({ type: "steer_subagent", subagentId: message.subagentId, message: message.message });
				return res.ok ? { status: "ok" } : { status: "error", error: res.error };
			}
			case "rename_session": {
				if (!isText(message.name)) return { status: "error", error: "rename_session needs a name" };
				const res = await live.proc.send({ type: "set_session_name", name: message.name });
				if (!res.ok) return { status: "error", error: res.error };
				live.title = message.name;
				await refreshState(live);
				emitSummary(live);
				return { status: "ok" };
			}
			case "goal_action": {
				if (message.op !== "resume" && message.op !== "pause" && message.op !== "drop") {
					return { status: "error", error: 'goal_action needs op "resume", "pause" or "drop"' };
				}
				return mutate(live, { type: "goal", op: message.op });
			}
			case "bash": {
				if (!isText(message.command)) return { status: "error", error: "bash needs a command" };
				// The card is on screen before the command runs, so a slow one never looks ignored.
				const card = live.transcript.startBash(message.command);
				emit(live, card.message);
				const res = await live.proc.send<Rec>({ type: "bash", command: message.command });
				if (!res.ok) {
					// An answer that never arrives fails the same way: omp exiting fails its pending sends.
					const update = live.transcript.finishBash(card.id, { status: "error", exitCode: null, output: res.error });
					if (update !== null) emit(live, update);
					return { status: "error", error: res.error };
				}
				const data = isRec(res.data) ? res.data : {};
				const cancelled = data.cancelled === true;
				const exitCode = typeof data.exitCode === "number" ? data.exitCode : null;
				const update = live.transcript.finishBash(card.id, {
					status: cancelled || exitCode !== 0 ? "error" : "done",
					exitCode,
					output: typeof data.output === "string" ? data.output : "",
					cancelled,
					truncated: data.truncated === true,
				});
				if (update !== null) emit(live, update);
				// The command's own exit code is data, not a delivery failure: the phone shows it.
				return { status: "ok" };
			}
		}
	}

	async function deliver(sessionId: string, message: ClientMessage): Promise<Delivery> {
		// A watched session is another process's: the phone reads it, it does not drive it.
		if (watching.has(sessionId)) return { status: "error", error: "read_only" };
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
		const watched = watching.get(sessionId);
		if (watched !== undefined) {
			stopWatching(watched);
			emitRaw(sessionId, { type: "session", session: { ...watched.summary, status: "stopped" } });
			return { ok: true, value: null };
		}
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
		adopt,
		watch,
		snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		deliver,
		stop,
		heldIds: () => [...running.keys(), ...watching.keys()],
		async shutdown() {
			closed = true;
			for (const watched of [...watching.values()]) stopWatching(watched);
			await Promise.allSettled([
				...[...running.keys()].map((id) => stop(id, "shutdown")),
				...[...launching].map((proc) => closeProcess(proc)),
				...launches,
			]);
		},
	};
}
