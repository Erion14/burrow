// The file index behind the phone's @ menu: what the session repo offers and
// how a typed query ranks it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFileIndexer, spawnGit, type FileListResponse, type GitRunner } from "./files";

let root: string;

async function write(rel: string, text = "x\n"): Promise<void> {
	const file = join(root, rel);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, text);
}

async function gitIn(dir: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

// Used by every assertion below; inlining it would bury the path lists.
function pathsOf(res: FileListResponse): string[] {
	return res.items.map((item) => item.path);
}

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "burrow-files-")));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("git checkout", () => {
	test("ignored files never appear and untracked files always do", async () => {
		await gitIn(root, "init", "-q", "-b", "main");
		await write("tracked.txt");
		await write(".gitignore", "ignored.txt\n");
		await write("ignored.txt");
		await gitIn(root, "add", "-A");
		await write("untracked.txt");

		const res = await createFileIndexer().list(root, "", 50);
		expect(pathsOf(res)).toContain("tracked.txt");
		expect(pathsOf(res)).toContain("untracked.txt");
		expect(pathsOf(res)).not.toContain("ignored.txt");
		expect(pathsOf(res).filter((p) => p.startsWith(".git/"))).toEqual([]);
	});
});

describe("child checkouts", () => {
	test("two child checkouts are prefixed and a plain child is not walked", async () => {
		await mkdir(join(root, "one"), { recursive: true });
		await mkdir(join(root, "two"), { recursive: true });
		await write("plain/notes.md");
		await gitIn(join(root, "one"), "init", "-q", "-b", "main");
		await write("one/a.txt");
		await gitIn(join(root, "one"), "add", "-A");
		await gitIn(join(root, "two"), "init", "-q", "-b", "main");
		await write("two/b.txt");
		await gitIn(join(root, "two"), "add", "-A");

		const res = await createFileIndexer().list(root, "", 50);
		expect(pathsOf(res)).toContain("one/a.txt");
		expect(pathsOf(res)).toContain("two/b.txt");
		expect(res.items.filter((item) => item.dir).map((item) => item.path)).toEqual(["one", "two"]);
		expect(pathsOf(res)).not.toContain("plain/notes.md");
	});
});

describe("walk", () => {
	test("skips the noisy directories and caps the depth", async () => {
		await write("src/foo.ts");
		await write("node_modules/pkg/index.js");
		await write("dist/bundle.js");
		await write("__pycache__/mod.pyc");
		const deep = "d0/d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11";
		await write(`${deep}/deep.txt`);
		await write("d0/d1/d2/d3/d4/d5/d6/ok.txt");

		const res = await createFileIndexer().list(root, "", 200);
		expect(pathsOf(res)).toContain("src/foo.ts");
		expect(pathsOf(res)).toContain("d0/d1/d2/d3/d4/d5/d6/ok.txt");
		expect(pathsOf(res).filter((p) => p.includes("node_modules"))).toEqual([]);
		expect(pathsOf(res).filter((p) => p.includes("dist/"))).toEqual([]);
		expect(pathsOf(res).filter((p) => p.includes("__pycache__"))).toEqual([]);
		expect(pathsOf(res).filter((p) => p.includes("deep.txt"))).toEqual([]);
	});
});

describe("ranking", () => {
	async function crafted(): Promise<void> {
		await gitIn(root, "init", "-q", "-b", "main");
		for (const p of ["we.txt", "we/inner.txt", "web/notes.md", "tools/sweep.txt", "w/exists.txt", "zzz.txt"]) {
			await write(p);
		}
		await gitIn(root, "add", "-A");
	}

	test("basename prefix, then basename substring, then path substring, then subsequence", async () => {
		await crafted();
		const res = await createFileIndexer().list(root, "we", 20);
		expect(pathsOf(res)).toEqual([
			"we",
			"web",
			"we.txt",
			"tools/sweep.txt",
			"we/inner.txt",
			"web/notes.md",
			"w/exists.txt",
		]);
	});

	test("truncated when the matches exceed the limit", async () => {
		await crafted();
		const res = await createFileIndexer().list(root, "we", 3);
		expect(pathsOf(res)).toEqual(["we", "web", "we.txt"]);
		expect(res.truncated).toBe(true);
		const miss = await createFileIndexer().list(root, "zzz", 20);
		expect(pathsOf(miss)).toEqual(["zzz.txt"]);
		expect(miss.truncated).toBe(false);
	});

	test("an empty query lists directories first, path ascending", async () => {
		await crafted();
		const res = await createFileIndexer().list(root, "", 3);
		expect(pathsOf(res)).toEqual(["tools", "w", "we"]);
		expect(res.truncated).toBe(true);
	});

	test("directories are derived so the menu can drill into them", async () => {
		await gitIn(root, "init", "-q", "-b", "main");
		await write("src/foo.ts");
		await write("src/nested/deep.ts");
		await gitIn(root, "add", "-A");

		const res = await createFileIndexer().list(root, "src", 20);
		expect(pathsOf(res)).toContain("src");
		expect(res.items.find((item) => item.path === "src")?.dir).toBe(true);
		expect(pathsOf(res)).toContain("src/foo.ts");
		expect(pathsOf(res)).toContain("src/nested");
		expect(pathsOf(res).indexOf("src")).toBeLessThan(pathsOf(res).indexOf("src/foo.ts"));
	});
});

describe("cache", () => {
	test("a second request inside the TTL does not run git again, after it does", async () => {
		await gitIn(root, "init", "-q", "-b", "main");
		await write("src/foo.ts");
		await gitIn(root, "add", "-A");
		let now = 0;
		const calls: string[] = [];
		const run: GitRunner = async (cwd, args) => {
			calls.push(args.join(" "));
			return spawnGit(cwd, args);
		};
		const indexer = createFileIndexer({ git: run, now: () => now });

		await indexer.list(root, "", 20);
		expect(calls.length).toBeGreaterThan(0);
		const built = calls.length;
		await indexer.list(root, "src", 20);
		expect(calls.length).toBe(built);

		now += 61_000;
		await indexer.list(root, "src", 20);
		expect(calls.length).toBeGreaterThan(built);
	});

	test("concurrent requests share one rebuild", async () => {
		await gitIn(root, "init", "-q", "-b", "main");
		await write("src/foo.ts");
		await gitIn(root, "add", "-A");
		const calls: string[] = [];
		const run: GitRunner = async (cwd, args) => {
			calls.push(args.join(" "));
			return spawnGit(cwd, args);
		};
		const indexer = createFileIndexer({ git: run });

		const [first, second] = await Promise.all([indexer.list(root, "", 20), indexer.list(root, "src", 20)]);
		expect(pathsOf(first)).toEqual(["src", "src/foo.ts"]);
		expect(pathsOf(second)).toEqual(["src", "src/foo.ts"]);
		expect(calls.length).toBe(2);
	});
});

describe("failures", () => {
	test("a git failure falls through to the walk", async () => {
		await write("src/foo.ts");
		const indexer = createFileIndexer({
			git: async () => ({ ok: false, error: { code: "git_failed", message: "no" } }),
		});
		expect(pathsOf(await indexer.list(root, "", 20))).toEqual(["src", "src/foo.ts"]);
	});

	test("a rebuild failure is an empty list, never a throw", async () => {
		await write("src/foo.ts");
		const indexer = createFileIndexer({
			walk: async () => ({ ok: false, error: { code: "walk_failed", message: "kaput" } }),
		});
		expect(await indexer.list(root, "", 20)).toEqual({ items: [], truncated: false });
		expect(await indexer.list(root, "src", 20)).toEqual({ items: [], truncated: false });
	});
});
