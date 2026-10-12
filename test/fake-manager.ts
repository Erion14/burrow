// A scriptable SessionManagerPort for HTTP and WebSocket tests. Every call is
// recorded; results are canned and can be changed per test.

import type { ClientMessage, ServerMessage } from "../src/shared/protocol";
import type { SessionSnapshot, SessionSummary } from "../src/shared/types";
import type { Delivery, Result, SessionManagerPort, StartSessionInput, StopReason } from "../src/server/sessions/port";

export type Listener = (sessionId: string | null, message: ServerMessage) => void;

export interface DeliverCall {
	sessionId: string;
	message: ClientMessage;
}

export function makeSummary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		repo: "/tmp/repo",
		repoName: "repo",
		title: `session ${id}`,
		status: "idle",
		running: true,
		openAtLaptop: false,
		sessionFile: null,
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

export function makeSnapshot(id: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
	return {
		session: makeSummary(id),
		items: [],
		dialog: null,
		subagents: [],
		queued: { steering: [], followUp: [] },
		status: { status: "idle", isSettled: true, hasPendingAsyncWork: false },
		truncated: false,
		...overrides,
	};
}

export class FakeManager implements SessionManagerPort {
	sessions: SessionSummary[] = [];
	snapshots = new Map<string, SessionSnapshot>();
	listeners = new Set<Listener>();

	listCalls = 0;
	startCalls: StartSessionInput[] = [];
	stopCalls: { sessionId: string; reason: StopReason }[] = [];
	deliverCalls: DeliverCall[] = [];
	snapshotCalls: string[] = [];
	shutdownCalls = 0;

	/** Result of start(); a function can compute it from the input. */
	startResult: Result<SessionSummary> | ((input: StartSessionInput) => Result<SessionSummary>) = {
		ok: true,
		value: makeSummary("started"),
	};
	/** Result of deliver(); a function can compute it from the call. */
	deliverResult: Delivery | ((sessionId: string, message: ClientMessage) => Delivery) = { status: "ok" };
	/** Delays deliver() so tests can overlap two sends of one id. */
	deliverDelayMs = 0;
	stopResult: Result<null> | ((sessionId: string) => Result<null>) = { ok: true, value: null };

	/** Registers a session so list() and snapshot() know it. */
	addSession(id: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
		const snapshot = makeSnapshot(id, overrides);
		this.snapshots.set(id, snapshot);
		this.sessions.push(snapshot.session);
		return snapshot;
	}

	/** Pushes a message to every subscriber, as the real manager does on a change. */
	emit(sessionId: string | null, message: ServerMessage): void {
		for (const listener of [...this.listeners]) listener(sessionId, message);
	}

	/** Calls to deliver() carrying this client id. */
	deliversFor(clientId: string): DeliverCall[] {
		return this.deliverCalls.filter((call) => call.message.clientId === clientId);
	}

	async list(): Promise<SessionSummary[]> {
		this.listCalls++;
		return this.sessions;
	}

	async start(input: StartSessionInput): Promise<Result<SessionSummary>> {
		this.startCalls.push(input);
		return typeof this.startResult === "function" ? this.startResult(input) : this.startResult;
	}

	snapshot(sessionId: string): SessionSnapshot | null {
		this.snapshotCalls.push(sessionId);
		return this.snapshots.get(sessionId) ?? null;
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async deliver(sessionId: string, message: ClientMessage): Promise<Delivery> {
		this.deliverCalls.push({ sessionId, message });
		if (this.deliverDelayMs > 0) await Bun.sleep(this.deliverDelayMs);
		return typeof this.deliverResult === "function" ? this.deliverResult(sessionId, message) : this.deliverResult;
	}

	async stop(sessionId: string, reason: StopReason): Promise<Result<null>> {
		this.stopCalls.push({ sessionId, reason });
		return typeof this.stopResult === "function" ? this.stopResult(sessionId) : this.stopResult;
	}

	runningIds(): string[] {
		return this.sessions.filter((s) => s.running).map((s) => s.id);
	}

	async shutdown(): Promise<void> {
		this.shutdownCalls++;
	}
}
