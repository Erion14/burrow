// Drives the real composition root (`bun src/server/main.ts`) as a subprocess
// against a real temp git repo, session folder and ntfy stand-in. The fake omp
// is the only faked port.

import type { Server } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { BootstrapResponse, ClientMessage, ServerMessage } from "../src/shared/protocol";
import type { SessionSummary } from "../src/shared/types";

const ROOT = join(import.meta.dir, "..");
const OWNER = "owner@example.com";
const ORIGIN = "https://burrow.example.ts.net";
const SESSION_ID = "sess-e2e";
const IDLE_TIMEOUT_MS = 3000;
const SCRIPTED_TEXT = "Hello, from the fake";
const SECRET_NOTIFY = "TOPSECRET-notify-text";

const SCRIPT = [
	{ frame: { type: "agent_start" } },
	{ frame: { type: "message_start", messageId: "m1", message: { role: "assistant", content: [] } } },
	{
		delayMs: 150,
		frame: { type: "message_update", messageId: "m1", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello, " } },
	},
	{
		delayMs: 150,
		frame: { type: "message_update", messageId: "m1", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "from " } },
	},
	{
		delayMs: 150,
		frame: { type: "message_update", messageId: "m1", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "the fake" } },
	},
	{
		delayMs: 150,
		frame: { type: "message_end", messageId: "m1", message: { role: "assistant", content: [{ type: "text", text: SCRIPTED_TEXT }] } },
	},
	{ frame: { type: "extension_ui_request", id: "n1", method: "notify", message: SECRET_NOTIFY } },
	{
		frame: { type: "extension_ui_request", id: "dlg-1", method: "select", title: "Pick one", options: ["alpha", "beta"] },
	},
	{ frame: { type: "agent_end", yielded: true, awaitingAsyncWork: true } },
	{ frame: { type: "agent_start" } },
	{ frame: { type: "agent_end", yielded: true, awaitingAsyncWork: true } },
	{ delayMs: 200, frame: { type: "session_settled" } },
];

interface Hit {
	body: string;
	title: string | null;
	click: string | null;
}

interface Env {
	dir: string;
	repo: string;
	sessionsDir: string;
	sessionFile: string;
	ompLog: string;
}

let env: Env;
let ntfy: Server<undefined>;
const hits: Hit[] = [];
let server: Bun.Subprocess<"ignore", "pipe", "pipe">;
let serverOut = "";
let serverErr = "";
let base = "";
let serverExited: Promise<number> | null = null;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(what: string, probe: () => T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\nserver stdout:\n${serverOut}\nserver stderr:\n${serverErr}`);
		await sleep(25);
	}
}

function run(cmd: string[], cwd?: string): void {
	const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${proc.stderr.toString()}`);
}

/** Pids of fake omp processes of this run; the log path is unique per run. */
function fakePids(): number[] {
	const proc = Bun.spawnSync(["pgrep", "-f", `fake-omp.ts --log ${env.ompLog}`], { stdout: "pipe", stderr: "pipe" });
	return proc.stdout
		.toString()
		.split("\n")
		.filter((line) => /^\d+$/.test(line))
		.map(Number);
}

