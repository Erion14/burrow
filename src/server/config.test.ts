import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTailscaleIdentity, loadConfig, parseLineFile, splitCommand } from "./config";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "burrow-config-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const identity = { BURROW_OWNER_LOGIN: "me@example.com", BURROW_ORIGIN: "https://x.ts.net" };

describe("helpers", () => {
	test("parseLineFile skips blanks and trims", () => {
		expect(parseLineFile("  a  \n\n\t\nb\r\n   \nc")).toEqual(["a", "b", "c"]);
	});
	test("splitCommand splits on whitespace", () => {
		expect(splitCommand("  omp  --mode\trpc-ui \n")).toEqual(["omp", "--mode", "rpc-ui"]);
	});
});

describe("loadConfig", () => {
	test("honours every environment override", async () => {
		const cfg = await loadConfig({
			...identity,
			BURROW_PORT: "1111",
			BURROW_WAKE_PORT: "2222",
			BURROW_IDLE_TIMEOUT_MS: "3333",
			BURROW_OMP_COMMAND: "myomp --flag value",
			BURROW_SESSIONS_DIR: join(dir, "sessions"),
			BURROW_WEB_ROOT: join(dir, "web"),
			BURROW_CONFIG_DIR: dir,
		});
		expect(cfg.port).toBe(1111);
		expect(cfg.wakePort).toBe(2222);
		expect(cfg.idleTimeoutMs).toBe(3333);
		expect(cfg.ompCommand).toEqual(["myomp", "--flag", "value"]);
		expect(cfg.sessionsDir).toBe(join(dir, "sessions"));
		expect(cfg.webRoot).toBe(join(dir, "web"));
		expect(cfg.configDir).toBe(dir);
		expect(cfg.ownerLogin).toBe("me@example.com");
		expect(cfg.origin).toBe("https://x.ts.net");
	});

	test("repos file yields raw lines in order", async () => {
		const file = join(dir, "my-repos");
		writeFileSync(file, "/b/repo\n\n  /a/repo  \n/c\n");
		const cfg = await loadConfig({ ...identity, BURROW_REPOS_FILE: file, BURROW_NTFY_FILE: join(dir, "none") });
		expect(cfg.repos).toEqual(["/b/repo", "/a/repo", "/c"]);
	});

	test("repos and ntfy default to files under the config dir", async () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "repos"), "/x\n");
		writeFileSync(join(dir, "ntfy"), "https://ntfy.sh/topic\nignored\n");
		const cfg = await loadConfig({ ...identity, BURROW_CONFIG_DIR: dir });
		expect(cfg.repos).toEqual(["/x"]);
		expect(cfg.ntfyUrl).toBe("https://ntfy.sh/topic");
	});

	test("ntfy file first line is the url", async () => {
		const file = join(dir, "n");
		writeFileSync(file, "\nhttps://ntfy.sh/abc\nsecond\n");
		const cfg = await loadConfig({ ...identity, BURROW_NTFY_FILE: file, BURROW_REPOS_FILE: join(dir, "none") });
		expect(cfg.ntfyUrl).toBe("https://ntfy.sh/abc");
	});

	test("missing ntfy file gives null", async () => {
		const cfg = await loadConfig({
			...identity,
			BURROW_NTFY_FILE: join(dir, "missing"),
			BURROW_REPOS_FILE: join(dir, "missing2"),
		});
		expect(cfg.ntfyUrl).toBeNull();
		expect(cfg.repos).toEqual([]);
	});

	test("overridden owner and origin start no tailscale process", async () => {
		const emptyBin = join(dir, "emptybin");
		mkdirSync(emptyBin);
		const oldPath = process.env.PATH;
		process.env.PATH = emptyBin;
		try {
			const cfg = await loadConfig({ ...identity, BURROW_CONFIG_DIR: dir });
			expect(cfg.ownerLogin).toBe("me@example.com");
		} finally {
			process.env.PATH = oldPath;
		}
	});

	test("invalid BURROW_PORT throws", async () => {
		await expect(loadConfig({ ...identity, BURROW_CONFIG_DIR: dir, BURROW_PORT: "abc" })).rejects.toThrow();
	});
});

describe("detectTailscaleIdentity", () => {
	function status(login: string | null, dnsName: string | null): string {
		return JSON.stringify({
			Self: { UserID: login === null ? undefined : 42, DNSName: dnsName },
			User: login === null ? {} : { "42": { LoginName: login } },
		});
	}

	test("waits for tailscaled at boot and retries until an identity appears", async () => {
		const replies = [
			{ code: 0, stdout: JSON.stringify({ Self: {}, User: {} }), stderr: "" },
			{ code: 1, stdout: "", stderr: "tailscale is starting" },
			{ code: 0, stdout: status("owner@example.com", "host.tailnet.ts.net."), stderr: "" },
		];
		const sleeps: number[] = [];
		const identity = await detectTailscaleIdentity({
			run: async () => replies.shift()!,
			attempts: 5,
			delayMs: 25,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(identity).toEqual({ login: "owner@example.com", dnsName: "host.tailnet.ts.net" });
		expect(sleeps).toEqual([25, 25]);
	});

	test("gives up with the last reason after the attempts run out", async () => {
		await expect(
			detectTailscaleIdentity({
				run: async () => ({ code: 0, stdout: JSON.stringify({ Self: {}, User: {} }), stderr: "" }),
				attempts: 3,
				delayMs: 1,
				sleep: async () => {},
			}),
		).rejects.toThrow(/after 3 attempts/);
	});
});
