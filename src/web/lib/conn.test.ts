import { afterEach, describe, expect, test } from "bun:test";
import type { ClientMessage, ServerMessage } from "../../shared/protocol";
import type { ConnectionState } from "./app-state";
import { createConnection } from "./conn";

type Sock = Bun.ServerWebSocket<undefined>;

interface Harness {
	received: ClientMessage[];
	sockets: Sock[];
	opens: number;
	server: Bun.Server<undefined>;
	ack: boolean;
}

const servers: Bun.Server<undefined>[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
	for (const close of closers.splice(0)) close();
	for (const server of servers.splice(0)) server.stop(true);
});

function startServer(): Harness {
	const harness = { received: [], sockets: [], opens: 0, ack: false } as unknown as Harness;
	harness.server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, server) {
			if (server.upgrade(req)) return undefined;
			return new Response("no", { status: 400 });
		},
		websocket: {
			open(ws) {
				harness.opens++;
				harness.sockets.push(ws);
			},
			message(ws, raw) {
				const message = JSON.parse(String(raw)) as ClientMessage;
				harness.received.push(message);
				if (harness.ack) ws.send(JSON.stringify({ type: "ack", clientId: message.clientId, status: "ok" }));
			},
		},
	});
	servers.push(harness.server);
	return harness;
}

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
		await Bun.sleep(10);
	}
}

function connect(harness: Harness) {
	const states: ConnectionState[] = [];
	const messages: ServerMessage[] = [];
	const conn = createConnection({
		url: `ws://127.0.0.1:${harness.server.port}/ws`,
		onMessage: (message) => messages.push(message),
		onState: (state) => states.push(state),
	});
	closers.push(() => conn.close());
	return { conn, states, messages };
}

// Reconnect backoff is real wall-clock behavior (first retry after 1s), so these
// tests wait on real time against a real server instead of fake timers.
describe("createConnection", () => {
	test("resends a pending message with the same clientId after a reconnect", async () => {
		const harness = startServer();
		const { conn } = connect(harness);
		await until(() => harness.sockets.length === 1);

		conn.send({ type: "prompt", text: "hello" });
		await until(() => harness.received.length === 1);
		const first = harness.received[0]!;

		harness.sockets[0]!.close();
		await until(() => harness.sockets.length === 2);
		await until(() => harness.received.length === 2);

		expect(harness.received[1]).toEqual(first);
		expect(conn.pendingCount()).toBe(1);
	});

	test("a message sent while the socket is down is delivered after reconnect, in order", async () => {
		const harness = startServer();
		const { conn } = connect(harness);
		await until(() => harness.sockets.length === 1);
		harness.sockets[0]!.close();
		await until(() => conn.pendingCount() === 0 && harness.sockets[0]!.readyState !== 1);

		conn.send({ type: "prompt", text: "one" });
		conn.send({ type: "prompt", text: "two" });
		await until(() => harness.received.length === 2);

		expect(harness.received.map((m) => (m.type === "prompt" ? m.text : ""))).toEqual(["one", "two"]);
	});

	test("an ack removes the message from the pending list and it is not resent", async () => {
		const harness = startServer();
		harness.ack = true;
		const { conn } = connect(harness);
		await until(() => harness.sockets.length === 1);

		conn.send({ type: "abort" });
		await until(() => conn.pendingCount() === 0);
		expect(harness.received).toHaveLength(1);

		harness.sockets[0]!.close();
		await until(() => harness.sockets.length === 2);
		await Bun.sleep(100);
		expect(harness.received).toHaveLength(1);
	});

	test("every send gets its own clientId", async () => {
		const harness = startServer();
		const { conn } = connect(harness);
		await until(() => harness.sockets.length === 1);

		conn.send({ type: "abort" });
		conn.send({ type: "abort" });
		conn.send({ type: "prompt", text: "x" });
		await until(() => harness.received.length === 3);

		const ids = harness.received.map((m) => m.clientId);
		expect(new Set(ids).size).toBe(3);
		for (const id of ids) expect(id.length).toBeGreaterThan(8);
	});

	test("does not reconnect while the socket is open", async () => {
		const harness = startServer();
		const { states } = connect(harness);
		await until(() => harness.sockets.length === 1);
		await Bun.sleep(1500);

		expect(harness.opens).toBe(1);
		expect(states).toEqual(["connecting", "open"]);
	});

	test("close() stops reconnecting", async () => {
		const harness = startServer();
		const { conn } = connect(harness);
		await until(() => harness.sockets.length === 1);
		conn.close();
		await Bun.sleep(1500);

		expect(harness.opens).toBe(1);
	});

	test("forwards server messages to onMessage", async () => {
		const harness = startServer();
		const { messages } = connect(harness);
		await until(() => harness.sockets.length === 1);
		harness.sockets[0]!.send(JSON.stringify({ type: "error", code: "x", message: "boom" }));
		await until(() => messages.length === 1);

		expect(messages[0]).toEqual({ type: "error", code: "x", message: "boom" });
	});
});
