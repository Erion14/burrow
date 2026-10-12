import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEAD_BYTES, listRecentSessions, sessionFileStats } from "./session-files";

let root: string;
let repo: string;
let other: string;
let sessions: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "burrow-sess-")));
	repo = join(root, "repo");
	other = join(root, "other");
	sessions = join(root, "sessions");
	await mkdir(repo);
	await mkdir(other);
	await mkdir(sessions);
});
afterEach(() => rm(root, { recursive: true, force: true }));

const header = (id: string, cwd: string) => JSON.stringify({ type: "session", version: 3, id, cwd });
const user = (text: string) =>
	JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });

async function session(folder: string, name: string, lines: string[], mtimeSec?: number): Promise<string> {
	await mkdir(join(sessions, folder), { recursive: true });
	const file = join(sessions, folder, `${name}.jsonl`);
	await writeFile(file, `${lines.join("\n")}\n`);
	if (mtimeSec !== undefined) await utimes(file, mtimeSec, mtimeSec);
	return file;
}

test("filters by header cwd, never by folder name", async () => {
	const good = await session("--totally-wrong-folder--", "a", [header("a", repo), user("hi")]);
	await session("--home-erioni-repo--", "b", [header("b", other), user("hi")]);
	await session("--x--", "c", [user("no header here")]);
	const list = await listRecentSessions(sessions, [repo]);
	expect(list.map((s) => s.sessionFile)).toEqual([good]);
	expect(list[0]).toMatchObject({ sessionId: "a", cwd: repo });
});

test("title comes from the title line, even before the header", async () => {
	await session("f", "a", [JSON.stringify({ type: "title", title: "My Title" }), header("a", repo), user("hello")]);
	expect((await listRecentSessions(sessions, [repo]))[0]?.title).toBe("My Title");
});

test("title falls back to the first user message truncated to 60 chars, skipping empty titles", async () => {
	await session("f", "a", [header("a", repo), JSON.stringify({ type: "title", title: "" }), user("x".repeat(100))]);
	expect((await listRecentSessions(sessions, [repo]))[0]?.title).toBe("x".repeat(60));
});

test("title falls back to the session id", async () => {
	await session("f", "a", [header("sid-1", repo)]);
	expect((await listRecentSessions(sessions, [repo]))[0]?.title).toBe("sid-1");
});

test("sorts by mtime descending, caps at limit, reports ISO updatedAt", async () => {
	await session("f", "old", [header("old", repo)], 1_700_000_000);
	await session("f", "new", [header("new", repo)], 1_800_000_000);
	await session("g", "mid", [header("mid", repo)], 1_750_000_000);
	const list = await listRecentSessions(sessions, [repo], { limit: 2, maxAgeDays: Infinity });
	expect(list.map((s) => s.sessionId)).toEqual(["new", "mid"]);
	expect(list[0]?.updatedAt).toBe(new Date(1_800_000_000_000).toISOString());
});

test("maxAgeDays drops old files; missing sessions dir yields empty", async () => {
	await session("f", "old", [header("old", repo)], 1_000_000_000);
	await session("f", "new", [header("new", repo)]);
	const list = await listRecentSessions(sessions, [repo], { maxAgeDays: 7 });
	expect(list.map((s) => s.sessionId)).toEqual(["new"]);
	expect(await listRecentSessions(join(root, "nope"), [repo])).toEqual([]);
});

test("default maxAgeDays is 30, judged against the injected clock", async () => {
	const now = 1_800_000_000_000;
	await session("f", "fresh", [header("fresh", repo)], now / 1000 - 29 * 86400);
	await session("f", "stale", [header("stale", repo)], now / 1000 - 31 * 86400);
	const list = await listRecentSessions(sessions, [repo], { now: () => now });
	expect(list.map((s) => s.sessionId)).toEqual(["fresh"]);
});

test("a file older than maxAgeDays is skipped without being read", async () => {
	const now = 1_800_000_000_000;
	await session("f", "old", [header("old", repo)], now / 1000 - 40 * 86400);
	const before = sessionFileStats.headReads;
	expect(await listRecentSessions(sessions, [repo], { now: () => now })).toEqual([]);
	expect(sessionFileStats.headReads).toBe(before);
});

test("maxFiles keeps the newest files by mtime", async () => {
	const now = 1_800_000_000;
	for (let i = 0; i < 5; i++) await session("f", `s${i}`, [header(`s${i}`, repo)], now - 1000 + i);
	const before = sessionFileStats.headReads;
	const list = await listRecentSessions(sessions, [repo], { maxFiles: 2, now: () => now * 1000 });
	expect(list.map((s) => s.sessionId)).toEqual(["s4", "s3"]);
	expect(sessionFileStats.headReads - before).toBe(2);
});

test("a second call with unchanged files reads nothing; a changed file is re-read", async () => {
	const file = await session("f", "a", [header("a", repo), user("one")]);
	await session("f", "b", [header("b", repo)]);
	const first = await listRecentSessions(sessions, [repo]);
	const reads = sessionFileStats.headReads;
	expect(await listRecentSessions(sessions, [repo])).toEqual(first);
	expect(sessionFileStats.headReads).toBe(reads);
	await writeFile(file, `${[header("a", repo), user("two two")].join("\n")}\n`);
	const again = await listRecentSessions(sessions, [repo]);
	expect(sessionFileStats.headReads).toBe(reads + 1);
	expect(again.find((s) => s.sessionId === "a")?.title).toBe("two two");
});

test("a file deleted between calls does not throw", async () => {
	const gone = await session("f", "gone", [header("gone", repo)]);
	await session("f", "kept", [header("kept", repo)]);
	expect((await listRecentSessions(sessions, [repo])).length).toBe(2);
	await rm(gone);
	expect((await listRecentSessions(sessions, [repo])).map((s) => s.sessionId)).toEqual(["kept"]);
});

test("header at the top of a huge file yields id and cwd; content beyond HEAD_BYTES is ignored", async () => {
	const filler = JSON.stringify({ type: "message", message: { role: "assistant", content: "z".repeat(1000) } });
	const lines = [header("big", repo)];
	while (lines.join("\n").length < HEAD_BYTES * 2) lines.push(filler);
	lines.push(JSON.stringify({ type: "title", title: "Far Title" }));
	await session("f", "big", lines);
	const [s] = await listRecentSessions(sessions, [repo]);
	expect(s).toMatchObject({ sessionId: "big", cwd: repo, title: "big" });
});

test("a session whose header cwd is outside the allowlist stays filtered after caching", async () => {
	await session("f", "o", [header("o", other)]);
	expect(await listRecentSessions(sessions, [repo])).toEqual([]);
	expect(await listRecentSessions(sessions, [repo])).toEqual([]);
});