function logLines(): Record<string, unknown>[] {
	if (!existsSync(env.ompLog)) return [];
	return readFileSync(env.ompLog, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
	return { "Tailscale-User-Login": OWNER, ...extra };
}

/** Bun's WebSocket takes a headers object on the upgrade; the DOM lib types do not know that. */
const BunWebSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;

async function api(path: string, init: RequestInit = {}, withIdentity = true): Promise<Response> {
	// The Origin is required on state-changing requests; harmless on GET.
	return fetch(`${base}${path}`, {
		...init,
		headers: { ...(withIdentity ? headers({ Origin: ORIGIN }) : {}), ...(init.headers as Record<string, string> | undefined) },
	});
}

class Client {
	readonly messages: ServerMessage[] = [];
	private constructor(readonly ws: WebSocket) {}

	static async open(path: string, extra: Record<string, string> = headers({ Origin: ORIGIN })): Promise<Client | null> {
		const ws = new BunWebSocket(`${base.replace("http", "ws")}${path}`, { headers: extra });
		const client = new Client(ws);
		ws.addEventListener("message", (event) => client.messages.push(JSON.parse(String(event.data)) as ServerMessage));
		const opened = await new Promise<boolean>((resolve) => {
			ws.addEventListener("open", () => resolve(true));
			ws.addEventListener("error", () => resolve(false));
			ws.addEventListener("close", () => resolve(false));
		});
		return opened ? client : null;
	}

	send(message: ClientMessage): void {
		this.ws.send(JSON.stringify(message));
	}

	waitFor<T extends ServerMessage>(what: string, pick: (message: ServerMessage) => T | null | false, timeoutMs = 10_000): Promise<T> {
		return until(what, () => {
			for (const message of this.messages) {
				const found = pick(message);
				if (found) return found;
			}
			return null;
		}, timeoutMs);
	}

	ack(clientId: string): Promise<Extract<ServerMessage, { type: "ack" }>> {
		return this.waitFor(`ack ${clientId}`, (m) => (m.type === "ack" && m.clientId === clientId ? m : false));
	}

	close(): void {
		this.ws.close();
	}
}

async function readStream(stream: ReadableStream<Uint8Array>, sink: (text: string) => void): Promise<void> {
	const decoder = new TextDecoder();
	for await (const chunk of stream) sink(decoder.decode(chunk, { stream: true }));
}

beforeAll(async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "burrow-e2e-")));
	const repo = join(dir, "work-repo");
	const configDir = join(dir, "config");
	const sessionsDir = join(dir, "sessions");
	const sessionFile = join(sessionsDir, "proj", `${SESSION_ID}.jsonl`);
	const ompLog = join(dir, "omp.log");
	env = { dir, repo, sessionsDir, sessionFile, ompLog };

	mkdirSync(repo);
	run(["git", "init", "-q"], repo);
	writeFileSync(join(repo, "README.md"), "hello\n");
	run(["git", "add", "."], repo);
	run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"], repo);

	mkdirSync(configDir);
	mkdirSync(join(sessionsDir, "proj"), { recursive: true });
	// The fake never writes a session file, so the test provides the header omp would.
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", id: SESSION_ID, cwd: repo })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "scripted prompt" } })}\n`,
	);
	writeFileSync(join(configDir, "repos"), `${repo}\n`);
	const scriptFile = join(dir, "script.json");
	writeFileSync(scriptFile, JSON.stringify(SCRIPT));

	ntfy = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			hits.push({ body: await req.text(), title: req.headers.get("title"), click: req.headers.get("click") });
			return new Response("ok");
		},
	});
	const ntfyFile = join(dir, "ntfy");
	writeFileSync(ntfyFile, `http://127.0.0.1:${ntfy.port}/topic\n`);

	const fakeCommand = [process.execPath, join(ROOT, "test/fake-omp.ts"), "--log", ompLog, "--script", scriptFile, "--session-id", SESSION_ID, "--session-file", sessionFile];
	server = Bun.spawn([process.execPath, "src/server/main.ts"], {
		cwd: ROOT,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			BURROW_PORT: "0",
			BURROW_OWNER_LOGIN: OWNER,
			BURROW_ORIGIN: ORIGIN,
			BURROW_CONFIG_DIR: configDir,
			BURROW_REPOS_FILE: join(configDir, "repos"),
			BURROW_NTFY_FILE: ntfyFile,
			BURROW_OMP_COMMAND: fakeCommand.join(" "),
			BURROW_SESSIONS_DIR: sessionsDir,
			BURROW_IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS),
			BURROW_WEB_ROOT: join(ROOT, "dist/web"),
		},
	});
	serverExited = server.exited;
	void readStream(server.stdout, (text) => {
		serverOut += text;
	});
	void readStream(server.stderr, (text) => {
		serverErr += text;
	});

	const port = await until("the listening line", () => {
		const match = /burrow listening on http:\/\/127\.0\.0\.1:(\d+) /.exec(serverOut);
		return match ? Number(match[1]) : null;
	}, 15_000);
	base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	// Fallbacks so nothing outlives the file, even when a test failed.
	if (server && server.exitCode === null) {
		server.kill("SIGKILL");
		await Promise.race([serverExited, sleep(3000)]);
	}
	if (env) {
		for (const pid of fakePids()) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}
	ntfy?.stop(true);
	if (env) rmSync(env.dir, { recursive: true, force: true });
});

