import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../../shared/protocol";
import { createAlerter } from "../alerts";
import type { BurrowConfig } from "../config";
import { startOmpProcess } from "../omp/client";
import type { OmpCommand, OmpProcess, RpcResult } from "../omp/port";
import { isSessionOpen } from "../repos/open-proc";
import { createSessionManager } from "./manager";
import type { SessionManagerPort } from "./port";

const FAKE = join(import.meta.dir, "../../../test/fake-omp.ts");

interface Hit {
	body: string;
	title: string | null;
}

let root: string;
let repo: string;
let sessionsDir: string;
let logPath: string;
let ntfy: ReturnType<typeof Bun.serve>;
let hits: Hit[];
let procs: OmpProcess[];
let spawnCalls: number;
let sent: OmpCommand[];
let seedMessages: unknown[] | null;
let clock: number;
let manager: SessionManagerPort | null;
let holders: Array<ReturnType<typeof Bun.spawn>>;
let events: Array<{ sessionId: string | null; message: ServerMessage }>;
/** A command type the wrapper never lets omp answer, standing in for a hung setup step. */
let hangCommand: string | null;
/** Canned answers for commands the fake does not know. */
let canned: Record<string, RpcResult>;
/** While set, close() waits for it before closing stdin, so a stop stays in progress. */
let closeGate: Promise<void> | null;
/** Set to a session file: right after a spawn, another process opens it. */
let grabAfterSpawn: string | null;
let setupTimeoutMs: number | undefined;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "burrow-mgr-")));
	repo = join(root, "repo");
	sessionsDir = join(root, "sessions");
	mkdirSync(repo);
	mkdirSync(join(sessionsDir, "folder"), { recursive: true });
	logPath = join(root, "fake.log");
	writeFileSync(logPath, "");
	hits = [];
	procs = [];
	spawnCalls = 0;
	sent = [];
	seedMessages = null;
	clock = Date.parse("2026-10-12T10:00:00Z");
	manager = null;
	holders = [];
	events = [];
	hangCommand = null;
	canned = {};
	closeGate = null;
	grabAfterSpawn = null;
	setupTimeoutMs = undefined;
	ntfy = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			hits.push({ body: await req.text(), title: req.headers.get("Title") });
			return new Response("ok");
		},
	});
});

afterEach(async () => {
	await manager?.shutdown();
	for (const proc of procs) proc.kill();
	for (const holder of holders) holder.kill();
	await ntfy.stop(true);
	rmSync(root, { recursive: true, force: true });
});

function make(extraArgs: string[] = []): SessionManagerPort {
	const config: BurrowConfig = {
		port: 0,
		wakePort: 0,
		ownerLogin: "me@example.com",
		origin: "https://burrow.test",
		repos: [repo],
		ntfyUrl: `http://127.0.0.1:${ntfy.port}/topic`,
		ompCommand: ["bun", FAKE, "--log", logPath, ...extraArgs],
		sessionsDir,
		configDir: join(root, "config"),
		webRoot: join(root, "web"),
		idleTimeoutMs: 600_000,
	};
	manager = createSessionManager({
		config,
		now: () => new Date(clock),
		alerter: createAlerter({ ntfyUrl: config.ntfyUrl, origin: config.origin }),
		...(setupTimeoutMs === undefined ? {} : { setupTimeoutMs }),
		spawn: async (options) => {
			spawnCalls += 1;
			const proc = await startOmpProcess(options);
			procs.push(proc);
			if (grabAfterSpawn !== null) {
				const file = grabAfterSpawn;
				holders.push(Bun.spawn(["bun", FAKE, "--hold-file", file], { stdin: "pipe", stdout: "ignore", stderr: "ignore" }));
				// Polls /proc like the existing resume test: there is no event for "another process opened the file".
				for (let i = 0; i < 500 && !(await isSessionOpen(file)); i++) await Bun.sleep(10);
			}
			return {
				get pid() {
					return proc.pid;
				},
				get sessionId() {
					return proc.sessionId;
				},
				get sessionFile() {
					return proc.sessionFile;
				},
				get exited() {
					return proc.exited;
				},
				send(command: OmpCommand) {
					sent.push(command);
					if (command.type === "get_messages_page" && seedMessages) {
						return Promise.resolve({ ok: true, data: { messages: seedMessages, totalMessages: seedMessages.length } } as never);
					}
					if (command.type === hangCommand) return proc.send({ type: "__hold" });
					const reply = canned[command.type];
					if (reply) return Promise.resolve(reply as never);
					return proc.send(command);
				},
				onEvent: (handler) => proc.onEvent(handler),
				onExit: (handler) => proc.onExit(handler),
				close: () => (closeGate ?? Promise.resolve()).then(() => proc.close()),
				kill: () => proc.kill(),
			} satisfies OmpProcess;
		},
	});
	manager.subscribe((sessionId, message) => events.push({ sessionId, message }));
	return manager;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await Bun.sleep(10);
	}
}

