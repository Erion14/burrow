// The phone app's state. Pure functions only: the connection module feeds
// ServerMessages in, screens render the result. Keeping this out of components
// is what makes reconnect and resend behavior testable with bun test.

import type { DialogAnswer, ServerMessage } from "../../shared/protocol";
import type {
	DialogView,
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
	handOffToLaptop(): void;
	openSession(sessionId: string): void;
	newSession(repoPath: string, sessionFile?: string): Promise<void>;
	showSessions(): void;
	selectWorkspace(repo: string | null): void;
	showScreen(screen: Screen): void;
	turnRemoteOn(): Promise<void>;
	turnRemoteOff(): Promise<void>;
	refreshSessions(): void;
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
		sessions: [],
		repos: [],
		workspaceFilter: null,
		draft: "",
		error: null,
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
			};
		}
		case "sessions":
			return { ...state, remoteOff: false, sessions: message.sessions, repos: message.repos };
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
