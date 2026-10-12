import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRecentSessions } from "./session-files";

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
	const list = await listRecentSessions(sessions, [repo], { limit: 2 });
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
