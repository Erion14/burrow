// The phone app's state. Pure functions only: the connection module feeds
// ServerMessages in, screens render the result. Keeping this out of components
// is what makes reconnect and resend behavior testable with bun test.

import type { DialogAnswer, ServerMessage } from "../../shared/protocol";
import type {
	CommandView,
	DialogView,
	ModelView,
	QueuedMessages,
	RepoOption,
	SessionSummary,
	StatusView,
	SubagentView,
	TranscriptItem,
} from "../../shared/types";

/**
 * What screens may ask the app to do. Every method takes the plain value the
 * screen has; the app adds client ids, opens connections, and talks to the
 * server. Frozen here so screens and the app shell can be built separately.
 */
export interface AppActions {
	sendPrompt(text: string): void;
	setDraft(text: string): void;
	abort(): void;
	answerDialog(dialogId: string, answer: DialogAnswer): void;
	discardDialog(dialogId: string): void;
	/** Stop Burrow's process so the session can be resumed with `omp -r <id>`. */
	handOffToHost(): void;
	openSession(sessionId: string): void;
	/** Opens a session file another process at the host holds, read only. */
	watchSession(sessionFile: string): Promise<void>;
	newSession(repoPath: string, sessionFile?: string): Promise<void>;
	/** Stop the omp holding the session on the laptop and resume it here. */
	takeOver(sessionFile: string): Promise<void>;
	showSessions(): void;
	selectWorkspace(repo: string | null): void;
	showScreen(screen: Screen): void;
	turnRemoteOn(): Promise<void>;
	turnRemoteOff(): Promise<void>;
	refreshSessions(): void;
	/** omp settings and session mutation, each one a message on the wire. */
	setModel(provider: string, id: string): void;
	cycleModel(): void;
	setThinking(level: string): void;
	cycleThinking(): void;
	compact(): void;
	removeQueued(text: string, queue: "steering" | "followUp"): void;
	promoteQueued(text: string): void;
	restoreQueue(): void;
	cancelSubagent(subagentId: string): void;
	steerSubagent(subagentId: string, message: string): void;
	renameSession(name: string): void;
	goalAction(op: "resume" | "pause" | "drop"): void;
	/** A `!` message: runs in the session's shell, never reaches the model. */
	bash(command: string): void;
	listModels(): void;
	refreshState(): void;
	/** View state: the phone owns these, the server never hears about them. */
	openSheet(sheet: AppState["sheet"]): void;
	toggleTodos(): void;
	toggleThinkingVisible(): void;
	toggleTools(): void;
}

export type Screen = "sessions" | "chat" | "diff";
export type ConnectionState = "connecting" | "open" | "closed";

export interface AppState {
	connection: ConnectionState;
	/** Burrow itself is unreachable (Remote is OFF), the shell came from the cache. */
	remoteOff: boolean;
	screen: Screen;
	sessionId: string | null;
	session: SessionSummary | null;
	items: TranscriptItem[];
	dialog: DialogView | null;
	subagents: SubagentView[];
	queued: QueuedMessages;
	status: StatusView;
	sessions: SessionSummary[];
	repos: RepoOption[];
	/** null shows every workspace; a repo path narrows the session list to one. */
	workspaceFilter: string | null;
	/** The message being typed; kept here so switching screens does not lose it. */
	draft: string;
	error: string | null;
	/** The chat is a read only view of a file another process at the host writes. */
	readOnly: boolean;
	/** omp's slash commands, for the composer's `/` menu. */
	commands: CommandView[];
	/** The last known model list; a failed read keeps it rather than emptying the picker. */
	models: ModelView[];
	thinkingLevels: string[];
	modelsError: string | null;
	/** Which picker sheet is open; one at a time, null for none. */
	sheet: "models" | "thinking" | "goal" | null;
	todosOpen: boolean;
	/** Whether assistant thinking blocks are drawn at all. */
	thinkingVisible: boolean;
	/** null means every tool card keeps its own open state. */
	toolsOpen: boolean | null;
}

/** Transcript items kept in the phone's memory; older ones fall off the top. */
export const MAX_TRANSCRIPT_ITEMS = 500;

const IDLE_STATUS: StatusView = { status: "idle", isSettled: true, hasPendingAsyncWork: false };

export function initialAppState(): AppState {
	return {
		connection: "connecting",
		remoteOff: false,
		screen: "sessions",
		sessionId: null,
		session: null,
		items: [],
		dialog: null,
		subagents: [],
		queued: { steering: [], followUp: [] },
		status: IDLE_STATUS,
		readOnly: false,
		sessions: [],
		repos: [],
		workspaceFilter: null,
		draft: "",
		error: null,
		commands: [],
		models: [],
		thinkingLevels: [],
		modelsError: null,
		sheet: null,
		todosOpen: false,
		thinkingVisible: true,
		toolsOpen: null,
	};
}

function withItem(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
	const next = items.slice();
	const index = next.findIndex((existing) => existing.id === item.id);
	if (index >= 0) next[index] = item;
	else next.push(item);
	return next.length > MAX_TRANSCRIPT_ITEMS ? next.slice(next.length - MAX_TRANSCRIPT_ITEMS) : next;
}

function mergeSession(sessions: SessionSummary[], session: SessionSummary): SessionSummary[] {
	const next = sessions.slice();
	const index = next.findIndex((existing) => existing.id === session.id);
	if (index >= 0) next[index] = session;
	else next.push(session);
	return next;
}

