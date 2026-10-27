// The connection hub: one WebSocket per phone screen. "/ws" streams the
// session list, "/ws?session=<id>" streams one session (snapshot first, then
// live messages batched on a short flush timer).

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { ClientMessage, ServerMessage } from "../shared/protocol";
import { authorizeRequest, denialResponse } from "./auth";
import type { BurrowConfig } from "./config";
import { listRepos } from "./repos/allowlist";
import type { SessionManagerPort } from "./sessions/port";

export const FLUSH_INTERVAL_MS = 100;

/**
 * A socket with more than this many bytes waiting to go out belongs to a phone
 * that stopped reading. Bun keeps buffering up to its own 16 MB limit and then
 * drops every send without closing, so the hub gives up well before that.
 */
export const SEND_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;

/** 1013 "try again later": the phone reconnects and the attach sends a fresh snapshot. */
const STALLED_CLOSE_CODE = 1013;

export interface HubOptions {
	manager: SessionManagerPort;
	origin: string;
	ownerLogin: string;
	/** Raw allowlist lines; used for the repos part of a `sessions` message. */
	repos?: string[];
}

export interface SocketData {
	/** null for a list socket. */
	sessionId: string | null;
	/** Client ids already applied on this socket. */
	applied: Set<string>;
	queue: ServerMessage[];
	timer: NodeJS.Timeout | undefined;
}

export interface Hub {
	/** Performs the upgrade; denials and bad upgrades come back as JSON error responses. */
	attach(req: Request, server: Server<SocketData>): Response;
	/** Session ids with at least one attached socket. */
	attachedSessionIds(): Set<string>;
	/** Number of open sockets, list sockets included. */
	attachedCount(): number;
	/** Sends the current session list to every list socket. */
	broadcastList(): Promise<void>;
	close(): void;
	/** Pass to Bun.serve as `websocket`. */
	readonly websocket: WebSocketHandler<SocketData>;
}

const CLIENT_TYPES: Record<string, true> = {
	prompt: true,
	abort: true,
	answer: true,
	discard_dialog: true,
	stop_session: true,
	list_models: true,
	refresh_state: true,
	set_model: true,
	cycle_model: true,
	set_thinking: true,
	cycle_thinking: true,
	compact: true,
	remove_queued: true,
	promote_queued: true,
	restore_queue: true,
	cancel_subagent: true,
	steer_subagent: true,
	rename_session: true,
	goal_action: true,
	bash: true,
};

/** A rejected message still names its clientId when it had one, so it can be acked. */
type ParsedClientMessage = { ok: true; message: ClientMessage } | { ok: false; clientId: string | null };

function parseClientMessage(raw: string | Buffer): ParsedClientMessage {
	let value: unknown;
	try {
		value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
	} catch {
		return { ok: false, clientId: null };
	}
	if (typeof value !== "object" || value === null) return { ok: false, clientId: null };
	const record = value as Record<string, unknown>;
	const clientId = typeof record.clientId === "string" && record.clientId.length > 0 ? record.clientId : null;
	if (clientId === null || typeof record.type !== "string" || !Object.hasOwn(CLIENT_TYPES, record.type)) {
		return { ok: false, clientId };
	}
	return { ok: true, message: value as ClientMessage };
}