describe("burrow end to end", () => {
	let session: SessionSummary;
	let phone: Client;

	test("bootstrap returns the allowlisted repo", async () => {
		const res = await api("/api/bootstrap");
		expect(res.status).toBe(200);
		const body = (await res.json()) as BootstrapResponse;
		expect(body.repos).toEqual([{ path: env.repo, name: basename(env.repo) }]);
		expect(body.sessions.some((s) => s.running)).toBe(false);
	});

	test("a request without the identity header, or a foreign upgrade Origin, is refused and starts no process", async () => {
		const noIdentity = await api("/api/sessions", { method: "POST", body: JSON.stringify({ repoPath: env.repo }) }, false);
		expect(noIdentity.status).toBe(403);
		const wrongIdentity = await api("/api/bootstrap", { headers: { "Tailscale-User-Login": "intruder@example.com" } }, false);
		expect(wrongIdentity.status).toBe(403);

		expect(await Client.open("/ws", headers({ Origin: "https://evil.example.com" }))).toBeNull();
		expect(await Client.open("/ws", { Origin: ORIGIN })).toBeNull();
		expect(await Client.open("/ws", headers())).toBeNull();

		await sleep(300);
		expect(fakePids()).toEqual([]);
		expect(existsSync(env.ompLog)).toBe(false);
		const listed = (await (await api("/api/bootstrap")).json()) as BootstrapResponse;
		expect(listed.sessions.some((s) => s.running)).toBe(false);
	});

	test("starting a session runs the setup commands in order", async () => {
		const res = await api("/api/sessions", { method: "POST", body: JSON.stringify({ repoPath: env.repo }) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { session: SessionSummary };
		session = body.session;
		expect(session.id).toBe(SESSION_ID);
		expect(session.repo).toBe(env.repo);
		expect(session.running).toBe(true);
		expect(fakePids()).toHaveLength(1);

		const setup = logLines().filter((c) => ["set_event_filter", "set_ask_dialog", "set_subagent_subscription"].includes(String(c.type)));
		expect(setup.map((c) => c.type)).toEqual(["set_event_filter", "set_ask_dialog", "set_subagent_subscription"]);
		expect(setup[0]).toMatchObject({ messageUpdates: "delta" });
		expect(setup[1]).toMatchObject({ enabled: true });
		expect(setup[2]).toMatchObject({ level: "progress" });
		const types = logLines().map((c) => c.type);
		expect(types.indexOf("negotiate_protocol")).toBeLessThan(types.indexOf("set_event_filter"));
	});

	test("the session socket sends a snapshot first, then the scripted turn as item and delta messages", async () => {
		const opened = await Client.open(`/ws?session=${SESSION_ID}`);
		if (opened === null) throw new Error("session socket refused");
		phone = opened;
		const first = await phone.waitFor("first message", () => phone.messages[0] ?? null);
		expect(first.type).toBe("snapshot");

		phone.send({ type: "prompt", clientId: "c1", text: "do the thing" });
		expect((await phone.ack("c1")).status).toBe("ok");

		await phone.waitFor("final item_update", (m) => (m.type === "item_update" && m.item.id === "m1" && m.item.text === SCRIPTED_TEXT ? m : false));
		const relevant = phone.messages.filter((m) => (m.type === "item" || m.type === "delta" || m.type === "item_update") && (m.type === "delta" ? m.itemId : m.item.id) === "m1");
		expect(relevant[0]?.type).toBe("item");
		expect(relevant[relevant.length - 1]?.type).toBe("item_update");
		const deltas = relevant.filter((m): m is Extract<ServerMessage, { type: "delta" }> => m.type === "delta");
		expect(deltas.length).toBeGreaterThan(0);
		expect(deltas.map((d) => d.text).join("")).toBe(SCRIPTED_TEXT);

		const prompts = logLines().filter((c) => c.type === "prompt");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatchObject({ message: "do the thing", streamingBehavior: "followUp" });
	});

	test("the select dialog arrives once, alerts once, and an answer reaches omp and clears it", async () => {
		const dialogMessage = await phone.waitFor("dialog", (m) => (m.type === "dialog" && m.dialog?.id === "dlg-1" ? m : false));
		expect(dialogMessage.dialog).toMatchObject({ kind: "select", title: "Pick one", options: ["alpha", "beta"] });

		await until("the needs-answer alert", () => hits.some((h) => h.body === "Needs your answer"));
		await sleep(400);
		expect(hits.filter((h) => h.body === "Needs your answer")).toHaveLength(1);
		const alert = hits.find((h) => h.body === "Needs your answer")!;
		expect(alert.title).toBe(basename(env.repo));
		expect(alert.click).toBe(`${ORIGIN}/?session=${SESSION_ID}`);

		const mark = phone.messages.length;
		phone.send({ type: "answer", clientId: "a1", dialogId: "dlg-1", answer: { kind: "select", value: "beta" } });
		expect((await phone.ack("a1")).status).toBe("ok");
		await until("dialog cleared", () => phone.messages.slice(mark).some((m) => m.type === "dialog" && m.dialog === null));

		const replies = logLines().filter((c) => c.type === "extension_ui_response");
		expect(replies).toHaveLength(1);
		expect(replies[0]).toEqual({ type: "extension_ui_response", id: "dlg-1", value: "beta" });
	});

	test("a clientId sent twice produces one prompt and a duplicate ack", async () => {
		// A fresh socket has no applied ids, so this exercises the session manager's own dedupe.
		const other = await Client.open(`/ws?session=${SESSION_ID}`);
		if (other === null) throw new Error("second socket refused");
		try {
			other.send({ type: "prompt", clientId: "c1", text: "do the thing" });
			expect((await other.ack("c1")).status).toBe("duplicate");
		} finally {
			other.close();
		}
		// And the original socket, which saw the first ack, also reports a resend as duplicate.
		phone.send({ type: "prompt", clientId: "c1", text: "do the thing" });
		await until("second duplicate ack", () => phone.messages.filter((m) => m.type === "ack" && m.clientId === "c1").length >= 2);
		const acks = phone.messages.filter((m) => m.type === "ack" && m.clientId === "c1");
		expect(acks.map((a) => (a as { status: string }).status)).toEqual(["ok", "duplicate"]);
		await sleep(300);
		expect(logLines().filter((c) => c.type === "prompt")).toHaveLength(1);
	});

	test("session_settled sends exactly one Finished alert without transcript text", async () => {
		await until("the Finished alert", () => hits.some((h) => h.body.startsWith("Finished")));
		await sleep(600);
		const finished = hits.filter((h) => h.body.startsWith("Finished"));
		expect(finished).toHaveLength(1);
		expect(finished[0]!.body).toMatch(/^Finished( \(\d+m? ?\d*s\))?$/);
		expect(finished[0]!.title).toBe(basename(env.repo));
		const all = JSON.stringify(hits);
		expect(all).not.toContain("Hello");
		expect(all).not.toContain("do the thing");
		expect(all).not.toContain(SECRET_NOTIFY);
		// Only the two alerts of the script: the notify frame sent none.
		expect(hits).toHaveLength(2);
	});

	test("with no phone attached, the idle timeout stops the session, which stays resumable", async () => {
		const listed = (await (await api("/api/bootstrap")).json()) as BootstrapResponse;
		expect(listed.sessions.find((s) => s.id === SESSION_ID)?.running).toBe(true);

		// While the phone is attached the session must survive well past the timeout.
		await sleep(IDLE_TIMEOUT_MS + 2500);
		expect(fakePids()).toHaveLength(1);
		const stillRunning = (await (await api("/api/bootstrap")).json()) as BootstrapResponse;
		expect(stillRunning.sessions.find((s) => s.id === SESSION_ID)?.running).toBe(true);

		phone.close();
		await until("the fake process to exit", () => fakePids().length === 0, 20_000);
		const after = (await (await api("/api/bootstrap")).json()) as BootstrapResponse;
		const entry = after.sessions.find((s) => s.id === SESSION_ID);
		expect(entry).toBeDefined();
		expect(entry!.running).toBe(false);
		expect(entry!.openElsewhere).toBe(false);
		expect(entry!.sessionFile).toBe(env.sessionFile);
		expect(after.sessions.filter((s) => s.running)).toEqual([]);
	}, 40_000);

	test("SIGTERM exits cleanly within a few seconds and leaves no omp process behind", async () => {
		const res = await api("/api/sessions", { method: "POST", body: JSON.stringify({ repoPath: env.repo }) });
		expect(res.status).toBe(200);
		expect(fakePids()).toHaveLength(1);

		const stderrBefore = serverErr.length;
		server.kill("SIGTERM");
		const code = await Promise.race([server.exited, sleep(5000).then(() => "timeout" as const)]);
		expect(code).toBe(0);
		await until("output drained", () => /shutting down \(SIGTERM\)/.test(serverOut), 2000);
		expect(fakePids()).toEqual([]);
		expect(serverErr.slice(stderrBefore)).toBe("");
		expect(serverOut + serverErr).not.toMatch(/\n\s+at .*:\d+:\d+/);
		expect(serverOut + serverErr).not.toMatch(/\b\w*Error\b/);
	});
});


