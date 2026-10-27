import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, ServerMessage } from "../../shared/protocol";
import type { CommandView, ModelView, SessionSummary, TranscriptItem } from "../../shared/types";
import { createAlerter } from "../alerts";
import type { BurrowConfig } from "../config";
import { startOmpProcess } from "../omp/client";
import type { OmpCommand, OmpProcess, RpcResult } from "../omp/port";
import { idleEligible } from "../idle";
import { isSessionOpen } from "../repos/open-proc";
import { createSessionManager } from "./manager";
import type { SessionManagerPort } from "./port";

const FAKE = join(import.meta.dir, "../../../test/fake-omp.ts");

/** What the fake answers for the commands and models it ships with. */
const EXPECTED_COMMANDS: CommandView[] = [
	{
		name: "security",
		description: "Review code for vulnerabilities",
		hint: "<path or scope>",
		subcommands: [{ name: "audit", description: "Audit dependencies" }],
	},
	{ name: "clear", description: "Clear the conversation", hint: "", subcommands: [] },
];
const EXPECTED_MODELS: ModelView[] = [
	{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5", contextWindow: 200000, reasoning: true },
	{ provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku 4.5", contextWindow: 200000, reasoning: false },
];

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
/** How long adopt waits for a signalled holder; short so the give-up test stays fast. */
let adoptTimeoutMs: number;

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
	adoptTimeoutMs = 5000;
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
	for (const holder of holders) holder.kill("SIGKILL");
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
		adoptTimeoutMs,
		adoptPollMs: 20,
		watchPollMs: 20,
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

/** The `models` answers, in order; `messages` already filtered by type. */
function modelsReplies(): Array<Extract<ServerMessage, { type: "models" }>> {
	return messages("models") as Array<Extract<ServerMessage, { type: "models" }>>;
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

const userEntry = (id: string, text: string, parentId: string | null = null): string =>
	JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-12T10:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	});

/** watch() that must succeed, so a failure names itself instead of a null. */
async function watchOk(m: SessionManagerPort, file: string): Promise<SessionSummary> {
	const result = await m.watch(file);
	if (!result.ok) throw new Error(`watch failed: ${result.error.code} ${result.error.message}`);
	return result.value;
}

function sessionFile(name: string, cwd = repo): string {
	const file = join(sessionsDir, "folder", `${name}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: name, cwd })}\n`);
	return file;
}

/** Polls /proc like the resume test: there is no event for "another process opened the file". */
async function heldOpen(file: string): Promise<void> {
	for (let i = 0; i < 500 && !(await isSessionOpen(file)); i++) await Bun.sleep(10);
	expect(await isSessionOpen(file)).toBe(true);
}

/**
 * A process whose argv[0] is omp holding the file open, as an omp TUI at the host does.
 * `ignoreTerm` makes it survive SIGTERM. `read` keeps it waiting without a child that would inherit the fd.
 */
async function ompHolder(file: string, ignoreTerm = false): Promise<Bun.Subprocess> {
	const inner = `${ignoreTerm ? 'trap "" TERM; ' : ""}exec 3<"$0"; read -r _`;
	const holder = Bun.spawn(["bash", "-c", 'exec -a omp bash -c "$1" "$2"', "_", inner, file], {
		stdin: "pipe",
		stdout: "ignore",
		stderr: "ignore",
	});
	holders.push(holder);
	await heldOpen(file);
	return holder;
}

/** A holder that is not omp at all, standing in for a `tail -f` on the session file. */
async function otherHolder(file: string): Promise<Bun.Subprocess> {
	const holder = Bun.spawn(["bash", "-c", 'exec 3<"$0"; exec sleep 300', file], { stdout: "ignore", stderr: "ignore" });
	holders.push(holder);
	await heldOpen(file);
	return holder;
}

describe("start and deliver", () => {
	test("setup commands then one prompt with followUp, in order; a repeated client id sends one prompt", async () => {
		const m = make();
		const summary = await startOk(m);
		expect(summary).toMatchObject({ repo, repoName: "repo", running: true, status: "idle", openElsewhere: false });
		expect(m.heldIds()).toEqual([summary.id]);

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
		// The fake answers the command like a current omp by default, so tell it to reject
		// it the way an older runtime does.
		await procs[0]!.send({ type: "__queue", result: { fail: "Unknown command: abort_and_restore_queue" } });
		expect((await m.deliver(summary.id, { type: "abort", clientId: "a1" })).status).toBe("ok");
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

describe("state reads", () => {
	test("after setup the snapshot carries the model, thinking level, context usage, todos and commands from omp", async () => {
		const m = make();
		const summary = await startOk(m);
		const status = m.snapshot(summary.id)!.status;
		expect(status.model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" });
		expect(status.thinkingLevel).toBe("medium");
		expect(status.contextUsage).toEqual({ tokens: 1200, contextWindow: 200000, percent: 0.6 });
		expect(status.todos).toEqual([]);
		expect(status.goal).toBeNull();
		// The command list came from the frame omp pushes at startup, with no request.
		expect(m.snapshot(summary.id)!.commands).toEqual(EXPECTED_COMMANDS);
		expect(sent.some((c) => c.type === "get_available_commands")).toBe(false);
	});

	test("a second get_state after session_settled updates what it reports and keeps a field it omits", async () => {
		const m = make();
		const summary = await startOk(m);
		await procs[0]!.send({
			type: "__state",
			state: {
				model: { provider: "openai", id: "gpt-5", name: "GPT-5" },
				contextUsage: { tokens: 900, contextWindow: 100000, percent: 0.9 },
			},
		});
		const reads = sent.filter((c) => c.type === "get_state").length;
		await emitFrames([{ type: "session_settled" }]);
		await until(() => sent.filter((c) => c.type === "get_state").length > reads);
		await until(() => m.snapshot(summary.id)!.status.model?.id === "gpt-5");
		const status = m.snapshot(summary.id)!.status;
		expect(status.model).toEqual({ provider: "openai", id: "gpt-5", name: "GPT-5" });
		expect(status.contextUsage).toEqual({ tokens: 900, contextWindow: 100000, percent: 0.9 });
		// The second read omitted these, so the values the first read reported stand.
		expect(status.thinkingLevel).toBe("medium");
		expect(status.todos).toEqual([]);
	});

	test("a scripted available_commands_update frame pushes a commands message and the same list in a later snapshot", async () => {
		const m = make();
		const summary = await startOk(m);
		await emitFrames([
			{
				type: "available_commands_update",
				commands: [
					{
						name: "review",
						description: "Review a diff",
						input: { hint: "<commit>" },
						subcommands: [{ name: "quick", description: "Fast pass" }],
					},
				],
			},
		]);
		await until(() => messages("commands").length === 1);
		expect(messages("commands")[0]).toEqual({
			type: "commands",
			commands: [
				{
					name: "review",
					description: "Review a diff",
					hint: "<commit>",
					subcommands: [{ name: "quick", description: "Fast pass" }],
				},
			],
		});
		expect(m.snapshot(summary.id)!.commands).toEqual([
			{
				name: "review",
				description: "Review a diff",
				hint: "<commit>",
				subcommands: [{ name: "quick", description: "Fast pass" }],
			},
		]);
	});

	test("when no update frame arrives, setup asks get_available_commands and the list still lands in the snapshot", async () => {
		const m = make(["--no-commands-frame"]);
		const summary = await startOk(m);
		expect(log().filter((c) => c.type === "get_available_commands")).toHaveLength(1);
		expect(m.snapshot(summary.id)!.commands).toEqual(EXPECTED_COMMANDS);
	});

	test("list_models reads the models once in five minutes and answers thinking levels every time", async () => {
		const m = make();
		const summary = await startOk(m);
		expect((await m.deliver(summary.id, { type: "list_models", clientId: "m1" })).status).toBe("ok");
		expect((await m.deliver(summary.id, { type: "list_models", clientId: "m2" })).status).toBe("ok");
		const replies = modelsReplies();
		expect(replies).toHaveLength(2);
		expect(replies[0]!.models).toEqual(EXPECTED_MODELS);
		expect(replies[1]!.models).toEqual(EXPECTED_MODELS);
		expect(replies[0]!.thinkingLevels).toEqual(["off", "low", "medium", "high"]);
		expect(replies[1]!.thinkingLevels).toEqual(["off", "low", "medium", "high"]);
		// omp's own log of what it received: one model read, one levels read per request.
		expect(log().filter((c) => c.type === "get_available_models")).toHaveLength(1);
		expect(log().filter((c) => c.type === "get_available_thinking_levels")).toHaveLength(2);

		clock += 5 * 60_000 + 1;
		expect((await m.deliver(summary.id, { type: "list_models", clientId: "m3" })).status).toBe("ok");
		expect(modelsReplies()).toHaveLength(3);
		expect(log().filter((c) => c.type === "get_available_models")).toHaveLength(2);
	});

	test("the model list is capped at 400 entries", async () => {
		canned.get_available_models = {
			ok: true,
			data: {
				models: Array.from({ length: 450 }, (_, i) => ({
					id: `m${i}`,
					name: `Model ${i}`,
					provider: "p",
					contextWindow: 1000,
					reasoning: false,
				})),
			},
		};
		const m = make();
		const summary = await startOk(m);
		expect((await m.deliver(summary.id, { type: "list_models", clientId: "m1" })).status).toBe("ok");
		expect(modelsReplies()[0]!.models).toHaveLength(400);
	});

	test("todos and a goal from get_state reach the phone", async () => {
		const m = make();
		const summary = await startOk(m);
		await procs[0]!.send({
			type: "__state",
			state: {
				todoPhases: [
					{
						name: "Phase 1",
						tasks: [
							{ content: "write the test", status: "completed" },
							{ content: "implement", status: "in_progress" },
						],
					},
				],
				goal: { objective: "ship phase 1.5", state: "active" },
			},
		});
		await m.deliver(summary.id, { type: "refresh_state", clientId: "r1" });
		const status = m.snapshot(summary.id)!.status;
		expect(status.todos).toEqual([
			{
				name: "Phase 1",
				tasks: [
					{ content: "write the test", status: "completed" },
					{ content: "implement", status: "in_progress" },
				],
			},
		]);
		expect(status.goal).toEqual({ objective: "ship phase 1.5", state: "active" });
		// The read dropped the model, so the value the setup read reported stands.
		expect(status.model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" });
	});

	test("a failed model read reports itself in the models message and keeps the ack ok", async () => {
		canned.get_available_models = { ok: false, error: "no registry" };
		const m = make();
		const summary = await startOk(m);
		expect((await m.deliver(summary.id, { type: "list_models", clientId: "m1" })).status).toBe("ok");
		expect(modelsReplies()[0]).toEqual({
			type: "models",
			models: [],
			thinkingLevels: ["off", "low", "medium", "high"],
			error: "get_available_models failed: no registry",
		});
	});

	test("a failed get_state keeps the last status and the session stays usable", async () => {
		const m = make();
		const summary = await startOk(m);
		const before = m.snapshot(summary.id)!.status;
		canned.get_state = { ok: false, error: "boom" };
		const summaries = messages("session").length;
		await emitFrames([{ type: "session_settled" }]);
		// The summary after the read is the settle handler's last step, so its arrival
		// means the failed read was applied.
		await until(() => messages("session").length > summaries);
		expect(m.snapshot(summary.id)!.status).toEqual(before);
		expect(m.heldIds()).toEqual([summary.id]);
		delete canned.get_state;
		expect((await m.deliver(summary.id, { type: "prompt", clientId: "p1", text: "still here" })).status).toBe("ok");
		await until(() => log().some((c) => c.type === "prompt"));
		expect(log().filter((c) => c.type === "prompt")).toHaveLength(1);
	});

	test("refresh_state asks omp for get_state again and pushes the new status", async () => {
		const m = make();
		const summary = await startOk(m);
		await procs[0]!.send({ type: "__state", state: { thinkingLevel: "high" } });
		const reads = sent.filter((c) => c.type === "get_state").length;
		expect((await m.deliver(summary.id, { type: "refresh_state", clientId: "r1" })).status).toBe("ok");
		await until(() => m.snapshot(summary.id)!.status.thinkingLevel === "high");
		expect(sent.filter((c) => c.type === "get_state")).toHaveLength(reads + 1);
		expect(messages("status").at(-1)).toMatchObject({ status: { thinkingLevel: "high" } });
	});

	test("deltas and other events never trigger a state read", async () => {
		const m = make();
		const summary = await startOk(m);
		const reads = sent.filter((c) => c.type === "get_state").length;
		await emitFrames([
			{ type: "message_start", messageId: "m1", message: { role: "assistant", content: [] } },
			{ type: "message_update", messageId: "m1", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } },
			{ type: "message_end", messageId: "m1", message: { role: "assistant", content: [{ type: "text", text: "x" }] } },
			{ type: "agent_start" },
			{ type: "agent_end", yielded: true },
		]);
		// Frames on one stream are handled before the __emit reply resolves, so any
		// read they triggered is already on the wire.
		expect(sent.filter((c) => c.type === "get_state")).toHaveLength(reads);
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
		expect(refused).toMatchObject({ ok: false, error: { code: "open_elsewhere" } });
		expect(spawnCalls).toBe(0);
		const listed = await m.list();
		expect(listed.find((s) => s.sessionFile === file)).toMatchObject({ openElsewhere: true, running: false });

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

	test("adopt stops the omp holding the session, waits for the file, and resumes it with the transcript seeded", async () => {
		const file = sessionFile("sess-1");
		const holder = await ompHolder(file);
		const m = make(["--session-id", "sess-1"]);
		seedMessages = [
			{ role: "user", content: "first question" },
			{ role: "assistant", content: [{ type: "text", text: "first answer" }] },
		];
		const res = await m.adopt(file);
		expect(res).toMatchObject({
			ok: true,
			value: { id: "sess-1", sessionFile: file, running: true, openElsewhere: false, canTakeOver: false },
		});
		await holder.exited;
		expect(holder.signalCode).toBe("SIGTERM");
		expect(spawnCalls).toBe(1);
		expect(m.snapshot("sess-1")!.items.map((i) => [i.kind, i.text])).toEqual([
			["user", "first question"],
			["assistant", "first answer"],
		]);
	});

	test("adopt refuses a holder that is not omp and signals nothing", async () => {
		const file = sessionFile("sess-1");
		const holder = await otherHolder(file);
		const m = make();
		expect(await m.adopt(file)).toMatchObject({
			ok: false,
			error: { code: "holder_not_omp", message: "That session is held by sleep, not an omp process" },
		});
		expect(spawnCalls).toBe(0);
		expect(alive(holder.pid)).toBe(true);
	});

	test("adopt gives up when the holder ignores the signal, leaving it running", async () => {
		const file = sessionFile("sess-1");
		const holder = await ompHolder(file, true);
		adoptTimeoutMs = 300;
		const m = make();
		expect(await m.adopt(file)).toMatchObject({ ok: false, error: { code: "takeover_failed" } });
		expect(spawnCalls).toBe(0);
		expect(alive(holder.pid)).toBe(true);
		expect(await isSessionOpen(file)).toBe(true);
	});

	test("adopt with no holder resumes, and answers a session Burrow already runs without a second process", async () => {
		const file = sessionFile("sess-1");
		const m = make(["--session-id", "sess-1"]);
		expect(await m.adopt(file)).toMatchObject({ ok: true, value: { id: "sess-1", running: true } });
		expect(await m.adopt(file)).toMatchObject({ ok: true, value: { id: "sess-1", running: true } });
		expect(spawnCalls).toBe(1);
	});

	test("adopt refuses a file outside the sessions folder, or one for a repo not allowlisted, with no process started", async () => {
		const m = make();
		const stray = join(root, "stray.jsonl");
		writeFileSync(stray, `${JSON.stringify({ type: "session", id: "s", cwd: repo })}\n`);
		expect(await m.adopt(stray)).toMatchObject({ ok: false, error: { code: "invalid_session_file" } });
		expect(await m.adopt(join(sessionsDir, "folder", "missing.jsonl"))).toMatchObject({
			ok: false,
			error: { code: "invalid_session_file" },
		});
		const elsewhere = join(root, "elsewhere");
		mkdirSync(elsewhere);
		const foreign = sessionFile("foreign", elsewhere);
		expect(await m.adopt(foreign)).toMatchObject({ ok: false, error: { code: "repo_not_allowed" } });
		expect(spawnCalls).toBe(0);
	});

	test("list marks a session held by omp as one to take over, and no other row", async () => {
		const byOmp = sessionFile("by-omp");
		const byOther = sessionFile("by-other");
		const free = sessionFile("free");
		await ompHolder(byOmp);
		await otherHolder(byOther);
		const listed = await make().list();
		const row = (file: string) => listed.find((s) => s.sessionFile === file);
		expect(row(byOmp)).toMatchObject({ openElsewhere: true, canTakeOver: true });
		expect(row(byOther)).toMatchObject({ openElsewhere: true, canTakeOver: false });
		expect(row(free)).toMatchObject({ openElsewhere: false, canTakeOver: false });
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
		await until(() => m.heldIds().length === 0);
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
		expect(m.heldIds()).toEqual([]);
		expect(m.snapshot(summary.id)).toBeNull();
		const last = messages("session").at(-1) as { session: { running: boolean } };
		expect(last.session.running).toBe(false);

		const listed = await m.list();
		expect(listed.find((s) => s.sessionFile === file)).toMatchObject({ id: "sess-2", running: false, openElsewhere: false, status: "idle" });
		expect((await m.stop(summary.id, "handoff"))).toMatchObject({ ok: false, error: { code: "session_not_found" } });
		const again = await startOk(m, { repoPath: repo, sessionFile: file });
		expect(again.id).toBe("sess-2");
	});

	test("stop_session from the phone stops with handoff", async () => {
		const m = make();
		const summary = await startOk(m);
		expect((await m.deliver(summary.id, { type: "stop_session", clientId: "s1" })).status).toBe("ok");
		expect(m.heldIds()).toEqual([]);
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
		expect(m.heldIds()).toEqual([]);
		expect(await m.start({ repoPath: repo })).toMatchObject({ ok: false });
	});

	test("a setup failure closes the process and returns an error", async () => {
		const m = make(["--crash-after-ready"]);
		const res = await m.start({ repoPath: repo });
		expect(res.ok).toBe(false);
		expect(m.heldIds()).toEqual([]);
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
			expect(m.heldIds()).toEqual(["sess-3"]);
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
		expect(m.heldIds()).toEqual(["sess-4"]);
	});

	test("a writer that appears during spawn wins: the new process is closed with open_elsewhere", async () => {
		const file = sessionFile("sess-5");
		grabAfterSpawn = file;
		const m = make(["--session-id", "sess-5"]);
		const res = await m.start({ repoPath: repo, sessionFile: file });
		expect(res).toMatchObject({ ok: false, error: { code: "open_elsewhere" } });
		expect(spawnCalls).toBe(1);
		expect(alive(procs[0]!.pid)).toBe(false);
		expect(m.heldIds()).toEqual([]);
	});

	test("a setup that never answers is killed at the deadline and returns setup_failed", async () => {
		hangCommand = "set_subagent_subscription";
		setupTimeoutMs = 300;
		const m = make();
		const res = await m.start({ repoPath: repo });
		expect(res).toMatchObject({ ok: false, error: { code: "setup_failed" } });
		expect(spawnCalls).toBe(1);
		expect(alive(procs[0]!.pid)).toBe(false);
		expect(m.heldIds()).toEqual([]);
	});

	test("shutdown during setup closes the process and the start fails with shutting_down", async () => {
		hangCommand = "set_subagent_subscription";
		const m = make();
		const starting = m.start({ repoPath: repo });
		await until(() => sent.some((c) => c.type === "set_subagent_subscription"));
		await m.shutdown();
		expect(alive(procs[0]!.pid)).toBe(false);
		expect(await starting).toMatchObject({ ok: false, error: { code: "shutting_down" } });
		expect(m.heldIds()).toEqual([]);
	});
});

/** The phone messages this phase adds, with the omp command each one must produce. */
const MUTATIONS: Array<{ name: string; message: ClientMessage; command: Record<string, unknown> }> = [
	{
		name: "set_model",
		message: { type: "set_model", clientId: "set_model", provider: "anthropic", modelId: "claude-haiku-4-5" },
		command: { type: "set_model", provider: "anthropic", modelId: "claude-haiku-4-5" },
	},
	{ name: "cycle_model", message: { type: "cycle_model", clientId: "cycle_model" }, command: { type: "cycle_model" } },
	{
		name: "set_thinking",
		message: { type: "set_thinking", clientId: "set_thinking", level: "high" },
		command: { type: "set_thinking_level", level: "high" },
	},
	{
		name: "cycle_thinking",
		message: { type: "cycle_thinking", clientId: "cycle_thinking" },
		command: { type: "cycle_thinking_level" },
	},
	{ name: "compact", message: { type: "compact", clientId: "compact" }, command: { type: "compact" } },
	{
		name: "remove_queued",
		message: { type: "remove_queued", clientId: "remove_queued", text: "later", queue: "followUp" },
		command: { type: "remove_queued_message", message: "later", queue: "followUp" },
	},
	{
		name: "promote_queued",
		message: { type: "promote_queued", clientId: "promote_queued", text: "later" },
		command: { type: "promote_queued_message", message: "later" },
	},
	{
		name: "restore_queue",
		message: { type: "restore_queue", clientId: "restore_queue" },
		command: { type: "abort_and_restore_queue" },
	},
	{
		name: "cancel_subagent",
		message: { type: "cancel_subagent", clientId: "cancel_subagent", subagentId: "sa1" },
		command: { type: "cancel_subagent", subagentId: "sa1" },
	},
	{
		name: "steer_subagent",
		message: { type: "steer_subagent", clientId: "steer_subagent", subagentId: "sa1", message: "go left" },
		command: { type: "steer_subagent", subagentId: "sa1", message: "go left" },
	},
	{
		name: "rename_session",
		message: { type: "rename_session", clientId: "rename_session", name: "trip to Rome" },
		command: { type: "set_session_name", name: "trip to Rome" },
	},
	{
		name: "goal_action",
		message: { type: "goal_action", clientId: "goal_action", op: "pause" },
		command: { type: "goal", op: "pause" },
	},
	{
		name: "bash",
		message: { type: "bash", clientId: "bash", command: "git status --short" },
		command: { type: "bash", command: "git status --short" },
	},
];

/** The mutations whose success leaves the phone's status line stale. */
const READ_BACK: Record<string, true> = {
	set_model: true,
	cycle_model: true,
	set_thinking: true,
	cycle_thinking: true,
	compact: true,
	rename_session: true,
	goal_action: true,
};

/** The bash cards the phone was sent, in the order they were sent. */
function bashCards(): Array<{ type: string; item: TranscriptItem }> {
	const out: Array<{ type: string; item: TranscriptItem }> = [];
	for (const event of events) {
		const message = event.message;
		if (message.type !== "item" && message.type !== "item_update") continue;
		if (message.item.kind !== "bash") continue;
		out.push({ type: message.type, item: message.item });
	}
	return out;
}

describe("session mutations", () => {
	for (const { name, message, command } of MUTATIONS) {
		test(`${name} reaches omp as one ${String(command.type)} with only its documented payload`, async () => {
			const m = make();
			const summary = await startOk(m);
			expect(await m.deliver(summary.id, message)).toEqual({ status: "ok" });
			expect(log().filter((c) => c.type === command.type)).toEqual([{ id: expect.any(String), ...command }]);
		});
	}

	test("a state changing mutation re-reads get_state once; the others read none", async () => {
		const m = make();
		const summary = await startOk(m);
		const reads = () => log().filter((c) => c.type === "get_state").length;
		for (const { name, message } of MUTATIONS) {
			const before = reads();
			expect(await m.deliver(summary.id, message)).toEqual({ status: "ok" });
			expect(reads() - before).toBe(READ_BACK[name] === true ? 1 : 0);
		}
	});

	test("a resent mutation is answered duplicate and reaches omp once", async () => {
		const m = make();
		const summary = await startOk(m);
		const message: ClientMessage = { type: "cycle_model", clientId: "dupe" };
		expect(await m.deliver(summary.id, message)).toEqual({ status: "ok" });
		expect(await m.deliver(summary.id, message)).toEqual({ status: "duplicate" });
		expect(log().filter((c) => c.type === "cycle_model")).toHaveLength(1);
	});

	test("a malformed payload is an error ack, reaches no omp command and leaves the session alone", async () => {
		const m = make();
		const summary = await startOk(m);
		const bad: Array<Record<string, unknown>> = [
			{ type: "bash", clientId: "bad-bash" },
			{ type: "bash", clientId: "blank-bash", command: "   " },
			{ type: "remove_queued", clientId: "bad-queue", text: "later", queue: "pending" },
			{ type: "remove_queued", clientId: "no-text", queue: "steering" },
			{ type: "promote_queued", clientId: "bad-promote" },
			{ type: "goal_action", clientId: "bad-goal", op: "create" },
			{ type: "set_model", clientId: "bad-model", provider: "anthropic" },
			{ type: "set_thinking", clientId: "bad-level" },
			{ type: "cancel_subagent", clientId: "bad-cancel" },
			{ type: "steer_subagent", clientId: "bad-steer", subagentId: "sa1" },
			{ type: "rename_session", clientId: "bad-name", name: "" },
		];
		const before = log().length;
		for (const message of bad) {
			const delivery = await m.deliver(summary.id, message as unknown as ClientMessage);
			expect(delivery.status).toBe("error");
			expect(delivery.error).toBeTruthy();
		}
		expect(log()).toHaveLength(before);
		expect(bashCards()).toHaveLength(0);
		expect(m.snapshot(summary.id)!.queued).toEqual({ steering: [], followUp: [] });
	});

	test("a mutation for an unknown session answers session_not_found and touches no process", async () => {
		const m = make();
		const before = log().length;
		for (const { message } of MUTATIONS) {
			expect(await m.deliver("nope", message)).toEqual({ status: "error", error: "session_not_found" });
		}
		expect(log()).toHaveLength(before);
	});
});

describe("bash mode", () => {
	test("a bash card is announced running before the command answers, then updated in place", async () => {
		const m = make();
		const summary = await startOk(m);
		await procs[0]!.send({ type: "__bash", result: { output: "one\ntwo\n", exitCode: 0, delayMs: 30 } });
		const delivery = m.deliver(summary.id, { type: "bash", clientId: "b1", command: "printf 'one\\ntwo\\n'" });
		await until(() => bashCards().length > 0);
		const running = bashCards()[0]!;
		expect(running.type).toBe("item");
		expect(running.item.text).toBe("");
		expect(running.item.bash).toEqual({ command: "printf 'one\\ntwo\\n'", status: "running", exitCode: null });

		expect(await delivery).toEqual({ status: "ok" });
		const cards = bashCards();
		expect(cards.map((c) => c.type)).toEqual(["item", "item_update"]);
		expect(cards[1]!.item.id).toBe(running.item.id);
		expect(cards[1]!.item.bash).toEqual({ command: "printf 'one\\ntwo\\n'", status: "done", exitCode: 0 });
		expect(cards[1]!.item.text).toBe("one\ntwo\n");
		const inSnapshot = m.snapshot(summary.id)!.items.filter((item) => item.kind === "bash");
		expect(inSnapshot).toHaveLength(1);
		expect(inSnapshot[0]!.text).toBe("one\ntwo\n");
	});

	test("a non-zero exit code and a cancelled run both land as an error card", async () => {
		const m = make();
		const summary = await startOk(m);
		await procs[0]!.send({ type: "__bash", result: { output: "boom", exitCode: 2 } });
		expect((await m.deliver(summary.id, { type: "bash", clientId: "b1", command: "false" })).status).toBe("ok");
		expect(bashCards().at(-1)!.item.bash).toEqual({ command: "false", status: "error", exitCode: 2 });
		expect(bashCards().at(-1)!.item.text).toBe("boom");

		await procs[0]!.send({ type: "__bash", result: { output: "", exitCode: 130, cancelled: true } });
		expect((await m.deliver(summary.id, { type: "bash", clientId: "b2", command: "sleep 30" })).status).toBe("ok");
		expect(bashCards().at(-1)!.item.bash).toEqual({ command: "sleep 30", status: "error", exitCode: 130, cancelled: true });
	});

	test("output past the cap keeps the tail and says it was cut", async () => {
		const m = make();
		const summary = await startOk(m);
		const long = `${"a".repeat(9000)}END`;
		await procs[0]!.send({ type: "__bash", result: { output: long, exitCode: 0 } });
		expect((await m.deliver(summary.id, { type: "bash", clientId: "b1", command: "yes" })).status).toBe("ok");
		const cut = bashCards().at(-1)!.item.text;
		expect(cut.length).toBeLessThan(long.length);
		expect(cut.endsWith("END")).toBe(true);
		expect(cut).toContain("cut");

		await procs[0]!.send({ type: "__bash", result: { output: "short", exitCode: 0, truncated: true } });
		expect((await m.deliver(summary.id, { type: "bash", clientId: "b2", command: "seq" })).status).toBe("ok");
		const marked = bashCards().at(-1)!.item.text;
		expect(marked).toContain("cut");
		expect(marked.endsWith("short")).toBe(true);
	});

	test("a bash the runtime refuses turns the card into an error instead of hanging in running", async () => {
		const m = make();
		const summary = await startOk(m);
		await procs[0]!.send({ type: "__bash", result: { fail: "bash is disabled" } });
		expect(await m.deliver(summary.id, { type: "bash", clientId: "b1", command: "rm -rf /" })).toEqual({
			status: "error",
			error: "bash is disabled",
		});
		const cards = bashCards();
		expect(cards.map((c) => c.type)).toEqual(["item", "item_update"]);
		expect(cards[1]!.item.bash).toMatchObject({ status: "error", exitCode: null });
		expect(cards[1]!.item.text).toContain("bash is disabled");
	});

	test("a bash whose answer never arrives becomes an error when the process exits", async () => {
		const m = make();
		const summary = await startOk(m);
		await procs[0]!.send({ type: "__bash", result: { hold: true } });
		const delivery = m.deliver(summary.id, { type: "bash", clientId: "b1", command: "sleep 30" });
		await until(() => bashCards().length === 1);
		expect(bashCards()[0]!.item.bash).toMatchObject({ status: "running" });

		void procs[0]!.send({ type: "__exit", code: 1 });
		expect(await delivery).toEqual({ status: "error", error: "omp process exited" });
		const cards = bashCards();
		expect(cards).toHaveLength(2);
		expect(cards[1]!.type).toBe("item_update");
		expect(cards[1]!.item.id).toBe(cards[0]!.item.id);
		expect(cards[1]!.item.bash).toMatchObject({ status: "error" });
		expect(cards[1]!.item.text).toContain("omp process exited");
	});
});

describe("queue restore", () => {
	test("restore_queue empties the queue and hands the withdrawn texts back to the composer", async () => {
		const m = make();
		const summary = await startOk(m);
		await emitFrames([{ type: "queue_update", steering: [{ text: "steer me" }], followUp: ["later"] }]);
		await until(() => m.snapshot(summary.id)!.queued.followUp.length === 1);
		await procs[0]!.send({ type: "__queue", result: { steering: ["steer me"], followUp: [{ text: "later" }] } });

		expect(await m.deliver(summary.id, { type: "restore_queue", clientId: "q1" })).toEqual({ status: "ok" });
		expect(m.snapshot(summary.id)!.queued).toEqual({ steering: [], followUp: [] });
		expect(messages("queued").at(-1)).toEqual({ type: "queued", queued: { steering: [], followUp: [] } });
		expect(messages("queue_restored").at(-1)).toEqual({
			type: "queue_restored",
			steering: ["steer me"],
			followUp: ["later"],
		});
	});

	test("a runtime that rejects the restore leaves the queue as it is and acks error", async () => {
		const m = make();
		const summary = await startOk(m);
		await emitFrames([{ type: "queue_update", steering: ["steer me"], followUp: [] }]);
		await until(() => m.snapshot(summary.id)!.queued.steering.length === 1);
		await procs[0]!.send({ type: "__queue", result: { fail: "Unknown command: abort_and_restore_queue" } });

		expect(await m.deliver(summary.id, { type: "restore_queue", clientId: "q1" })).toEqual({
			status: "error",
			error: "Unknown command: abort_and_restore_queue",
		});
		expect(m.snapshot(summary.id)!.queued).toEqual({ steering: ["steer me"], followUp: [] });
		expect(messages("queue_restored")).toHaveLength(0);
	});
});

describe("session name and subagents", () => {
	test("rename_session pushes the new title in the session summary", async () => {
		const m = make();
		const summary = await startOk(m);
		expect((await m.deliver(summary.id, { type: "rename_session", clientId: "r1", name: "trip to Rome" })).status).toBe("ok");
		const last = messages("session").at(-1) as Extract<ServerMessage, { type: "session" }>;
		expect(last.session.title).toBe("trip to Rome");
		expect(m.snapshot(summary.id)!.session.title).toBe("trip to Rome");
	});

	test("subagent commands pass through and invent no state of their own", async () => {
		const m = make();
		const summary = await startOk(m);
		const before = m.snapshot(summary.id)!.subagents;
		expect((await m.deliver(summary.id, { type: "cancel_subagent", clientId: "c1", subagentId: "sa1" })).status).toBe("ok");
		expect((await m.deliver(summary.id, { type: "steer_subagent", clientId: "s1", subagentId: "sa1", message: "hurry" })).status).toBe(
			"ok",
		);
		expect(m.snapshot(summary.id)!.subagents).toEqual(before);
		expect(messages("subagents")).toHaveLength(0);
	});
});

describe("watch", () => {
	test("follows a session file another process holds, read only", async () => {
		const m = make();
		const file = sessionFile("w1");
		appendFileSync(file, `${userEntry("u1", "hello from the host")}\n`);
		await otherHolder(file);

		const summary = await watchOk(m, file);
		expect(summary).toMatchObject({
			id: "w1",
			repo,
			running: false,
			status: "idle",
			openElsewhere: true,
			canTakeOver: false,
			sessionFile: file,
		});
		const snapshot = m.snapshot(summary.id);
		expect(snapshot?.readOnly).toBe(true);
		expect(snapshot?.items.map((item) => item.text)).toEqual(["hello from the host"]);
		expect(snapshot?.dialog).toBeNull();
		expect(snapshot?.queued).toEqual({ steering: [], followUp: [] });
		expect(spawnCalls).toBe(0);
	});

	test("says the holder can be taken over when it is an omp", async () => {
		const m = make();
		const file = sessionFile("w2");
		await ompHolder(file);
		const summary = await watchOk(m, file);
		expect(summary).toMatchObject({ openElsewhere: true, canTakeOver: true });
	});

	test("a watched session takes no messages and starts no process", async () => {
		const m = make();
		const file = sessionFile("w3");
		await otherHolder(file);
		const summary = await watchOk(m, file);
		const delivery = await m.deliver(summary.id, { clientId: "c1", type: "prompt", text: "write something" });
		expect(delivery).toEqual({ status: "error", error: "read_only" });
		expect(spawnCalls).toBe(0);
		expect(sent).toEqual([]);
	});

	test("a line the host appends reaches the snapshot and the phone", async () => {
		const m = make();
		const file = sessionFile("w4");
		appendFileSync(file, `${userEntry("u1", "first")}\n`);
		await otherHolder(file);
		const summary = await watchOk(m, file);
		const seen: ServerMessage[] = [];
		m.subscribe((sessionId, message) => {
			if (sessionId === summary.id) seen.push(message);
		});

		appendFileSync(file, `${userEntry("u2", "second", "u1")}\n`);
		await until(() => (m.snapshot(summary.id)?.items.length ?? 0) === 2);
		expect(m.snapshot(summary.id)?.items.map((item) => item.text)).toEqual(["first", "second"]);
		expect(seen).toContainEqual({ type: "item", item: expect.objectContaining({ id: "u2", text: "second" }) });
	});

	test("a file the host rewrites replaces the phone's transcript", async () => {
		const m = make();
		const file = sessionFile("w5");
		appendFileSync(file, `${userEntry("u1", "before")}\n`);
		await otherHolder(file);
		const summary = await watchOk(m, file);
		const seen: ServerMessage[] = [];
		m.subscribe((sessionId, message) => {
			if (sessionId === summary.id) seen.push(message);
		});

		// omp rewrites through a stage and rename, which is what replaces the file here.
		const staged = `${file}.tmp`;
		writeFileSync(staged, `${JSON.stringify({ type: "session", version: 3, id: "w5", cwd: repo })}\n${userEntry("x1", "started over")}\n`);
		renameSync(staged, file);
		await until(() => m.snapshot(summary.id)?.items.map((item) => item.text).join() === "started over");
		expect(seen.some((message) => message.type === "snapshot")).toBe(true);
	});

	test("refuses a session Burrow already runs, and a file it may not read", async () => {
		const m = make();
		const file = sessionFile("w6");
		appendFileSync(file, `${userEntry("u1", "hello")}\n`);
		const started = await m.start({ repoPath: repo, sessionFile: file });
		expect(started).toMatchObject({ ok: true });

		expect(await m.watch(file)).toMatchObject({ ok: false, error: { code: "already_running" } });
		expect(await m.watch(join(root, "outside.jsonl"))).toMatchObject({
			ok: false,
			error: { code: "invalid_session_file" },
		});
		const notAllowed = join(sessionsDir, "folder", "elsewhere.jsonl");
		writeFileSync(notAllowed, `${JSON.stringify({ type: "session", version: 3, id: "elsewhere", cwd: join(root, "repo2") })}\n`);
		expect(await m.watch(notAllowed)).toMatchObject({ ok: false, error: { code: "repo_not_allowed" } });
		expect(spawnCalls).toBe(1);
	});

	test(
		"a holder appearing while watching reaches the phone, and so does it quitting",
		async () => {
			const m = make();
			const file = sessionFile("w8");
			appendFileSync(file, `${userEntry("u1", "hello")}\n`);
			const summary = await watchOk(m, file);
			expect(summary.canTakeOver).toBe(false);
			const seen: ServerMessage[] = [];
			m.subscribe((sessionId, message) => {
				if (sessionId === summary.id) seen.push(message);
			});

			const holder = await ompHolder(file);
			await until(() => m.snapshot(summary.id)?.session.canTakeOver === true, 15_000);
			expect(seen).toContainEqual({
				type: "session",
				session: expect.objectContaining({ canTakeOver: true, openElsewhere: true }),
			});

			holder.kill("SIGKILL");
			// Waiting on the stronger condition: a killed process can linger in the scan for a
			// moment, and the row must stop claiming a holder as well as a takeover.
			await until(() => m.snapshot(summary.id)?.session.openElsewhere === false, 15_000);
			expect(m.snapshot(summary.id)?.session.canTakeOver).toBe(false);
		},
		20_000,
	);

	test("an unattached watch is idle eligible, and stopping it leaves an ordinary session file", async () => {
		const m = make();
		const file = sessionFile("w7");
		appendFileSync(file, `${userEntry("u1", "hello")}\n`);
		await otherHolder(file);
		const summary = await watchOk(m, file);
		expect(idleEligible(m.snapshot(summary.id)!, 0)).toBe(true);
		expect(m.heldIds()).toEqual([summary.id]);

		expect(await m.stop(summary.id, "idle")).toMatchObject({ ok: true });
		expect(m.heldIds()).toEqual([]);
		expect(m.snapshot(summary.id)).toBeNull();
		expect((await m.list()).map((row) => row.id)).toContain(summary.id);
	});
});
