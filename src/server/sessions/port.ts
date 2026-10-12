// The session manager keeps the omp processes and the per session state the
// phone sees. The HTTP and WebSocket layer codes against this port only.

import type { ClientMessage, ServerMessage } from "../../shared/protocol";
import type { SessionSnapshot, SessionSummary } from "../../shared/types";

export interface BurrowError {
	code: string;
	message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: BurrowError };

export interface Delivery {
	status: "ok" | "duplicate" | "error";
	error?: string;
}

export interface StartSessionInput {
	repoPath: string;
	/** Resume the session in this file instead of starting a fresh one. */
	sessionFile?: string;
}

export type StopReason = "handoff" | "request" | "idle" | "shutdown";

export interface SessionManagerPort {
	/** Running sessions plus recent session files whose header cwd is allowlisted. */
	list(): Promise<SessionSummary[]>;
	start(input: StartSessionInput): Promise<Result<SessionSummary>>;
	/** null when no such session is known. */
	snapshot(sessionId: string): SessionSnapshot | null;
	/** sessionId is null for messages about the list itself. Returns an unsubscribe function. */
	subscribe(listener: (sessionId: string | null, message: ServerMessage) => void): () => void;
	/** Applies one phone message; a repeated clientId is answered duplicate and applied once. */
	deliver(sessionId: string, message: ClientMessage): Promise<Delivery>;
	stop(sessionId: string, reason: StopReason): Promise<Result<null>>;
	/** Session ids Burrow currently runs a process for. */
	runningIds(): string[];
	shutdown(): Promise<void>;
}
