// WebSocket with reconnect and exactly-once resend. Nothing here touches the
// DOM beyond WebSocket. Every message stays in `pending` until the server acks
// it; after a reconnect the pending list is resent in order with the original
// clientIds, and the server answers `duplicate` for ids it already applied.

import type { ClientMessage, ServerMessage } from "../../shared/protocol";
import type { ConnectionState } from "./app-state";

/** A ClientMessage before the connection assigns its clientId. */
export type OutgoingMessage = ClientMessage extends infer M ? (M extends unknown ? Omit<M, "clientId"> : never) : never;

export interface ConnectionOptions {
	url: string;
	onMessage: (message: ServerMessage) => void;
	onState: (state: ConnectionState) => void;
}

export interface Connection {
	send(message: OutgoingMessage): void;
	close(): void;
	/** Messages sent but not yet acked. */
	pendingCount(): number;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];

export function createConnection(options: ConnectionOptions): Connection {
	let socket: WebSocket | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let attempt = 0;
	let closed = false;
	let pending: ClientMessage[] = [];

	function open(): void {
		if (closed) return;
		options.onState("connecting");
		const ws = new WebSocket(options.url);
		socket = ws;
		ws.onopen = () => {
			if (socket !== ws) return;
			attempt = 0;
			options.onState("open");
			for (const message of pending) ws.send(JSON.stringify(message));
		};
		ws.onmessage = (event) => {
			if (socket !== ws) return;
			let message: ServerMessage;
			try {
				message = JSON.parse(String(event.data)) as ServerMessage;
			} catch {
				return;
			}
			if (message.type === "ack") pending = pending.filter((item) => item.clientId !== message.clientId);
			options.onMessage(message);
		};
		// A failed connect fires error then close; reconnecting from close alone
		// keeps one retry timer per socket.
		ws.onclose = () => {
			if (socket !== ws) return;
			socket = null;
			options.onState("closed");
			if (closed) return;
			const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
			attempt++;
			timer = setTimeout(() => {
				timer = null;
				open();
			}, delay);
		};
	}

	open();

	return {
		send(message) {
			if (closed) return;
			const full = { ...message, clientId: crypto.randomUUID() } as ClientMessage;
			pending.push(full);
			if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(full));
		},
		close() {
			closed = true;
			clearTimeout(timer ?? undefined);
			timer = null;
			const ws = socket;
			socket = null;
			if (ws !== null) ws.close();
		},
		pendingCount() {
			return pending.length;
		},
	};
}
