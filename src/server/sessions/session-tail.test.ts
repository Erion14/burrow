// The reader behind the read only view of a session held at the host: it follows a
// session file another omp process writes, so it reads only, never writes, and it
// must survive a file that changes under it.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTranscript, readHeader, readTail, type TailState } from "./session-tail";

let root: string;
let file: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "burrow-tail-")));
	file = join(root, "sess.jsonl");
});
afterEach(() => rm(root, { recursive: true, force: true }));

const fresh = (): TailState => ({ offset: 0, ino: null, mtimeMs: 0, truncated: false });
const titleSlot = () => JSON.stringify({ type: "title", title: "slot title" });
const header = () => JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/work/repo" });
const user = (id: string, text: string, parentId: string | null = null, ts = "2026-10-13T10:00:00.000Z") =>
	JSON.stringify({ type: "message", id, parentId, timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (id: string, parentId: string | null, content: unknown[], extra: Record<string, unknown> = {}) =>
	JSON.stringify({ type: "message", id, parentId, timestamp: "2026-10-13T10:00:05.000Z", message: { role: "assistant", content, ...extra } });
const toolResult = (id: string, parentId: string, callId: string, text: string, isError = false) =>
	JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-13T10:00:06.000Z",
		message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text }], isError },
	});

async function seed(lines: string[]): Promise<void> {
	await writeFile(file, `${lines.join("\n")}\n`);
}

