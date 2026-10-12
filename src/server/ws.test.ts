import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { FakeManager, makeSummary } from "../../test/fake-manager";
import type { ServerMessage } from "../shared/protocol";
import type { BurrowConfig } from "./config";
import { createHttpServer } from "./http";
import { createHub, type Hub, type SocketData } from "./ws";

const OWNER = "owner@example.com";
const ORIGIN = "https://burrow.tailnet.ts.net";

function makeConfig(): BurrowConfig {
	return {
		port: 0,
		wakePort: 0,
		ownerLogin: OWNER,
		origin: ORIGIN,
		repos: [],
		ntfyUrl: null,
		ompCommand: ["omp"],
		sessionsDir: "/nonexistent",
		configDir: "/nonexistent",
		webRoot: "/nonexistent",
		idleTimeoutMs: 1000,
	};
}

class Client {
	readonly messages: ServerMessage[] = [];
	closed = false;
	private waiters: (() => void)[] = [];

	constructor(readonly ws: WebSocket) {
		ws.onmessage = (event) => {
			this.messages.push(JSON.parse(String(event.data)) as ServerMessage);
			for (const wake of this.waiters.splice(0)) wake();
		};
		ws.onclose = () => {
			this.closed = true;
			for (const wake of this.waiters.splice(0)) wake();
		};
	}

	async waitFor(count: number, timeoutMs = 2000): Promise<ServerMessage[]> {
		const deadline = Date.now() + timeoutMs;
		while (this.messages.length < count) {
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`timed out with ${this.messages.length}/${count} messages`);
			await new Promise<void>((resolve) => {
				this.waiters.push(resolve);
				setTimeout(resolve, left);
			});
		}
		return this.messages;
	}

	send(message: unknown): void {
		this.ws.send(JSON.stringify(message));
	}
}

let manager: FakeManager;
let hub: Hub;
let server: Server<SocketData>;
let clients: Client[] = [];

function url(query = ""): string {
	return `ws://127.0.0.1:${server.port}/ws${query}`;
}

async function connect(
	query = "",
	headers: Record<string, string> = { "tailscale-user-login": OWNER, origin: ORIGIN },
): Promise<Client> {
	const ws = new WebSocket(url(query), { headers } as never);
	const client = new Client(ws);
	clients.push(client);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		const prior = ws.onclose;
		ws.onclose = (event) => {
			(prior as ((e: CloseEvent) => void) | null)?.(event);
			reject(new Error("closed before open"));
		};
	});
	return client;
}

beforeEach(() => {
	manager = new FakeManager();
	manager.addSession("s1");
	manager.addSession("s2");
	hub = createHub({ manager, origin: ORIGIN, ownerLogin: OWNER });
	server = createHttpServer({
		config: makeConfig(),
		manager,
		hub,
		diff: async () => {
			throw new Error("unused");
		},
	});
});

afterEach(() => {
	for (const client of clients) client.ws.close();
	clients = [];
	server.stop(true);
	hub.close();
});

describe("attach", () => {
	test("missing identity header is a 403 JSON response, not an upgrade", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ws`, {
			headers: { upgrade: "websocket", connection: "Upgrade", origin: ORIGIN },
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("forbidden_identity");
		expect(manager.listCalls + manager.snapshotCalls.length).toBe(0);
	});

	test("foreign Origin on the upgrade is a 403", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ws`, {
			headers: {
				"tailscale-user-login": OWNER,
				upgrade: "websocket",
				connection: "Upgrade",
				origin: "https://evil.example",
			},
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("forbidden_origin");
	});

	test("session socket receives the snapshot first", async () => {
		const client = await connect("?session=s1");
		const [first] = await client.waitFor(1);
		expect(first?.type).toBe("snapshot");
		if (first?.type === "snapshot") expect(first.snapshot.session.id).toBe("s1");
		expect(hub.attachedSessionIds()).toEqual(new Set(["s1"]));
		expect(hub.attachedCount()).toBe(1);
	});

	test("unknown session sends an error and keeps the socket open as a list socket", async () => {
		const client = await connect("?session=nope");
		const [first] = await client.waitFor(1);
		expect(first).toMatchObject({ type: "error", code: "session_not_found" });
		expect(client.closed).toBe(false);
		expect(hub.attachedSessionIds().size).toBe(0);
		manager.emit(null, { type: "sessions", sessions: [], repos: [] });
		const messages = await client.waitFor(2);
		expect(messages[1]?.type).toBe("sessions");
	});

	test("closing a socket releases the attached session", async () => {
		const client = await connect("?session=s1");
		await client.waitFor(1);
		client.ws.close();
		const deadline = Date.now() + 2000;
		while (hub.attachedCount() > 0 && Date.now() < deadline) await Bun.sleep(10);
		expect(hub.attachedCount()).toBe(0);
		expect(hub.attachedSessionIds().size).toBe(0);
	});
});

