import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOmpProcess } from "./client";
import type { OmpEvent, OmpProcess } from "./port";

const FAKE = join(import.meta.dir, "../../../test/fake-omp.ts");

let dir: string;
let started: OmpProcess[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "burrow-client-"));
});

afterEach(() => {
	for (const proc of started) proc.kill();
	started = [];
	rmSync(dir, { recursive: true, force: true });
});

async function start(args: string[] = [], extra: { resumeFile?: string; env?: Record<string, string> } = {}) {
	const proc = await startOmpProcess({
		command: ["bun", FAKE, ...args],
		cwd: dir,
		env: extra.env ?? {},
		...(extra.resumeFile ? { resumeFile: extra.resumeFile } : {}),
	});
	started.push(proc);
	return proc;
}

function logOf(path: string): Array<Record<string, unknown>> {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

function collect(proc: OmpProcess): OmpEvent[] {
	const events: OmpEvent[] = [];
	proc.onEvent((e) => events.push(e));
	return events;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await Bun.sleep(10);
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("startOmpProcess handshake", () => {
	test("consumes the ready frame, negotiates v2, then reads state, before any caller command", async () => {
		const log = join(dir, "log.jsonl");
		const proc = await start(["--log", log, "--session-id", "s-1", "--session-file", "/tmp/s-1.jsonl"]);
		const sent = logOf(log);
		expect(sent.map((c) => c.type)).toEqual(["negotiate_protocol", "get_state"]);
		expect(sent[0]).toMatchObject({ protocolVersion: 2, id: "req_1" });
		expect(proc.sessionId).toBe("s-1");
		expect(proc.sessionFile).toBe("/tmp/s-1.jsonl");
		expect(proc.pid).toBeGreaterThan(0);
	});

	test("leaves sessionId and sessionFile null when get_state has none", async () => {
		const proc = await start();
		expect(proc.sessionId).toBeNull();
		expect(proc.sessionFile).toBeNull();
	});

	test("resumeFile becomes --resume=<file> and the extra args reach the process", async () => {
		const proc = await start(["--body-file", "/tmp/body"], { resumeFile: "/tmp/old.jsonl" });
		expect(proc.sessionFile).toBe("/tmp/old.jsonl");
		const state = await proc.send<{ resume?: string; bodyFile?: string }>({ type: "get_state" });
		expect(state).toMatchObject({ ok: true, data: { resume: "/tmp/old.jsonl", bodyFile: "/tmp/body" } });
	});

	test("env is merged over the current environment and cwd is honoured", async () => {
		const out = join(dir, "env.txt");
		const proc = await startOmpProcess({
			command: [
				"sh",
				"-c",
				`printf '%s %s %s' "$BURROW" "$HOME" "$(pwd)" > ${out}; echo '{"type":"ready","protocolVersion":1}'; read l; echo '{"id":"req_1","type":"response","command":"get_state","success":true}'; cat >/dev/null`,
			],
			cwd: dir,
			env: { BURROW: "1" },
		});
		started.push(proc);
		const [burrow, home, cwd] = readFileSync(out, "utf8").split(" ");
		expect(burrow).toBe("1");
		expect(home).toBe(process.env.HOME!);
		expect(cwd).toBe(dir);
	});

	test("does not negotiate when the ready frame does not advertise v2", async () => {
		const log = join(dir, "log.jsonl");
		const script = [
			"read line; echo \"$line\" >> " + log,
			"echo '{\"id\":\"req_1\",\"type\":\"response\",\"command\":\"get_state\",\"success\":true,\"data\":{\"sessionId\":\"v1\"}}'",
			"cat >/dev/null",
		].join("; ");
		const proc = await startOmpProcess({
			command: ["sh", "-c", `echo '{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1]}'; ${script}`],
			cwd: dir,
			env: {},
		});
		started.push(proc);
		expect(proc.sessionId).toBe("v1");
		expect(logOf(log).map((c) => c.type)).toEqual(["get_state"]);
	});

	test("early exit before ready rejects with the stderr text", async () => {
		const attempt = startOmpProcess({
			command: ["sh", "-c", "echo 'boom: no config' >&2; exit 3"],
			cwd: dir,
			env: {},
		});
		await expect(attempt).rejects.toThrow("boom: no config");
	});

	test("a process that crashes right after ready rejects with its stderr", async () => {
		const attempt = startOmpProcess({ command: ["bun", FAKE, "--crash-after-ready"], cwd: dir, env: {} });
		await expect(attempt).rejects.toThrow("fake omp crashed after ready");
	});

	test("ready timeout kills the child before rejecting", async () => {
		const pidFile = join(dir, "pid");
		const attempt = startOmpProcess({
			command: ["sh", "-c", `echo $$ > ${pidFile}; exec sleep 60`],
			cwd: dir,
			env: {},
			readyTimeoutMs: 300,
		});
		await expect(attempt).rejects.toThrow(/handshake within 300/);
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(alive(pid)).toBe(false);
	});
});

describe("send", () => {
	test("ids are monotonic and responses resolve by id with two commands in flight", async () => {
		const log = join(dir, "log.jsonl");
		const proc = await start(["--log", log]);
		// The slow command is answered after its script; the fast one resolves first.
		const [slow, fast] = [
			proc.send({ type: "get_subagents" }),
			proc.send({ type: "abort" }),
		];
		const [a, b] = await Promise.all([slow, fast]);
		expect(a).toEqual({ ok: true, data: { subagents: [] } });
		expect(b).toEqual({ ok: true, data: {} });
		const ids = logOf(log).map((c) => c.id);
		expect(ids).toEqual(["req_1", "req_2", "req_3", "req_4"]);
	});

	test("responses are matched by id even when they arrive out of order", async () => {
		const proc = await start();
		const first = proc.send({ type: "__hold" });
		const second = proc.send({ type: "__hold" });
		// Answer req_4 before req_3.
		const forged = await proc.send({
			type: "__emit",
			frames: [
				{ id: "req_4", type: "response", command: "get_messages_page", success: true, data: { which: "second" } },
				{ id: "req_3", type: "response", command: "get_subagents", success: true, data: { which: "first" } },
			],
		});
		expect(forged.ok).toBe(true);
		expect(await second).toEqual({ ok: true, data: { which: "second" } });
		expect(await first).toEqual({ ok: true, data: { which: "first" } });
	});

	test("failure responses carry error and code", async () => {
		const proc = await start();
		const pending = proc.send({ type: "__hold" });
		await proc.send({
			type: "__emit",
			frames: [{ id: "req_3", type: "response", command: "get_messages_page", success: false, error: "busy", code: "session_busy" }],
		});
		expect(await pending).toEqual({ ok: false, error: "busy", code: "session_busy" });
	});

	test("extension_ui_response keeps the caller's id, resolves at once and registers nothing", async () => {
		const log = join(dir, "log.jsonl");
		const proc = await start(["--log", log]);
		const res = await proc.send({ type: "extension_ui_response", id: "dialog-7", confirmed: true });
		expect(res).toEqual({ ok: true, data: null });
		// The next command still gets the next req_N, so the reply did not consume an id.
		await proc.send({ type: "abort" });
		const sent = logOf(log);
		expect(sent.at(-2)).toEqual({ type: "extension_ui_response", id: "dialog-7", confirmed: true });
		expect(sent.at(-1)).toMatchObject({ type: "abort", id: "req_3" });
	});

	test("unknown commands come back as an error result", async () => {
		const proc = await start();
		const res = await proc.send({ type: "nope" });
		expect(res).toMatchObject({ ok: false });
	});

	test("rpc_frame_error and unrelated frames do not resolve a pending send", async () => {
		const proc = await start();
		const events = collect(proc);
		let settled = false;
		const pending = proc.send({ type: "__hold" }).then((r) => {
			settled = true;
			return r;
		});
		await proc.send({
			type: "__emit",
			frames: [
				{ type: "rpc_frame_error", id: "req_3", error: "too big" },
				{ id: "other", type: "response", command: "x", success: true },
				{ type: "notice", message: "hi" },
			],
		});
		await until(() => events.length >= 2);
		expect(settled).toBe(false);
		expect(events.map((e) => e.type)).toEqual(["rpc_frame_error", "notice"]);
		await proc.send({
			type: "__emit",
			frames: [{ id: "req_3", type: "response", command: "get_messages_page", success: true, data: 1 }],
		});
		expect(await pending).toEqual({ ok: true, data: 1 });
	});

	test("send after exit resolves with an error and pending sends fail on exit", async () => {
		const proc = await start();
		const pending = proc.send({ type: "__emit", frames: [] }).then(() => proc.send({ type: "get_messages_page" }));
		await proc.send({ type: "__exit", code: 0 });
		expect(await pending).toMatchObject({ ok: false });
		await until(() => proc.exited);
		expect(await proc.send({ type: "get_state" })).toMatchObject({ ok: false });
	});
});

describe("events", () => {
	test("are delivered in order, not confused with responses, and responses are not events", async () => {
		const proc = await start();
		const events = collect(proc);
		await proc.send({
			type: "__script",
			steps: [
				{ frame: { type: "agent_start" } },
				{ delayMs: 20, frame: { type: "message_update", n: 1 } },
				{ frame: { type: "message_update", n: 2 } },
				{ frame: { type: "agent_end" } },
				{ frame: { type: "session_settled" } },
			],
		});
		await until(() => events.length >= 5);
		expect(events.map((e) => e.type)).toEqual(["agent_start", "message_update", "message_update", "agent_end", "session_settled"]);
		expect(events.map((e) => e.n).filter(Boolean)).toEqual([1, 2]);
	});

	test("--script events play after a prompt", async () => {
		const script = join(dir, "script.json");
		writeFileSync(script, JSON.stringify([{ frame: { type: "agent_start" } }, { frame: { type: "session_settled" } }]));
		const proc = await start(["--script", script]);
		const events = collect(proc);
		const res = await proc.send({ type: "prompt", message: "hi", streamingBehavior: "followUp" });
		expect(res).toMatchObject({ ok: true });
		await until(() => events.length >= 2);
		expect(events.map((e) => e.type)).toEqual(["agent_start", "session_settled"]);
	});

	test("unsubscribe stops delivery and every handler sees every event", async () => {
		const proc = await start();
		const a: string[] = [];
		const b: string[] = [];
		const offA = proc.onEvent((e) => a.push(e.type));
		proc.onEvent((e) => b.push(e.type));
		await proc.send({ type: "__emit", frames: [{ type: "one" }] });
		await until(() => b.length === 1);
		offA();
		await proc.send({ type: "__emit", frames: [{ type: "two" }] });
		await until(() => b.length === 2);
		expect(a).toEqual(["one"]);
		expect(b).toEqual(["one", "two"]);
	});

	test("events emitted before the first subscriber are replayed in order", async () => {
		const proc = await start();
		// No subscriber yet: events land in the startup backlog.
		await proc.send({ type: "__emit", frames: [{ type: "early_1" }, { type: "early_2" }] });
		const events = collect(proc);
		expect(events.map((e) => e.type)).toEqual(["early_1", "early_2"]);
	});

	test("a large logical frame arrives byte exact through rpc_chunk", async () => {
		const proc = await start();
		const events = collect(proc);
		const text = "héllo €".repeat(250_000);
		const frame = { type: "message_end", message: { text } };
		await proc.send({ type: "__chunked", frame, chunkSize: 100_000 });
		await until(() => events.length >= 1, 10_000);
		expect(events).toHaveLength(1);
		expect((events[0]!.message as { text: string }).text).toBe(text);
	});

	test("a malformed line and bad chunk sequences do not kill the stream", async () => {
		const proc = await start();
		const events = collect(proc);
		const base = { type: "rpc_chunk", chunkId: "bad", count: 3, byteLength: 30, data: Buffer.from("x".repeat(10)).toString("base64") };
		await proc.send({
			type: "__emit",
			frames: [
				{ ...base, index: 0 },
				{ ...base, index: 2 },
				{ type: "after_chunk_fault" },
			],
		});
		await until(() => events.length >= 1);
		expect(events.map((e) => e.type)).toEqual(["after_chunk_fault"]);
	});

	test("a malformed JSON line between frames is skipped", async () => {
		const proc = await startOmpProcess({
			command: [
				"sh",
				"-c",
				[
					`echo '{"type":"ready","protocolVersion":1}'`,
					`read l`,
					`echo '{"id":"req_1","type":"response","command":"get_state","success":true}'`,
					`echo 'this is not json'`,
					`echo '{"type":"still_alive"}'`,
					`cat >/dev/null`,
				].join("; "),
			],
			cwd: dir,
			env: {},
		});
		started.push(proc);
		const events = collect(proc);
		await until(() => events.length >= 1);
		expect(events.map((e) => e.type)).toEqual(["still_alive"]);
	});
});

describe("exit and close", () => {
	test("close() resolves with exit 0 and the process is really gone", async () => {
		const proc = await start();
		const info = await proc.close();
		expect(info.code).toBe(0);
		expect(info.signal).toBeNull();
		expect(proc.exited).toBe(true);
		expect(alive(proc.pid)).toBe(false);
	});

	test("close() keeps draining stdout until the process finishes its output", async () => {
		const proc = await start();
		const events = collect(proc);
		await proc.send({
			type: "__script",
			steps: [{ delayMs: 150, frame: { type: "late_event" } }],
		});
		const info = await proc.close();
		expect(info.code).toBe(0);
		expect(events.map((e) => e.type)).toEqual(["late_event"]);
	});

	test("onExit fires once with code and stderr after the streams drain", async () => {
		const proc = await start();
		const exits: unknown[] = [];
		proc.onExit((info) => exits.push(info));
		const events = collect(proc);
		await proc.send({ type: "__stderr", text: "warning: something\n" });
		await proc.send({ type: "__emit", frames: [{ type: "last_words" }] });
		await proc.send({ type: "__exit", code: 3 });
		await until(() => exits.length > 0);
		// A second onExit would be a bug that only shows up after a real delay.
		await Bun.sleep(50);
		expect(exits).toEqual([{ code: 3, signal: null, stderr: "warning: something\n" }]);
		expect(events.map((e) => e.type)).toEqual(["last_words"]);
		const again = await proc.close();
		expect(again.code).toBe(3);
	});

	test("kill() sends SIGKILL immediately", async () => {
		const proc = await start();
		const exited = new Promise<{ signal: string | null }>((resolve) => proc.onExit(resolve));
		proc.kill();
		expect((await exited).signal).toBe("SIGKILL");
		expect(alive(proc.pid)).toBe(false);
	});

	test("close() kills a process that ignores stdin closing after 10 seconds", async () => {
		const proc = await startOmpProcess({
			command: ["sh", "-c", `echo '{"type":"ready","protocolVersion":1}'; read l; echo '{"id":"req_1","type":"response","command":"get_state","success":true}'; exec sleep 60`],
			cwd: dir,
			env: {},
		});
		started.push(proc);
		const t0 = Date.now();
		const info = await proc.close();
		expect(info.signal).toBe("SIGKILL");
		expect(Date.now() - t0).toBeGreaterThanOrEqual(9_000);
		expect(alive(proc.pid)).toBe(false);
	}, 20_000);
});

describe("hold-file", () => {
	test("the fake holds a file open as a stand-in for a session file", async () => {
		const held = join(dir, "held.jsonl");
		writeFileSync(held, "");
		const proc = await start(["--hold-file", held]);
		// bun runs the fake directly, so the pid is the fake itself.
		const targets = readdirSync(`/proc/${proc.pid}/fd`).map((fd) => {
			try {
				return readlinkSync(`/proc/${proc.pid}/fd/${fd}`);
			} catch {
				return "";
			}
		});
		expect(targets).toContain(held);
	});
});
