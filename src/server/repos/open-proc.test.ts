import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSessionOpen, sessionFileOwners } from "./open-proc";

let root: string;
let file: string;
let child: Bun.Subprocess | null = null;

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "burrow-proc-")));
	await mkdir(join(root, "folder"));
	file = join(root, "folder", "s.jsonl");
	await writeFile(file, "{}\n");
});
afterEach(async () => {
	child?.kill("SIGKILL");
	await child?.exited;
	child = null;
	await rm(root, { recursive: true, force: true });
});

function holdOpen(path: string): Bun.Subprocess {
	// The shell opens fd 3 via redirect, then sleeps: the same link omp leaves in /proc.
	return Bun.spawn(["sh", "-c", `exec 3<"$1"; exec sleep 60`, "sh", path], { stdout: "ignore", stderr: "ignore" });
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (await check()) return;
		await Bun.sleep(20);
	}
}

test("finds the child process holding a session file open", async () => {
	child = holdOpen(file);
	await waitFor(async () => (await sessionFileOwners(root)).has(file));
	const owners = await sessionFileOwners(root);
	expect(owners.get(file)).toBe(child.pid);
	expect(await isSessionOpen(file)).toBe(true);
});

test("a closed file has no owner", async () => {
	expect((await sessionFileOwners(root)).has(file)).toBe(false);
	expect(await isSessionOpen(file)).toBe(false);
});

test("skips ownPid and excludePids", async () => {
	child = holdOpen(file);
	await waitFor(async () => (await sessionFileOwners(root)).has(file));
	expect((await sessionFileOwners(root, { ownPid: child.pid })).has(file)).toBe(false);
	expect((await sessionFileOwners(root, { excludePids: new Set([child.pid]) })).has(file)).toBe(false);
	expect(await isSessionOpen(file, { ownPid: child.pid })).toBe(false);
});

test("ignores open files outside the sessions dir and non jsonl files", async () => {
	const txt = join(root, "folder", "s.txt");
	await writeFile(txt, "x");
	child = holdOpen(txt);
	await Bun.sleep(150);
	expect((await sessionFileOwners(root)).size).toBe(0);
	child.kill("SIGKILL");
	await child.exited;
	child = holdOpen(file);
	await waitFor(async () => (await sessionFileOwners(root)).has(file));
	expect((await sessionFileOwners(join(root, "other"))).size).toBe(0);
});