/** An open dialog outranks the stream state in the status dot. */
function statusWithDialog(status: StatusView, dialog: DialogView | null): StatusView {
	if (dialog === null) return status;
	return { ...status, status: "needs_answer" };
}

export function applyServerMessage(state: AppState, message: ServerMessage): AppState {
	switch (message.type) {
		case "snapshot": {
			const snapshot = message.snapshot;
			return {
				...state,
				remoteOff: false,
				sessionId: snapshot.session.id,
				session: snapshot.session,
				items: snapshot.items.slice(-MAX_TRANSCRIPT_ITEMS),
				dialog: snapshot.dialog,
				subagents: snapshot.subagents,
				queued: snapshot.queued,
				status: statusWithDialog(snapshot.status, snapshot.dialog),
				sessions: mergeSession(state.sessions, snapshot.session),
				readOnly: snapshot.readOnly,
				commands: snapshot.commands,
			};
		}
		case "sessions":
			return { ...state, remoteOff: false, sessions: message.sessions, repos: message.repos };
		case "commands":
			return { ...state, commands: message.commands };
		case "models":
			// A read that failed reports itself here, and the phone keeps the list it
			// already had rather than offering an empty picker.
			if (message.error !== undefined) return { ...state, modelsError: message.error };
			return { ...state, models: message.models, thinkingLevels: message.thinkingLevels, modelsError: null };
		case "item":
			return { ...state, items: withItem(state.items, message.item) };
		case "item_update": {
			if (!state.items.some((item) => item.id === message.item.id)) return state;
			return { ...state, items: withItem(state.items, message.item) };
		}
		case "delta": {
			const index = state.items.findIndex((item) => item.id === message.itemId);
			if (index < 0) return state;
			const items = state.items.slice();
			const item = items[index]!;
			items[index] = { ...item, text: item.text + message.text, thinking: item.thinking + message.thinking };
			return { ...state, items };
		}
		case "status":
			return { ...state, status: statusWithDialog(message.status, state.dialog) };
		case "dialog":
			return { ...state, dialog: message.dialog, status: statusWithDialog(state.status, message.dialog) };
		case "subagents":
			return { ...state, subagents: message.subagents };
		case "queued":
			return { ...state, queued: message.queued };
		case "queue_restored": {
			// The queue came back as text, so the composer is the only place it can go:
			// the draft stays first and each restored entry gets its own paragraph.
			const restored = [...message.steering, ...message.followUp]
				.map((text) => text.trim())
				.filter((text) => text !== "");
			const entries = state.draft.trim() === "" ? restored : [state.draft, ...restored];
			return { ...state, draft: entries.join("\n\n") };
		}
		case "session":
			return { ...state, session: message.session, sessions: mergeSession(state.sessions, message.session) };
		case "ack":
			return message.status === "error" ? { ...state, error: message.error ?? "message rejected" } : state;
		case "error": {
			// Not running is a state, not a failure: show Resume, not an error banner.
			if (message.code !== "session_not_found") return { ...state, error: message.message };
			const stopped = (session: SessionSummary | null): SessionSummary | null =>
				session === null ? null : { ...session, running: false, status: "stopped" };
			return {
				...state,
				error: null,
				session: stopped(state.session),
				sessions: state.sessions.map((session) => (session.id === state.sessionId ? { ...session, running: false, status: "stopped" } : session)),
				status: { status: "stopped", isSettled: true, hasPendingAsyncWork: false },
			};
		}
	}
}

export function withConnection(state: AppState, connection: ConnectionState): AppState {
	// An open socket proves Burrow is up, whatever the last fetch said.
	return connection === "open" ? { ...state, connection, remoteOff: false } : { ...state, connection };
}

export function withDraft(state: AppState, draft: string): AppState {
	return { ...state, draft };
}

export function withWorkspaceFilter(state: AppState, workspaceFilter: string | null): AppState {
	return { ...state, workspaceFilter };
}

export function withRemoteOff(state: AppState, remoteOff: boolean): AppState {
	return { ...state, remoteOff, connection: remoteOff ? "closed" : state.connection };
}

/** Entering a session screen: the snapshot for it replaces whatever was there. */
export function openChat(state: AppState, sessionId: string): AppState {
	if (state.sessionId === sessionId && state.screen === "chat") return state;
	return {
		...state,
		screen: "chat",
		sessionId,
		session: state.sessions.find((session) => session.id === sessionId) ?? null,
		items: [],
		dialog: null,
		subagents: [],
		queued: { steering: [], followUp: [] },
		status: IDLE_STATUS,
		readOnly: false,
		error: null,
	};
}

export function showScreen(state: AppState, screen: Screen): AppState {
	return { ...state, screen };
}

export function showSessions(state: AppState): AppState {
	return {
		...state,
		screen: "sessions",
		sessionId: null,
		session: null,
		items: [],
		dialog: null,
		subagents: [],
		error: null,
	};
}

/** Which sheet is open is view state: opening one closes whatever was open. */
export function openSheet(state: AppState, sheet: AppState["sheet"]): AppState {
	return { ...state, sheet };
}

export function toggleTodos(state: AppState): AppState {
	return { ...state, todosOpen: !state.todosOpen };
}

export function toggleThinkingVisible(state: AppState): AppState {
	return { ...state, thinkingVisible: !state.thinkingVisible };
}

/** Expand all, collapse all, then back to letting every card decide for itself. */
export function toggleTools(state: AppState): AppState {
	if (state.toolsOpen === null) return { ...state, toolsOpen: true };
	return { ...state, toolsOpen: state.toolsOpen ? false : null };
}
