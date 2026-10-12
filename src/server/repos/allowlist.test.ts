import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRepos, resolveRepo } from "./allowlist";

let root: string;
let repo: string;
let outside: string;

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "burrow-allow-")));
	repo = join(root, "repo");
	outside = join(root, "outside");
	await mkdir(repo);
	await mkdir(outside);
});
afterEach(() => rm(root, { recursive: true, force: true }));

test("listRepos keeps existing directories and names them by basename", async () => {
	await writeFile(join(root, "file.txt"), "x");
	const link = join(root, "link");
	await symlink(repo, link);
	const repos = await listRepos([link, join(root, "missing"), join(root, "file.txt"), repo]);
	expect(repos).toEqual([{ path: repo, name: "repo" }]);
});

test("resolveRepo accepts an allowlisted path", async () => {
	const r = await resolveRepo([repo], repo);
	expect(r).toEqual({ ok: true, value: { path: repo, name: "repo" } });
});

test("resolveRepo rejects a .. segment", async () => {
	const r = await resolveRepo([repo], `${repo}/../repo`);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.error.code).toBe("repo_not_allowed");
});

test("resolveRepo rejects a symlink inside the repo pointing outside", async () => {
	const link = join(repo, "escape");
	await symlink(outside, link);
	const r = await resolveRepo([repo], link);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.error.code).toBe("repo_not_allowed");
});

test("resolveRepo accepts a symlink resolving to an allowlisted repo", async () => {
	const link = join(root, "alias");
	await symlink(repo, link);
	const r = await resolveRepo([repo], link);
	expect(r).toEqual({ ok: true, value: { path: repo, name: "repo" } });
});

test("resolveRepo rejects a non directory, a missing path and a subdirectory", async () => {
	const file = join(repo, "a.txt");
	await writeFile(file, "x");
	await mkdir(join(repo, "sub"));
	for (const p of [file, join(root, "nope"), join(repo, "sub")]) {
		const r = await resolveRepo([repo], p);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe("repo_not_allowed");
	}
});
