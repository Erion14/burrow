import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDiff } from "./diff";
import type { DiffFile } from "../../shared/types";

let repo: string;

async function git(...args: string[]): Promise<void> {
	const p = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
	const code = await p.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
}

beforeEach(async () => {
	repo = await realpath(await mkdtemp(join(tmpdir(), "burrow-diff-")));
	await git("init", "-q", "-b", "main");
	await git("config", "user.email", "t@example.com");
	await git("config", "user.name", "T");
	await git("config", "commit.gpgsign", "false");
	await writeFile(join(repo, "mod.txt"), "one\ntwo\nthree\n");
	await writeFile(join(repo, "del.txt"), "gone\n");
	await writeFile(join(repo, "old-name.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n");
	await git("add", ".");
	await git("commit", "-q", "-m", "init");
});
afterEach(() => rm(repo, { recursive: true, force: true }));

const byPath = (files: DiffFile[], p: string) => files.find((f) => f.path === p);

test("reports modified, added, deleted, renamed, untracked and binary files", async () => {
	await writeFile(join(repo, "mod.txt"), "one\nTWO\nthree\nfour\n");
	await writeFile(join(repo, "added.txt"), "new\n");
	await git("add", "added.txt");
	await Bun.$`rm ${join(repo, "del.txt")}`;
	await git("mv", "old-name.txt", "new-name.txt");
	await writeFile(join(repo, "untracked.txt"), "u1\nu2\n");
	await writeFile(join(repo, "bin.dat"), new Uint8Array([0, 1, 2, 3, 0, 255, 0]));

	const res = await gitDiff(repo);
	expect(res.repo).toBe(repo);
	expect(res.truncated).toBe(false);

	const mod = byPath(res.files, "mod.txt");
	expect(mod).toMatchObject({ status: "modified", additions: 2, deletions: 1, binary: false });
	expect(mod?.unified.startsWith("@@")).toBe(true);
	expect(mod?.unified).not.toContain("diff --git");

	expect(byPath(res.files, "added.txt")).toMatchObject({ status: "added", additions: 1, deletions: 0 });
	expect(byPath(res.files, "del.txt")).toMatchObject({ status: "deleted", additions: 0, deletions: 1 });
	expect(byPath(res.files, "new-name.txt")).toMatchObject({ status: "renamed", binary: false });
	expect(byPath(res.files, "old-name.txt")).toBeUndefined();
	expect(byPath(res.files, "untracked.txt")).toMatchObject({ status: "untracked", additions: 2, deletions: 0 });
	expect(byPath(res.files, "untracked.txt")?.unified).not.toContain("diff --git");
	expect(byPath(res.files, "bin.dat")).toMatchObject({ status: "untracked", binary: true, unified: "" });
});

test("a clean repo has no files", async () => {
	expect(await gitDiff(repo)).toEqual({ repo, files: [], truncated: false });
});

test("binary tracked file change is flagged binary", async () => {
	await writeFile(join(repo, "b.bin"), new Uint8Array([0, 1, 2]));
	await git("add", "b.bin");
	await git("commit", "-q", "-m", "bin");
	await writeFile(join(repo, "b.bin"), new Uint8Array([0, 9, 9, 9]));
	expect(byPath((await gitDiff(repo)).files, "b.bin")).toMatchObject({ status: "modified", binary: true });
});

test("untracked files in new directories are listed individually", async () => {
	await Bun.$`mkdir -p ${join(repo, "d")}`;
	await writeFile(join(repo, "d", "x.txt"), "x\n");
	expect(byPath((await gitDiff(repo)).files, "d/x.txt")?.status).toBe("untracked");
});

test("caps each file and the whole response, setting truncated", async () => {
	const big = `${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}\n`;
	await writeFile(join(repo, "big1.txt"), big);
	await writeFile(join(repo, "big2.txt"), big);
	const perFile = await gitDiff(repo, { maxFileBytes: 300 });
	expect(perFile.truncated).toBe(true);
	for (const f of perFile.files) {
		expect(new TextEncoder().encode(f.unified).length).toBeLessThanOrEqual(300);
		expect(f.additions).toBe(200);
	}
	const total = await gitDiff(repo, { maxBytes: 1000 });
	expect(total.truncated).toBe(true);
	expect(total.files.reduce((n, f) => n + new TextEncoder().encode(f.unified).length, 0)).toBeLessThanOrEqual(1000);
});

test("a merge conflict is reported as conflict", async () => {
	await git("checkout", "-q", "-b", "other");
	await writeFile(join(repo, "mod.txt"), "other\n");
	await git("commit", "-qam", "other");
	await git("checkout", "-q", "main");
	await writeFile(join(repo, "mod.txt"), "main\n");
	await git("commit", "-qam", "main");
	await Bun.spawn(["git", "-C", repo, "merge", "other"], { stdout: "ignore", stderr: "ignore" }).exited;
	expect(byPath((await gitDiff(repo)).files, "mod.txt")?.status).toBe("conflict");
});

test("a missing directory throws; a plain repo has no notice", async () => {
	await expect(gitDiff(join(repo, "nope"))).rejects.toThrow(/does not exist/);
	expect("notice" in (await gitDiff(repo))).toBe(false);
});

describe("bounds", () => {
	async function untracked(count: number, dir = "out"): Promise<void> {
		await mkdir(join(repo, dir), { recursive: true });
		await Promise.all(Array.from({ length: count }, (_, i) => writeFile(join(repo, dir, `f${String(i).padStart(4, "0")}.txt`), `${i}\n`)));
	}

	test("a repo with many untracked files stops at the deadline and reports truncation", async () => {
		await untracked(800);
		const started = performance.now();
		const res = await gitDiff(repo, { deadlineMs: 150, maxUntrackedFiles: 10_000 });
		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(1500);
		expect(res.truncated).toBe(true);
		expect(res.notice).toMatch(/stopped after/);
		expect(res.files.length).toBeLessThan(800);
	});

	test("only the first untracked files are rendered past the count cap", async () => {
		await untracked(30);
		const res = await gitDiff(repo, { maxUntrackedFiles: 10 });
		const shown = res.files.filter((f) => f.status === "untracked");
		expect(shown.map((f) => f.path)).toEqual(Array.from({ length: 10 }, (_, i) => `out/f${String(i).padStart(4, "0")}.txt`));
		for (const f of shown) expect(f.additions).toBe(1);
		expect(res.truncated).toBe(true);
		expect(res.notice).toContain("10 of 30 untracked files");
	});

	test("untracked files over the size cap are skipped with a notice", async () => {
		await writeFile(join(repo, "huge.log"), "x\n".repeat(5000));
		await writeFile(join(repo, "small.txt"), "s\n");
		const res = await gitDiff(repo, { maxUntrackedFileBytes: 1000 });
		expect(byPath(res.files, "huge.log")).toBeUndefined();
		expect(byPath(res.files, "small.txt")).toMatchObject({ status: "untracked", additions: 1 });
		expect(res.notice).toContain("huge.log");
	});

	test("git output past the cap is cut and reported as truncated", async () => {
		await writeFile(join(repo, "mod.txt"), `${Array.from({ length: 2000 }, (_, i) => `changed ${i}`).join("\n")}\n`);
		const res = await gitDiff(repo, { maxOutputBytes: 2000 });
		expect(res.truncated).toBe(true);
		const mod = byPath(res.files, "mod.txt");
		expect(mod?.status).toBe("modified");
		expect(mod?.additions).toBeLessThan(2000);
		expect(res.notice).toMatch(/output/);
	});

	test("a workspace child's notes carry the child name", async () => {
		const ws = await realpath(await mkdtemp(join(tmpdir(), "burrow-ws-")));
		try {
			await makeRepo(join(ws, "one"), { "a.txt": "base\nz\n" });
			await writeFile(join(ws, "one", "huge.log"), "x\n".repeat(5000));
			const res = await gitDiff(ws, { maxUntrackedFileBytes: 1000 });
			expect(res.files.map((f) => f.path)).toEqual(["one/a.txt"]);
			expect(res.notice).toContain("one: ");
			expect(res.notice).toContain("huge.log");
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});
});

async function makeRepo(dir: string, files: Record<string, string>): Promise<void> {
	await mkdir(dir, { recursive: true });
	const run = async (...args: string[]) => {
		const p = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
		if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
	};
	await run("init", "-q", "-b", "main");
	await run("config", "user.email", "t@example.com");
	await run("config", "user.name", "T");
	await run("config", "commit.gpgsign", "false");
	for (const name of Object.keys(files)) await writeFile(join(dir, name), "base\n");
	await run("add", ".");
	await run("commit", "-q", "-m", "init");
	for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
}

describe("workspace directory", () => {
	let ws: string;
	beforeEach(async () => {
		ws = await realpath(await mkdtemp(join(tmpdir(), "burrow-ws-")));
	});
	afterEach(() => rm(ws, { recursive: true, force: true }));

	test("merges child repos with prefixed paths, ordered, ignoring nested and hidden ones", async () => {
		await makeRepo(join(ws, "zeta"), { "a.txt": "base\nz\n" });
		await makeRepo(join(ws, "alpha"), { "b.txt": "base\nx\n", "a.txt": "base\ny\n" });
		await makeRepo(join(ws, "deep", "inner"), { "n.txt": "base\nn\n" });
		await makeRepo(join(ws, ".hidden"), { "h.txt": "base\nh\n" });
		await mkdir(join(ws, "vault"));
		await writeFile(join(ws, "vault", "note.md"), "hi\n");
		const res = await gitDiff(ws);
		expect(res.files.map((f) => f.path)).toEqual(["alpha/a.txt", "alpha/b.txt", "zeta/a.txt"]);
		expect(byPath(res.files, "zeta/a.txt")).toMatchObject({ additions: 1, deletions: 0, status: "modified" });
		expect(res.truncated).toBe(false);
		expect(res.notice).toBe("not a git repository; showing 2 git repositories below");
	});

	test("no repositories gives an empty list and a notice", async () => {
		await mkdir(join(ws, "vault"));
		const res = await gitDiff(ws);
		expect(res.files).toEqual([]);
		expect(res.truncated).toBe(false);
		expect(res.notice).toMatch(/no git repositories/);
	});

	test("the response cap applies across children", async () => {
		const big = `base\n${"x".repeat(100)}\n`.repeat(50);
		await makeRepo(join(ws, "one"), { "f.txt": big });
		await makeRepo(join(ws, "two"), { "f.txt": big });
		const res = await gitDiff(ws, { maxBytes: 3000 });
		expect(res.truncated).toBe(true);
		const total = res.files.reduce((n, f) => n + new TextEncoder().encode(f.unified).length, 0);
		expect(total).toBeLessThanOrEqual(3000);
		expect(res.files.map((f) => f.path)).toEqual(["one/f.txt", "two/f.txt"]);
	});

	test("a child with a broken git adds a notice line instead of failing", async () => {
		await makeRepo(join(ws, "good"), { "a.txt": "base\nz\n" });
		await mkdir(join(ws, "broken"));
		await writeFile(join(ws, "broken", ".git"), "gitdir: /nonexistent/nowhere\n");
		const res = await gitDiff(ws);
		expect(res.files.map((f) => f.path)).toEqual(["good/a.txt"]);
		expect(res.notice).toContain("showing 1 git repository below");
		expect(res.notice).toContain("broken:");
	});
});
