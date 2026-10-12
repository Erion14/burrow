import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

test("a missing directory throws; a non repo throws with git stderr", async () => {
	await expect(gitDiff(join(repo, "nope"))).rejects.toThrow(/does not exist/);
	const plain = await realpath(await mkdtemp(join(tmpdir(), "burrow-nogit-")));
	try {
		await expect(gitDiff(plain)).rejects.toThrow(/not a git repository/);
	} finally {
		await rm(plain, { recursive: true, force: true });
	}
});