function log(): Array<Record<string, unknown>> {
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function emitFrames(frames: unknown[], index = 0): Promise<unknown> {
	return procs[index]!.send({ type: "__emit", frames });
}

function messages(type: string): ServerMessage[] {
	return events.map((e) => e.message).filter((m) => m.type === type);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function startOk(m: SessionManagerPort, input: { repoPath: string; sessionFile?: string } = { repoPath: repo }) {
	const res = await m.start(input);
	if (!res.ok) throw new Error(`start failed: ${res.error.code} ${res.error.message}`);
	return res.value;
}

function sessionFile(name: string, cwd = repo): string {
	const file = join(sessionsDir, "folder", `${name}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: name, cwd })}\n`);
	return file;
}

describe("start and deliver", () => {
	test("setup commands then one prompt with followUp, in order; a repeated client id sends one prompt", async () => {
		const m = make();
		const summary = await startOk(m);
		expect(summary).toMatchObject({ repo, repoName: "repo", running: true, status: "idle", openAtLaptop: false });
		expect(m.runningIds()).toEqual([summary.id]);

		const first = await m.deliver(summary.id, { type: "prompt", clientId: "c1", text: "hello" });
		const again = await m.deliver(summary.id, { type: "prompt", clientId: "c1", text: "hello" });
		expect(first.status).toBe("ok");
		expect(again.status).toBe("duplicate");

		const commands = log().map((c) => c.type as string);
		const wanted = ["set_event_filter", "set_ask_dialog", "set_subagent_subscription", "prompt"];
		expect(commands.filter((t) => wanted.includes(t))).toEqual(wanted);
		expect(commands.filter((t) => t === "prompt")).toHaveLength(1);
		expect(commands).not.toContain("get_messages_page");
		const byType = (type: string) => log().find((c) => c.type === type);
		expect(byType("set_event_filter")).toMatchObject({ events: null, messageUpdates: "delta" });
		expect(byType("set_ask_dialog")).toMatchObject({ enabled: true });
		expect(byType("set_subagent_subscription")).toMatchObject({ level: "progress" });
		expect(byType("prompt")).toMatchObject({ message: "hello", streamingBehavior: "followUp" });
	});

	test("stop sends abort_and_restore_queue and falls back to abort when the runtime rejects it", async () => {
		const m = make();
		const summary = await startOk(m);
		expect((await m.deliver(summary.id, { type: "abort", clientId: "a1" })).status).toBe("ok");
		// The fake, like an older omp, answers abort_and_restore_queue with an unknown-command failure.
		const types = log().map((c) => c.type);
		expect(types.filter((t) => t === "abort_and_restore_queue" || t === "abort")).toEqual(["abort_and_restore_queue", "abort"]);
	});

	test("withdrawn queued messages come back as one notice and are not re-queued", async () => {
		canned.abort_and_restore_queue = {
			ok: true,
			data: { steering: [{ text: "Use the existing parser" }], followUp: [{ text: "Then run\nthe tests" }] },
		};
		const m = make();
		const summary = await startOk(m);
		expect((await m.deliver(summary.id, { type: "abort", clientId: "a1" })).status).toBe("ok");
		expect(sent.filter((c) => c.type === "abort")).toHaveLength(0);
		expect(sent.filter((c) => c.type === "prompt" || c.type === "steer")).toHaveLength(0);
		const notices = m.snapshot(summary.id)!.items.filter((i) => i.kind === "notice");
		expect(notices).toHaveLength(1);
		expect(notices[0]!.text).not.toContain("\n");
		expect(notices[0]!.text).toContain("Use the existing parser");
		expect(notices[0]!.text).toContain("Then run the tests");
	});

	test("an empty withdrawal adds no notice", async () => {
		canned.abort_and_restore_queue = { ok: true, data: { steering: [], followUp: [] } };
		const m = make();
		const summary = await startOk(m);
		expect((await m.deliver(summary.id, { type: "abort", clientId: "a1" })).status).toBe("ok");
		expect(m.snapshot(summary.id)!.items).toEqual([]);
	});

	test("deliver to an unknown session is an error and never throws", async () => {
		const m = make();
		const res = await m.deliver("nope", { type: "abort", clientId: "x" });
		expect(res.status).toBe("error");
	});

	test("a repo outside the allowlist and a symlink to one are refused with no process started", async () => {
		const m = make();
		const outside = join(root, "outside");
		mkdirSync(outside);
		const link = join(root, "link");
		symlinkSync(outside, link);
		const sneaky = join(repo, "..", "outside");
		for (const repoPath of [outside, link, sneaky]) {
			const res = await m.start({ repoPath });
			expect(res).toMatchObject({ ok: false, error: { code: "repo_not_allowed" } });
		}
		expect(spawnCalls).toBe(0);
	});

	test("a symlink to an allowlisted repo resolves to it", async () => {
		const m = make();
		const link = join(root, "alias");
		symlinkSync(repo, link);
		expect((await startOk(m, { repoPath: link })).repo).toBe(repo);
	});
});

describe("events", () => {
	test("deltas then message_end give one assistant item and item/delta/item_update reach subscribers", async () => {
		const m = make();
		const summary = await startOk(m);
		const delta = (text: string) => ({
			type: "message_update",
			messageId: "m1",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
		});
		await emitFrames([
			{ type: "message_start", messageId: "m1", message: { role: "assistant", content: [] } },
			delta("Hel"),
			delta("lo"),
			{ type: "message_end", messageId: "m1", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } },
		]);
		await until(() => messages("item_update").length === 1);
		const seen = events.filter((e) => e.sessionId === summary.id).map((e) => e.message.type);
		expect(seen.filter((t) => t === "item" || t === "delta" || t === "item_update")).toEqual(["item", "delta", "delta", "item_update"]);
		const snap = m.snapshot(summary.id)!;
		expect(snap.items).toHaveLength(1);
		expect(snap.items[0]).toMatchObject({ kind: "assistant", text: "Hello" });
	});

	test("select dialog: view, one alert, answer reaches omp exactly and clears, cancel frame clears too", async () => {
		const m = make();
		const summary = await startOk(m);
		await emitFrames([{ type: "extension_ui_request", id: "d1", method: "select", title: "Pick", options: ["a", "b"] }]);
		await until(() => hits.length === 1);
		expect(hits[0]).toEqual({ body: "Needs your answer", title: "repo" });
		const open = m.snapshot(summary.id)!;
		expect(open.dialog).toMatchObject({ id: "d1", kind: "select", options: ["a", "b"] });
		expect(open.status.status).toBe("needs_answer");
		expect(messages("dialog").at(-1)).toMatchObject({ dialog: { id: "d1" } });
		expect(messages("status").at(-1)).toMatchObject({ status: { status: "needs_answer" } });

		const wrong = await m.deliver(summary.id, { type: "answer", clientId: "x1", dialogId: "zzz", answer: { kind: "select", value: "a" } });
		expect(wrong.status).toBe("error");

		const res = await m.deliver(summary.id, { type: "answer", clientId: "x2", dialogId: "d1", answer: { kind: "select", value: "a" } });
		expect(res.status).toBe("ok");
		await until(() => log().some((c) => c.type === "extension_ui_response"));
		expect(log().find((c) => c.type === "extension_ui_response")).toEqual({ type: "extension_ui_response", id: "d1", value: "a" });
		expect(m.snapshot(summary.id)!.dialog).toBeNull();
		expect(messages("dialog").at(-1)).toEqual({ type: "dialog", dialog: null });

		await emitFrames([{ type: "extension_ui_request", id: "d2", method: "confirm", title: "Sure?" }]);
		await until(() => m.snapshot(summary.id)!.dialog?.id === "d2");
		await until(() => hits.length === 2);
		await emitFrames([{ type: "extension_ui_request", id: "c1", method: "cancel", targetId: "d2" }]);
		await until(() => m.snapshot(summary.id)!.dialog === null);
		expect(m.snapshot(summary.id)!.status.status).toBe("idle");
		await Bun.sleep(100);
		expect(hits).toHaveLength(2);
	});

	test("discard_dialog sends a cancel response for the open dialog", async () => {
		const m = make();
		const summary = await startOk(m);
		await emitFrames([{ type: "extension_ui_request", id: "d1", method: "input", title: "Name?" }]);
		await until(() => m.snapshot(summary.id)!.dialog !== null);
		const res = await m.deliver(summary.id, { type: "discard_dialog", clientId: "k1", dialogId: "d1" });
		expect(res.status).toBe("ok");
		await until(() => log().some((c) => c.type === "extension_ui_response"));
		expect(log().find((c) => c.type === "extension_ui_response")).toEqual({ type: "extension_ui_response", id: "d1", cancelled: true });
		expect(m.snapshot(summary.id)!.dialog).toBeNull();
	});

	test("notify, setStatus, setWidget and unknown frames alert nothing and change nothing", async () => {
		const m = make();
		const summary = await startOk(m);
		const before = events.length;
		await emitFrames([
			{ type: "extension_ui_request", id: "n1", method: "notify", message: "SECRET hi" },
			{ type: "extension_ui_request", id: "n2", method: "setStatus", statusKey: "k", statusText: "t" },
			{ type: "extension_ui_request", id: "n3", method: "setWidget", widgetKey: "w" },
			{ type: "extension_ui_request", id: "n4", method: "setTitle", title: "t" },
			{ type: "extension_ui_request", id: "n5", method: "open_url", url: "https://example.com" },
			{ type: "extension_ui_request", id: "n6", method: "set_editor_text", text: "x" },
			{ type: "mystery_frame", x: 1 },
		]);
		await Bun.sleep(150);
		expect(hits).toHaveLength(0);
		expect(events.length).toBe(before);
		const snap = m.snapshot(summary.id)!;
		expect(snap.dialog).toBeNull();
		expect(snap.items).toEqual([]);
		expect(snap.status.status).toBe("idle");
	});

	test("several agent_end before one session_settled send one Finished alert with the duration and no transcript text", async () => {
		const m = make();
		const summary = await startOk(m);
		await emitFrames([
			{ type: "agent_start" },
			{ type: "message_start", messageId: "u1", message: { role: "user", content: "TOPSECRET prompt" } },
		]);
		await until(() => m.snapshot(summary.id)!.status.status === "working");
		clock += 5000;
		await emitFrames([
			{ type: "agent_end", yielded: true, awaitingAsyncWork: true },
			{ type: "agent_start" },
			{ type: "agent_end", yielded: true, awaitingAsyncWork: true },
			{ type: "agent_end", yielded: true, awaitingAsyncWork: true },
		]);
		await Bun.sleep(100);
		expect(hits).toHaveLength(0);
		clock += 7000;
		const summariesBefore = messages("session").length;
		await emitFrames([{ type: "session_settled" }]);
		await until(() => hits.length === 1);
		await until(() => messages("session").length > summariesBefore);
		await Bun.sleep(150);
		expect(hits).toEqual([{ body: "Finished (12s)", title: "repo" }]);
		expect(JSON.stringify(hits)).not.toContain("TOPSECRET");
		expect(m.snapshot(summary.id)!.status.status).toBe("idle");
	});

	test("session_settled without an agent_start omits the duration", async () => {
		const m = make();
		await startOk(m);
		await emitFrames([{ type: "session_settled" }]);
		await until(() => hits.length === 1);
		expect(hits[0]!.body).toBe("Finished");
	});

	test("queue_update, notice and extension_error reach subscribers", async () => {
		const m = make();
		const summary = await startOk(m);
		await emitFrames([
			{ type: "queue_update", steering: ["one"], followUp: [{ text: "two" }] },
			{ type: "notice", message: "heads up" },
			{ type: "extension_error", extensionPath: "x", event: "e", error: "boom" },
		]);
		await until(() => messages("item").length === 2);
		expect(messages("queued").at(-1)).toEqual({ type: "queued", queued: { steering: ["one"], followUp: ["two"] } });
		expect(m.snapshot(summary.id)!.queued).toEqual({ steering: ["one"], followUp: ["two"] });
		const notices = m.snapshot(summary.id)!.items.map((i) => i.text);
		expect(notices).toEqual(["heads up", "omp: boom"]);
	});

	test("two dialogs opened in sequence are both answerable, oldest first", async () => {
		const m = make();
		const summary = await startOk(m);
		await emitFrames([
			{ type: "extension_ui_request", id: "d1", method: "select", title: "Pick", options: ["a", "b"] },
			{ type: "extension_ui_request", id: "d2", method: "confirm", title: "Sure?" },
		]);
		await until(() => m.snapshot(summary.id)!.dialog !== null);
		expect(m.snapshot(summary.id)!.dialog).toMatchObject({ id: "d1" });
		expect((await m.deliver(summary.id, { type: "answer", clientId: "x0", dialogId: "d2", answer: { kind: "confirm", confirmed: true } })).status).toBe("error");

		expect((await m.deliver(summary.id, { type: "answer", clientId: "x1", dialogId: "d1", answer: { kind: "select", value: "b" } })).status).toBe("ok");
		const second = m.snapshot(summary.id)!;
		expect(second.dialog).toMatchObject({ id: "d2", kind: "confirm" });
		expect(second.status.status).toBe("needs_answer");
		expect(messages("dialog").at(-1)).toMatchObject({ dialog: { id: "d2" } });

		expect((await m.deliver(summary.id, { type: "answer", clientId: "x2", dialogId: "d2", answer: { kind: "confirm", confirmed: true } })).status).toBe("ok");
		expect(m.snapshot(summary.id)!.dialog).toBeNull();
		expect(m.snapshot(summary.id)!.status.status).toBe("idle");
		await until(() => log().filter((c) => c.type === "extension_ui_response").length === 2);
		expect(log().filter((c) => c.type === "extension_ui_response")).toEqual([
			{ type: "extension_ui_response", id: "d1", value: "b" },
			{ type: "extension_ui_response", id: "d2", confirmed: true },
		]);
	});

	test("cancelling a waiting dialog drops it without touching the open one; cancelling the open one promotes the next", async () => {
		const m = make();
		const summary = await startOk(m);
		await emitFrames([
			{ type: "extension_ui_request", id: "d1", method: "input", title: "One" },
			{ type: "extension_ui_request", id: "d2", method: "input", title: "Two" },
			{ type: "extension_ui_request", id: "d3", method: "input", title: "Three" },
			{ type: "extension_ui_request", id: "c1", method: "cancel", targetId: "d2" },
			{ type: "extension_ui_request", id: "c2", method: "cancel", targetId: "d1" },
		]);
		expect(m.snapshot(summary.id)!.dialog).toMatchObject({ id: "d3" });
		expect(m.snapshot(summary.id)!.status.status).toBe("needs_answer");
		expect(messages("dialog").map((d) => (d.type === "dialog" ? (d.dialog?.id ?? null) : undefined))).toEqual(["d1", "d3"]);
	});
});

describe("resume", () => {
	test("a session file held open by another process is refused, then resumes once the holder exits and seeds the transcript", async () => {
		const file = sessionFile("sess-1");
		const holder = Bun.spawn(["bun", FAKE, "--hold-file", file], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
		holders.push(holder);
		for (let i = 0; i < 500 && !(await isSessionOpen(file)); i++) await Bun.sleep(10);
		expect(await isSessionOpen(file)).toBe(true);

		const m = make(["--session-id", "sess-1"]);
		const refused = await m.start({ repoPath: repo, sessionFile: file });
		expect(refused).toMatchObject({ ok: false, error: { code: "open_at_laptop" } });
		expect(spawnCalls).toBe(0);
		const listed = await m.list();
		expect(listed.find((s) => s.sessionFile === file)).toMatchObject({ openAtLaptop: true, running: false });

		holder.kill();
		await holder.exited;
		seedMessages = [
			{ role: "user", content: "first question" },
			{ role: "assistant", content: [{ type: "text", text: "first answer" }] },
			{ role: "toolResult", content: "ignored" },
		];
		const summary = await startOk(m, { repoPath: repo, sessionFile: file });
		expect(spawnCalls).toBe(1);
		expect(summary).toMatchObject({ id: "sess-1", sessionFile: file, running: true, title: "first question" });
		const types = sent.map((c) => c.type);
		expect(types.indexOf("get_messages_page")).toBeGreaterThan(types.indexOf("set_subagent_subscription") - 1);
		expect(types.indexOf("get_messages_page")).toBeLessThan(types.lastIndexOf("get_state"));
		const items = m.snapshot("sess-1")!.items;
		expect(items.map((i) => [i.kind, i.text])).toEqual([
			["user", "first question"],
			["assistant", "first answer"],
		]);
	});

	test("a session file outside the sessions folder, or for another repo, is refused with no process started", async () => {
		const m = make();
		const stray = join(root, "stray.jsonl");
		writeFileSync(stray, `${JSON.stringify({ type: "session", id: "s", cwd: repo })}\n`);
		expect(await m.start({ repoPath: repo, sessionFile: stray })).toMatchObject({ ok: false, error: { code: "invalid_session_file" } });
		const elsewhere = join(root, "elsewhere");
		mkdirSync(elsewhere);
		const foreign = sessionFile("foreign", elsewhere);
		expect(await m.start({ repoPath: repo, sessionFile: foreign })).toMatchObject({ ok: false, error: { code: "repo_not_allowed" } });
		expect(spawnCalls).toBe(0);
	});
});

describe("lifecycle", () => {
	test("the process exiting by itself removes the session from running and emits a summary and a notice", async () => {
		const m = make();
		const summary = await startOk(m);
		await emitFrames([{ type: "extension_ui_request", id: "d1", method: "select", title: "t", options: ["a"] }]);
		await until(() => m.snapshot(summary.id)!.dialog !== null);
		const before = events.length;
		void procs[0]!.send({ type: "__exit", code: 3 });
		await until(() => m.runningIds().length === 0);
		const after = events.slice(before);
		expect(after.some((e) => e.message.type === "dialog" && e.message.dialog === null)).toBe(true);
		const last = messages("session").at(-1) as { session: { running: boolean; status: string; id: string } };
		expect(last.session).toMatchObject({ id: summary.id, running: false, status: "stopped" });
		expect(events.some((e) => e.sessionId === null && e.message.type === "session")).toBe(true);
		const notice = messages("item").at(-1) as { item: { kind: string; text: string } };
		expect(notice.item.kind).toBe("notice");
		expect(notice.item.text).toContain("code 3");
		expect(m.snapshot(summary.id)).toBeNull();
	});

	test("stop(handoff) closes the process and the session file becomes a resumable recent file", async () => {
		const file = sessionFile("sess-2");
		const m = make(["--session-id", "sess-2"]);
		const summary = await startOk(m, { repoPath: repo, sessionFile: file });
		const pid = procs[0]!.pid;
		const stopped = await m.stop(summary.id, "handoff");
		expect(stopped).toEqual({ ok: true, value: null });
		expect(alive(pid)).toBe(false);
		expect(m.runningIds()).toEqual([]);
		expect(m.snapshot(summary.id)).toBeNull();
		const last = messages("session").at(-1) as { session: { running: boolean } };
		expect(last.session.running).toBe(false);

		const listed = await m.list();
		expect(listed.find((s) => s.sessionFile === file)).toMatchObject({ id: "sess-2", running: false, openAtLaptop: false, status: "idle" });
		expect((await m.stop(summary.id, "handoff"))).toMatchObject({ ok: false, error: { code: "session_not_found" } });
		const again = await startOk(m, { repoPath: repo, sessionFile: file });
		expect(again.id).toBe("sess-2");
	});

	test("stop_session from the phone stops with handoff", async () => {
		const m = make();
		const summary = await startOk(m);
		expect((await m.deliver(summary.id, { type: "stop_session", clientId: "s1" })).status).toBe("ok");
		expect(m.runningIds()).toEqual([]);
	});

	test("list puts running sessions first and caps at 30", async () => {
		const m = make();
		for (let i = 0; i < 35; i++) sessionFile(`old-${i}`);
		const summary = await startOk(m);
		const listed = await m.list();
		expect(listed).toHaveLength(30);
		expect(listed[0]).toMatchObject({ id: summary.id, running: true });
		expect(listed.slice(1).every((s) => !s.running)).toBe(true);
	});

	test("shutdown leaves no child alive and is safe to call twice", async () => {
		const m = make();
		await startOk(m);
		await startOk(m);
		const pids = procs.map((p) => p.pid);
		expect(pids).toHaveLength(2);
		await m.shutdown();
		await m.shutdown();
		for (const pid of pids) expect(alive(pid)).toBe(false);
		expect(m.runningIds()).toEqual([]);
		expect(await m.start({ repoPath: repo })).toMatchObject({ ok: false });
	});

	test("a setup failure closes the process and returns an error", async () => {
		const m = make(["--crash-after-ready"]);
		const res = await m.start({ repoPath: repo });
		expect(res.ok).toBe(false);
		expect(m.runningIds()).toEqual([]);
	});

	test("resume while the session is stopping spawns a fresh process instead of returning the dying one", async () => {
		const file = sessionFile("sess-3");
		const m = make(["--session-id", "sess-3"]);
		const first = await startOk(m, { repoPath: repo, sessionFile: file });
		const gate = Promise.withResolvers<void>();
		closeGate = gate.promise;
		try {
			const stopping = m.stop(first.id, "handoff");
			expect(m.snapshot(first.id)).toBeNull();
			expect(await m.deliver(first.id, { type: "prompt", clientId: "p1", text: "hi" })).toEqual({
				status: "error",
				error: "session_not_found",
			});
			const resumed = m.start({ repoPath: repo, sessionFile: file });
			gate.resolve();
			closeGate = null;
			const res = await resumed;
			expect(await stopping).toEqual({ ok: true, value: null });
			expect(res).toMatchObject({ ok: true, value: { id: "sess-3", running: true } });
			expect(spawnCalls).toBe(2);
			expect(alive(procs[0]!.pid)).toBe(false);
			expect(procs[1]!.exited).toBe(false);
			expect(m.runningIds()).toEqual(["sess-3"]);
			expect(m.snapshot("sess-3")).not.toBeNull();
		} finally {
			gate.resolve();
		}
	});

	test("two concurrent resumes of one session file spawn one process and share the result", async () => {
		const file = sessionFile("sess-4");
		const m = make(["--session-id", "sess-4"]);
		const [a, b] = await Promise.all([
			m.start({ repoPath: repo, sessionFile: file }),
			m.start({ repoPath: repo, sessionFile: file }),
		]);
		expect(spawnCalls).toBe(1);
		expect(a).toMatchObject({ ok: true, value: { id: "sess-4", running: true } });
		expect(b).toEqual(a);
		expect(m.runningIds()).toEqual(["sess-4"]);
	});

	test("a writer that appears during spawn wins: the new process is closed with open_at_laptop", async () => {
		const file = sessionFile("sess-5");
		grabAfterSpawn = file;
		const m = make(["--session-id", "sess-5"]);
		const res = await m.start({ repoPath: repo, sessionFile: file });
		expect(res).toMatchObject({ ok: false, error: { code: "open_at_laptop" } });
		expect(spawnCalls).toBe(1);
		expect(alive(procs[0]!.pid)).toBe(false);
		expect(m.runningIds()).toEqual([]);
	});

	test("a setup that never answers is killed at the deadline and returns setup_failed", async () => {
		hangCommand = "set_subagent_subscription";
		setupTimeoutMs = 300;
		const m = make();
		const res = await m.start({ repoPath: repo });
		expect(res).toMatchObject({ ok: false, error: { code: "setup_failed" } });
		expect(spawnCalls).toBe(1);
		expect(alive(procs[0]!.pid)).toBe(false);
		expect(m.runningIds()).toEqual([]);
	});

	test("shutdown during setup closes the process and the start fails with shutting_down", async () => {
		hangCommand = "set_subagent_subscription";
		const m = make();
		const starting = m.start({ repoPath: repo });
		await until(() => sent.some((c) => c.type === "set_subagent_subscription"));
		await m.shutdown();
		expect(alive(procs[0]!.pid)).toBe(false);
		expect(await starting).toMatchObject({ ok: false, error: { code: "shutting_down" } });
		expect(m.runningIds()).toEqual([]);
	});
});
