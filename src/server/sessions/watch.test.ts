// The watcher keeps one session file's items in memory and reports what changed,
// so the manager can push those changes to a phone without ever writing back.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatcher, type WatchUpdate } from "./watch";

let root: string;
let file: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "burrow-watch-")));
	file = join(root, "sess.jsonl");
});
afterEach(() => rm(root, { recursive: true, force: true }));

const header = (id = "s1") => JSON.stringify({ type: "session", version: 3, id, cwd: "/work/repo" });
const user = (id: string, text: string, parentId: string | null = null) =>
	JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-13T10:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	});
const call = (id: string, parentId: string, callId: string) =>
	JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-13T10:00:05.000Z",
		message: {
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: "ls" } }],
		},
	});
const result = (id: string, parentId: string, callId: string, text: string) =>
	JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-13T10:00:06.000Z",
		message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text }] },
	});

async function seed(lines: string[]): Promise<void> {
	await writeFile(file, `${lines.join("\n")}\n`);
}

test("the first read brings the transcript and the next poll finds nothing", async () => {
	await seed([header(), user("a1", "hello"), user("a2", "again", "a1")]);
	const watcher = await createWatcher({ file });
	expect(watcher.items().map((item) => item.text)).toEqual(["hello", "again"]);
	expect(watcher.poll()).resolves.toEqual([]);
	expect(watcher.status().model).toBeUndefined();
});

test("an appended message arrives as one new item", async () => {
	await seed([header(), user("a1", "hello")]);
	const watcher = await createWatcher({ file });
	await appendFile(file, `${user("a2", "second", "a1")}\n`);
	const updates = await watcher.poll();
	expect(updates).toHaveLength(1);
	expect(updates[0]).toEqual({ kind: "items", added: [expect.objectContaining({ id: "a2", kind: "user", text: "second" })] });
	expect(watcher.items().map((item) => item.text)).toEqual(["hello", "second"]);
});

test("a tool result updates the card that is already on screen", async () => {
	await seed([header(), call("a1", "s1", "c1")]);
	const watcher = await createWatcher({ file });
	expect(watcher.items().map((item) => [item.kind, item.tool?.status])).toEqual([["tool", "running"]]);

	await appendFile(file, `${result("a2", "a1", "c1", "file-a\n")}\n`);
	const updates = await watcher.poll();
	expect(updates).toHaveLength(1);
	expect(updates[0]?.kind).toBe("update");
	const item = (updates[0] as { kind: "update"; item: { id: string; tool?: { status: string; output: string } } }).item;
	expect(item.id).toBe("tool:c1");
	expect(item.tool?.status).toBe("done");
	expect(item.tool?.output).toContain("file-a");
});

test("a rewritten file asks for a fresh snapshot instead of a diff", async () => {
	await seed([header(), user("a1", "hello"), user("a2", "again", "a1")]);
	const watcher = await createWatcher({ file });
	await seed([header(), user("b1", "started over")]);
	const updates = await watcher.poll();
	expect(updates).toEqual([{ kind: "reset" }]);
	expect(watcher.items().map((item) => item.text)).toEqual(["started over"]);
});

test("a poll that finds no new bytes reports nothing", async () => {
	await seed([header(), user("a1", "hello")]);
	const watcher = await createWatcher({ file });
	await watcher.poll();
	await watcher.poll();
	expect(await watcher.poll()).toEqual([]);
});

test("the status follows the last model the file names", async () => {
	await seed([header(), user("a1", "hello"), call("a2", "a1", "c1"), result("a3", "a2", "c1", "out")]);
	const watcher = await createWatcher({ file });
	expect(watcher.status().model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5", name: "claude-sonnet-4-5" });
	expect(watcher.status().isSettled).toBe(true);
});

test("a file deleted under the watcher keeps the transcript it already had", async () => {
	await seed([header(), user("a1", "hello")]);
	const watcher = await createWatcher({ file });
	await rm(file);
	expect(await watcher.poll()).toEqual([]);
	expect(watcher.items().map((item) => item.text)).toEqual(["hello"]);
});