describe("fan out", () => {
	test("a session emit reaches only the sockets attached to that session", async () => {
		const a = await connect("?session=s1");
		const b = await connect("?session=s2");
		const list = await connect();
		await a.waitFor(1);
		await b.waitFor(1);
		manager.emit("s1", { type: "status", status: { status: "working", isSettled: false, hasPendingAsyncWork: false } });
		manager.emit(null, { type: "sessions", sessions: [makeSummary("s1")], repos: [] });
		await a.waitFor(2);
		await list.waitFor(1);
		await Bun.sleep(250);
		expect(a.messages.map((m) => m.type)).toEqual(["snapshot", "status"]);
		expect(b.messages.map((m) => m.type)).toEqual(["snapshot"]);
		expect(list.messages.map((m) => m.type)).toEqual(["sessions"]);
	});

	test("three deltas in one flush window arrive as one delta with concatenated text", async () => {
		const client = await connect("?session=s1");
		await client.waitFor(1);
		for (const text of ["a", "b", "c"]) manager.emit("s1", { type: "delta", itemId: "i1", text, thinking: "" });
		manager.emit("s1", { type: "delta", itemId: "i1", text: "", thinking: "t" });
		await client.waitFor(2);
		await Bun.sleep(250);
		expect(client.messages).toHaveLength(2);
		expect(client.messages[1]).toEqual({ type: "delta", itemId: "i1", text: "abc", thinking: "t" });
	});

	test("batching never reorders messages of different kinds", async () => {
		const client = await connect("?session=s1");
		await client.waitFor(1);
		manager.emit("s1", { type: "delta", itemId: "i1", text: "a", thinking: "" });
		manager.emit("s1", { type: "dialog", dialog: null });
		manager.emit("s1", { type: "delta", itemId: "i1", text: "b", thinking: "" });
		manager.emit("s1", { type: "delta", itemId: "i2", text: "x", thinking: "" });
		manager.emit("s1", { type: "delta", itemId: "i1", text: "c", thinking: "" });
		await client.waitFor(5);
		await Bun.sleep(250);
		expect(client.messages.slice(1)).toEqual([
			{ type: "delta", itemId: "i1", text: "a", thinking: "" },
			{ type: "dialog", dialog: null },
			{ type: "delta", itemId: "i1", text: "bc", thinking: "" },
			{ type: "delta", itemId: "i2", text: "x", thinking: "" },
		]);
	});

	test("a snapshot bypasses batching", async () => {
		const client = await connect("?session=s1");
		await client.waitFor(1);
		manager.emit("s1", { type: "delta", itemId: "i1", text: "a", thinking: "" });
		const snapshot = manager.snapshot("s1");
		if (snapshot === null) throw new Error("no snapshot");
		manager.emit("s1", { type: "snapshot", snapshot });
		const start = Date.now();
		await client.waitFor(2);
		expect(Date.now() - start).toBeLessThan(80);
		expect(client.messages[1]?.type).toBe("snapshot");
	});
});

describe("client messages", () => {
	test("two messages with the same clientId produce exactly one deliver", async () => {
		const client = await connect("?session=s1");
		await client.waitFor(1);
		manager.deliverDelayMs = 30;
		client.send({ type: "prompt", clientId: "c1", text: "hi" });
		client.send({ type: "prompt", clientId: "c1", text: "hi" });
		await client.waitFor(3);
		await Bun.sleep(100);
		expect(manager.deliversFor("c1")).toHaveLength(1);
		expect(manager.deliverCalls[0]?.sessionId).toBe("s1");
		const acks = client.messages.filter((m) => m.type === "ack");
		expect(acks.map((a) => (a.type === "ack" ? a.status : ""))).toEqual(["duplicate", "ok"]);
	});

	test("a failed delivery is answered with an error ack", async () => {
		manager.deliverResult = { status: "error", error: "boom" };
		const client = await connect("?session=s1");
		await client.waitFor(1);
		client.send({ type: "abort", clientId: "c2" });
		const messages = await client.waitFor(2);
		expect(messages[1]).toEqual({ type: "ack", clientId: "c2", status: "error", error: "boom" });
	});

	test("malformed input gets an error message and delivers nothing", async () => {
		const client = await connect("?session=s1");
		await client.waitFor(1);
		client.ws.send("not json");
		client.send({ type: "prompt", text: "no id" });
		await client.waitFor(3);
		expect(client.messages[1]).toMatchObject({ type: "error", code: "bad_message" });
		expect(client.messages[2]).toMatchObject({ type: "error", code: "bad_message" });
		expect(manager.deliverCalls).toHaveLength(0);
	});
});

describe("broadcastList and close", () => {
	test("broadcastList sends the current sessions to list sockets only", async () => {
		const list = await connect();
		const session = await connect("?session=s1");
		await session.waitFor(1);
		await hub.broadcastList();
		await list.waitFor(1);
		expect(list.messages[0]).toMatchObject({ type: "sessions" });
		await Bun.sleep(150);
		expect(session.messages).toHaveLength(1);
	});

	test("close() closes sockets and stops listening to the manager", async () => {
		const client = await connect("?session=s1");
		await client.waitFor(1);
		expect(manager.listeners.size).toBe(1);
		hub.close();
		expect(manager.listeners.size).toBe(0);
		const deadline = Date.now() + 2000;
		while (!client.closed && Date.now() < deadline) await Bun.sleep(10);
		expect(client.closed).toBe(true);
		expect(hub.attachedCount()).toBe(0);
	});
});
