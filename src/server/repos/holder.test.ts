import { afterEach, describe, expect, test } from "bun:test";
import { isOmpProcess } from "./holder";

let children: Bun.Subprocess[] = [];

afterEach(async () => {
	for (const child of children) child.kill();
	await Promise.all(children.map((child) => child.exited));
	children = [];
});

/**
 * Waits for /proc to show the exec'd program: right after spawn the pid can still be the
 * pre-exec image, and /proc offers no event for an exec, so it is polled.
 */
async function started(argv: string[], program: string): Promise<number> {
	const child = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
	children.push(child);
	for (let i = 0; i < 500; i++) {
		const comm = await Bun.file(`/proc/${child.pid}/comm`)
			.text()
			.catch(() => "");
		if (comm.trim() === program) return child.pid;
		await Bun.sleep(10);
	}
	throw new Error(`${program} did not start`);
}

describe("isOmpProcess", () => {
	test("true for a process whose argv[0] is omp", async () => {
		const pid = await started(["bash", "-c", "exec -a omp sleep 30"], "sleep");
		expect(await isOmpProcess(pid)).toBe(true);
	});

	test("false for an ordinary process", async () => {
		const pid = await started(["sleep", "30"], "sleep");
		expect(await isOmpProcess(pid)).toBe(false);
	});

	test("false for a pid that does not exist", async () => {
		expect(await isOmpProcess(2 ** 22 + 1)).toBe(false);
	});
});