function parsed(entries: unknown[]): Record<string, unknown>[] {
	return entries.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

test("reads every line of a fresh file and nothing on the next read", async () => {
	await seed([titleSlot(), header(), user("a1", "hello")]);
	const first = await readTail(file, fresh());
	expect(first.reset).toBe(false);
	expect(parsed(first.entries).map((entry) => entry.type)).toEqual(["title", "session", "message"]);
	const second = await readTail(file, first.state);
	expect(second.entries).toEqual([]);
	expect(second.state.offset).toBe(first.state.offset);
});

test("an incomplete trailing line waits for the rest of itself", async () => {
	await seed([header(), user("a1", "hello")]);
	await appendFile(file, '{"type":"message","id":"a2","pare');
	const first = await readTail(file, fresh());
	expect(parsed(first.entries).map((entry) => entry.id)).toEqual(["s1", "a1"]);

	await appendFile(file, 'ntId":"a1","timestamp":"2026-10-13T10:00:09.000Z","message":{"role":"user","content":"second"}}\n');
	const second = await readTail(file, first.state);
	expect(parsed(second.entries).map((entry) => entry.id)).toEqual(["a2"]);
	expect(parsed(second.entries)[0]?.parentId).toBe("a1");
});

test("a file rewritten shorter starts over", async () => {
	await seed([header(), user("a1", "one"), user("a2", "two", "a1")]);
	const first = await readTail(file, fresh());
	expect(first.entries).toHaveLength(3);
	await seed([header(), user("b1", "only")]);
	const second = await readTail(file, first.state);
	expect(second.reset).toBe(true);
	expect(parsed(second.entries).map((entry) => entry.id)).toEqual(["s1", "b1"]);
});

test("an edit in place that changes no size starts over", async () => {
	await seed([header(), user("a1", "one")]);
	const first = await readTail(file, fresh());
	await seed([header(), user("a1", "two")]);
	const second = await readTail(file, first.state);
	expect(second.reset).toBe(true);
	expect(parsed(second.entries).at(-1)?.id).toBe("a1");
});

test("a malformed line is skipped without losing the lines around it", async () => {
	await seed([header(), '{"type":"message", broken', user("a1", "hello")]);
	const read = await readTail(file, fresh());
	expect(parsed(read.entries).map((entry) => entry.id)).toEqual(["s1", "a1"]);
});

test("a missing file is not an error and is picked up once it appears", async () => {
	const absent = await readTail(join(root, "nope.jsonl"), fresh());
	expect(absent.entries).toEqual([]);
	expect(absent.reset).toBe(false);
	await seed([header(), user("a1", "hello")]);
	const present = await readTail(file, fresh());
	expect(parsed(present.entries)).toHaveLength(2);
});

test("a window smaller than the file starts on a line boundary and says it truncated", async () => {
	const lines = [header()];
	for (let i = 0; i < 6; i += 1) lines.push(user(`a${i}`, `${i}`.repeat(400), i === 0 ? null : `a${i - 1}`));
	await seed(lines);
	const read = await readTail(file, fresh(), { windowBytes: 800 });
	expect(read.state.truncated).toBe(true);
	expect(read.entries.length).toBeGreaterThan(0);
	// Every returned line is whole: the window never starts in the middle of one.
	expect(parsed(read.entries).length).toBe(read.entries.length);
	expect(parsed(read.entries).at(-1)?.id).toBe("a5");
});

test("the header reads id, cwd and the title the slot carries", async () => {
	await seed([titleSlot(), header(), user("a1", "hello")]);
	expect(await readHeader(file)).toEqual({ id: "s1", cwd: "/work/repo", title: "slot title" });
});

test("a title on the header itself wins over the slot", async () => {
	await seed([titleSlot(), JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/work/repo", title: "own title" })]);
	expect((await readHeader(file))?.title).toBe("own title");
});

test("a file with no header has none to read", async () => {
	await seed([user("a1", "hello")]);
	expect(await readHeader(file)).toBeNull();
	expect(await readHeader(join(root, "absent.jsonl"))).toBeNull();
});

test("user and assistant messages become items, thinking included", () => {
	const entries = [
		JSON.parse(header()),
		JSON.parse(user("a1", "write the parser")),
		JSON.parse(assistant("a2", "a1", [{ type: "thinking", thinking: "think first" }, { type: "text", text: "Done." }])),
	];
	const built = buildTranscript(entries);
	expect(built.items.map((item) => [item.kind, item.text, item.thinking])).toEqual([
		["user", "write the parser", ""],
		["assistant", "Done.", "think first"],
	]);
	expect(built.items.map((item) => item.id)).toEqual(["a1", "a2"]);
	expect(built.items[0]?.createdAt).toBe("2026-10-13T10:00:00.000Z");
	expect(built.truncated).toBe(false);
});

test("a tool call becomes one card, running until its result lands", () => {
	const call = JSON.parse(assistant("a2", "a1", [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } }]));
	const result = JSON.parse(toolResult("a3", "a2", "c1", "file-a\nfile-b\n"));
	const waiting = buildTranscript([JSON.parse(header()), JSON.parse(user("a1", "list")), call]);
	expect(waiting.items.map((item) => [item.kind, item.tool?.status, item.tool?.output])).toEqual([["user", undefined, undefined], ["tool", "running", ""]]);
	expect(waiting.items[1]?.tool?.name).toBe("bash");
	expect(waiting.items[1]?.tool?.args).toContain("ls -la");

	const done = buildTranscript([JSON.parse(header()), JSON.parse(user("a1", "list")), call, result]);
	expect(done.items).toHaveLength(2);
	expect(done.items[1]?.tool?.status).toBe("done");
	expect(done.items[1]?.tool?.output).toContain("file-b");

	const failed = buildTranscript([JSON.parse(header()), JSON.parse(user("a1", "list")), call, JSON.parse(toolResult("a3", "a2", "c1", "boom", true))]);
	expect(failed.items[1]?.tool?.status).toBe("error");
});

test("a bash execution becomes a terminal card", () => {
	const entry = JSON.parse(
		JSON.stringify({
			type: "message",
			id: "b1",
			parentId: null,
			timestamp: "2026-10-13T10:00:02.000Z",
			message: { role: "bashExecution", command: "git status --short", output: " M src/a.ts\n", exitCode: 0 },
		}),
	);
	const built = buildTranscript([JSON.parse(header()), entry]);
	expect(built.items.map((item) => [item.kind, item.bash?.command, item.bash?.exitCode, item.bash?.status])).toEqual([
		["bash", "git status --short", 0, "done"],
	]);
	expect(built.items[0]?.text).toContain("M src/a.ts");
});

test("only the chain from the last entry is rendered", () => {
	const entries = [
		JSON.parse(header()),
		JSON.parse(user("a1", "first")),
		JSON.parse(assistant("a2", "a1", [{ type: "text", text: "abandoned branch" }])),
		JSON.parse(user("b1", "second", "a1")),
	];
	const built = buildTranscript(entries);
	expect(built.items.map((item) => item.text)).toEqual(["first", "second"]);
});

test("a reset boundary hides what came before it", () => {
	const entries = [
		JSON.parse(header()),
		JSON.parse(user("a1", "before the clear")),
		JSON.parse(JSON.stringify({ type: "reset_boundary", id: "r1", parentId: "a1", timestamp: "2026-10-13T10:00:07.000Z" })),
		JSON.parse(user("a2", "after the clear", "r1")),
	];
	expect(buildTranscript(entries).items.map((item) => item.text)).toEqual(["after the clear"]);
});

test("metadata entries render nothing and a compaction renders a notice", () => {
	const entries = [
		JSON.parse(header()),
		JSON.parse(JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: "2026-10-13T10:00:01.000Z", model: "x/y" })),
		JSON.parse(JSON.stringify({ type: "label", id: "l1", parentId: "m1", timestamp: "2026-10-13T10:00:02.000Z", targetId: "m1", label: "checkpoint" })),
		JSON.parse(JSON.stringify({ type: "custom", id: "c1", parentId: "l1", timestamp: "2026-10-13T10:00:03.000Z", customType: "x.y", data: {} })),
	];
	expect(buildTranscript(entries).items).toEqual([]);

	const compacted = buildTranscript([
		...entries,
		JSON.parse(JSON.stringify({ type: "compaction", id: "k1", parentId: "c1", timestamp: "2026-10-13T10:00:04.000Z", summary: "Everything so far, briefly." })),
	]);
	expect(compacted.items.map((item) => [item.kind, item.text])).toEqual([["notice", "Everything so far, briefly."]]);
});

test("the item cap keeps the end and marks the snapshot truncated", () => {
	const entries = [JSON.parse(header())];
	for (let i = 0; i < 5; i += 1) entries.push(JSON.parse(user(`u${i}`, `message ${i}`, i === 0 ? null : `u${i - 1}`)));
	const built = buildTranscript(entries, { itemLimit: 2 });
	expect(built.items.map((item) => item.text)).toEqual(["message 3", "message 4"]);
	expect(built.truncated).toBe(true);
});

test("status is taken from the last model, thinking level and usage in the file", () => {
	const entries = [
		JSON.parse(header()),
		JSON.parse(user("a1", "hello")),
		JSON.parse(
			assistant("a2", "a1", [{ type: "text", text: "hi" }], {
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: { input: 10, output: 5, totalTokens: 15 },
			}),
		),
		JSON.parse(JSON.stringify({ type: "thinking_level_change", id: "t1", parentId: "a2", timestamp: "2026-10-13T10:00:07.000Z", thinkingLevel: "high" })),
	];
	const built = buildTranscript(entries);
	expect(built.status.model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5", name: "claude-sonnet-4-5" });
	expect(built.status.thinkingLevel).toBe("high");
	expect(built.status.status).toBe("idle");
	expect(built.status.isSettled).toBe(true);
});