export function createHub(options: HubOptions): Hub {
	const { manager } = options;
	const authConfig = { ownerLogin: options.ownerLogin, origin: options.origin } as BurrowConfig;
	const sockets = new Set<ServerWebSocket<SocketData>>();
	let closed = false;
	/** Bumped whenever list sockets are sent a `sessions` message. */
	let listEpoch = 0;

	function forget(ws: ServerWebSocket<SocketData>): void {
		sockets.delete(ws);
		clearTimeout(ws.data.timer);
		ws.data.timer = undefined;
		ws.data.queue.length = 0;
	}

	/**
	 * Sends one payload; false when the socket is gone or was just closed as
	 * stalled. A dropped send (0) or a runaway buffer means the phone already
	 * missed or will miss messages, so the socket is closed instead of letting
	 * the transcript grow holes.
	 */
	function send(ws: ServerWebSocket<SocketData>, payload: string): boolean {
		if (!sockets.has(ws)) return false;
		const result = ws.send(payload);
		if (result !== 0 && ws.getBufferedAmount() <= SEND_BUFFER_LIMIT_BYTES) return true;
		forget(ws);
		ws.close(STALLED_CLOSE_CODE, "phone fell behind; reconnect for a fresh snapshot");
		return false;
	}

	function flush(ws: ServerWebSocket<SocketData>): void {
		const data = ws.data;
		clearTimeout(data.timer);
		data.timer = undefined;
		const queue = data.queue.splice(0);
		for (const message of queue) if (!send(ws, JSON.stringify(message))) return;
	}

	/** Queues a session message; adjacent-by-kind deltas for one item coalesce. */
	function enqueue(ws: ServerWebSocket<SocketData>, message: ServerMessage): void {
		if (!sockets.has(ws)) return;
		const data = ws.data;
		if (message.type === "snapshot") {
			// A snapshot replaces whatever was pending.
			data.queue.length = 0;
			clearTimeout(data.timer);
			data.timer = undefined;
			send(ws, JSON.stringify(message));
			return;
		}
		if (message.type === "delta") {
			// Merge into the latest delta for this item, but only when nothing but
			// deltas follows it: merging across another kind would reorder.
			for (let i = data.queue.length - 1; i >= 0; i--) {
				const queued = data.queue[i];
				if (queued === undefined || queued.type !== "delta") break;
				if (queued.itemId === message.itemId) {
					queued.text += message.text;
					queued.thinking += message.thinking;
					return;
				}
			}
			data.queue.push({ ...message });
		} else {
			data.queue.push(message);
		}
		if (data.timer === undefined) data.timer = setTimeout(() => flush(ws), FLUSH_INTERVAL_MS);
	}

	async function sessionsPayload(): Promise<string> {
		const [sessions, repos] = await Promise.all([manager.list(), listRepos(options.repos ?? [])]);
		return JSON.stringify({ type: "sessions", sessions, repos } satisfies ServerMessage);
	}

	/** Gives a list socket the current list, so a reconnect never shows a stale one. */
	async function sendListOnAttach(ws: ServerWebSocket<SocketData>): Promise<void> {
		const epoch = listEpoch;
		let payload: string;
		try {
			payload = await sessionsPayload();
		} catch {
			// The next broadcast reaches this socket anyway.
			return;
		}
		// A broadcast that went out meanwhile already reached this socket and may be newer.
		if (epoch === listEpoch && ws.data.sessionId === null) send(ws, payload);
	}

	const unsubscribe = manager.subscribe((sessionId, message) => {
		if (sessionId === null && message.type === "sessions") listEpoch++;
		for (const ws of [...sockets]) {
			if (sessionId === null) {
				if (ws.data.sessionId === null) send(ws, JSON.stringify(message));
			} else if (ws.data.sessionId === sessionId) {
				enqueue(ws, message);
			}
		}
	});

	async function handleClientMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer): Promise<void> {
		const parsed = parseClientMessage(raw);
		const sessionId = ws.data.sessionId;
		// A message that cannot be applied is still acked when it has an id, so the
		// phone drops it from its resend queue; the id is never recorded as applied.
		if (!parsed.ok || sessionId === null) {
			const clientId = parsed.ok ? parsed.message.clientId : parsed.clientId;
			const [code, text] = parsed.ok
				? (["no_session", "this socket is not attached to a session"] as const)
				: (["bad_message", "expected a JSON message with a known type and a clientId"] as const);
			if (clientId === null) enqueue(ws, { type: "error", code, message: text });
			else enqueue(ws, { type: "ack", clientId, status: "error", error: text });
			return;
		}
		const message = parsed.message;
		if (ws.data.applied.has(message.clientId)) {
			enqueue(ws, { type: "ack", clientId: message.clientId, status: "duplicate" });
			return;
		}
		ws.data.applied.add(message.clientId);
		try {
			const delivery = await manager.deliver(sessionId, message);
			const ack: ServerMessage = { type: "ack", clientId: message.clientId, status: delivery.status };
			if (delivery.error !== undefined) ack.error = delivery.error;
			enqueue(ws, ack);
		} catch (err) {
			// Forget the id so the phone can resend after a failed attempt.
			ws.data.applied.delete(message.clientId);
			const text = err instanceof Error ? err.message : String(err);
			enqueue(ws, { type: "ack", clientId: message.clientId, status: "error", error: text });
		}
	}

	const websocket: WebSocketHandler<SocketData> = {
		open(ws) {
			if (closed) {
				ws.close(1001, "server shutting down");
				return;
			}
			sockets.add(ws);
			const sessionId = ws.data.sessionId;
			if (sessionId === null) {
				void sendListOnAttach(ws);
				return;
			}
			const snapshot = manager.snapshot(sessionId);
			if (snapshot === null) {
				// Keep the socket open; it behaves as a list socket from here on.
				ws.data.sessionId = null;
				const error: ServerMessage = { type: "error", code: "session_not_found", message: `Unknown session: ${sessionId}` };
				if (send(ws, JSON.stringify(error))) void sendListOnAttach(ws);
				return;
			}
			send(ws, JSON.stringify({ type: "snapshot", snapshot } satisfies ServerMessage));
		},
		message(ws, raw) {
			void handleClientMessage(ws, raw);
		},
		close(ws) {
			forget(ws);
		},
	};

	return {
		websocket,
		attach(req, server) {
			const denial = authorizeRequest(req, authConfig, { requireOrigin: true });
			if (denial !== null) return denialResponse(denial);
			const sessionId = new URL(req.url).searchParams.get("session");
			const data: SocketData = { sessionId: sessionId === "" ? null : sessionId, applied: new Set(), queue: [], timer: undefined };
			if (server.upgrade(req, { data })) {
				// Bun takes over the connection after a successful upgrade.
				return undefined as unknown as Response;
			}
			return Response.json(
				{ error: { code: "upgrade_failed", message: "expected a WebSocket upgrade request" } },
				{ status: 400 },
			);
		},
		attachedSessionIds() {
			const ids = new Set<string>();
			for (const ws of sockets) if (ws.data.sessionId !== null) ids.add(ws.data.sessionId);
			return ids;
		},
		attachedCount() {
			return sockets.size;
		},
		async broadcastList() {
			if (![...sockets].some((ws) => ws.data.sessionId === null)) return;
			const payload = await sessionsPayload();
			listEpoch++;
			for (const ws of [...sockets]) if (ws.data.sessionId === null) send(ws, payload);
		},
		close() {
			closed = true;
			unsubscribe();
			for (const ws of [...sockets]) {
				forget(ws);
				ws.close(1001, "server shutting down");
			}
			sockets.clear();
		},
	};
}
