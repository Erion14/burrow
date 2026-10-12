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

const CLIENT_TYPES = new Set(["prompt", "abort", "answer", "discard_dialog", "stop_session"]);

function parseClientMessage(raw: string | Buffer): ClientMessage | null {
	let value: unknown;
	try {
		value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.type !== "string" || !CLIENT_TYPES.has(record.type)) return null;
	if (typeof record.clientId !== "string" || record.clientId.length === 0) return null;
	return value as ClientMessage;
}

export function createHub(options: HubOptions): Hub {
	const { manager } = options;
	const authConfig = { ownerLogin: options.ownerLogin, origin: options.origin } as BurrowConfig;
	const sockets = new Set<ServerWebSocket<SocketData>>();
	let closed = false;

	function flush(ws: ServerWebSocket<SocketData>): void {
		const data = ws.data;
		clearTimeout(data.timer);
		data.timer = undefined;
		const queue = data.queue.splice(0);
		for (const message of queue) ws.send(JSON.stringify(message));
	}

	/** Queues a session message; adjacent-by-kind deltas for one item coalesce. */
	function enqueue(ws: ServerWebSocket<SocketData>, message: ServerMessage): void {
		const data = ws.data;
		if (message.type === "snapshot") {
			// A snapshot replaces whatever was pending.
			data.queue.length = 0;
			clearTimeout(data.timer);
			data.timer = undefined;
			ws.send(JSON.stringify(message));
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

	const unsubscribe = manager.subscribe((sessionId, message) => {
		for (const ws of sockets) {
			if (sessionId === null) {
				if (ws.data.sessionId === null) ws.send(JSON.stringify(message));
			} else if (ws.data.sessionId === sessionId) {
				enqueue(ws, message);
			}
		}
	});

	async function handleClientMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer): Promise<void> {
		const message = parseClientMessage(raw);
		if (message === null) {
			enqueue(ws, { type: "error", code: "bad_message", message: "expected a JSON message with a type and clientId" });
			return;
		}
		const sessionId = ws.data.sessionId;
		if (sessionId === null) {
			enqueue(ws, { type: "error", code: "no_session", message: "this socket is not attached to a session" });
			return;
		}
		if (ws.data.applied.has(message.clientId)) {
			enqueue(ws, { type: "ack", clientId: message.clientId, status: "duplicate" });
			return;
		}
		ws.data.applied.add(message.clientId);
		try {
			const delivery = await manager.deliver(sessionId, message);
			const ack: ServerMessage = { type: "ack", clientId: message.clientId, status: delivery.status };
			if (delivery.error !== undefined) ack.error = delivery.error;
			if (!closed) enqueue(ws, ack);
		} catch (err) {
			// Forget the id so the phone can resend after a failed attempt.
			ws.data.applied.delete(message.clientId);
			const text = err instanceof Error ? err.message : String(err);
			if (!closed) enqueue(ws, { type: "ack", clientId: message.clientId, status: "error", error: text });
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
			if (sessionId === null) return;
			const snapshot = manager.snapshot(sessionId);
			if (snapshot === null) {
				// Keep the socket open; it behaves as a list socket from here on.
				ws.data.sessionId = null;
				enqueue(ws, { type: "error", code: "session_not_found", message: `Unknown session: ${sessionId}` });
				return;
			}
			ws.send(JSON.stringify({ type: "snapshot", snapshot } satisfies ServerMessage));
		},
		message(ws, raw) {
			void handleClientMessage(ws, raw);
		},
		close(ws) {
			sockets.delete(ws);
			clearTimeout(ws.data.timer);
			ws.data.timer = undefined;
			ws.data.queue.length = 0;
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
			const listSockets = [...sockets].filter((ws) => ws.data.sessionId === null);
			if (listSockets.length === 0) return;
			const [sessions, repos] = await Promise.all([manager.list(), listRepos(options.repos ?? [])]);
			const payload = JSON.stringify({ type: "sessions", sessions, repos } satisfies ServerMessage);
			for (const ws of listSockets) if (sockets.has(ws)) ws.send(payload);
		},
		close() {
			closed = true;
			unsubscribe();
			for (const ws of [...sockets]) {
				clearTimeout(ws.data.timer);
				ws.data.timer = undefined;
				ws.close(1001, "server shutting down");
			}
			sockets.clear();
		},
	};
}
