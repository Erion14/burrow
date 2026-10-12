import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Server } from "bun";
import type { BurrowConfig } from "../server/config";
import { createWakeServer } from "./server";

const OWNER = "owner@example.com";
const config = { ownerLogin: OWNER, origin: "https://laptop.tailnet.ts.net", wakePort: 0 } as BurrowConfig;

let server: Server<undefined> | null = null;

afterEach(() => {
	server?.stop(true);
	server = null;
});

function start(runner: (action: "on" | "off") => Promise<void>) {
	server = createWakeServer(config, runner);
	return `http://127.0.0.1:${server.port}`;
}

const identity = { "Tailscale-User-Login": OWNER };
const auth = { ...identity, Origin: config.origin };

describe("wake server", () => {
	test("denies requests without identity and does not run", async () => {
		const calls: string[] = [];
		const base = start(async (a) => void calls.push(a));
		const res = await fetch(`${base}/wake`, { method: "POST" });
		expect(res.status).toBe(403);
		expect((await res.json()).error.code).toBe("forbidden_identity");
		expect(calls).toEqual([]);
	});

	test("on request runs the runner once", async () => {
		const calls: string[] = [];
		const base = start(async (a) => void calls.push(a));
		const res = await fetch(`${base}/wake`, { method: "POST", headers: auth });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(calls).toEqual(["on"]);
	});

	test("tolerates the tailscale prefix and alternate on paths", async () => {
		const calls: string[] = [];
		const base = start(async (a) => void calls.push(a));
		for (const p of ["/", "/wake/on", "/prefix/wake"]) {
			expect((await fetch(`${base}${p}`, { method: "POST", headers: auth })).status).toBe(200);
		}
		expect(calls).toEqual(["on", "on", "on"]);
	});

	test("off request runs the runner with off", async () => {
		const calls: string[] = [];
		const base = start(async (a) => void calls.push(a));
		expect((await fetch(`${base}/wake/off`, { method: "POST", headers: auth })).status).toBe(200);
		expect((await fetch(`${base}/off`, { method: "POST", headers: auth })).status).toBe(200);
		expect(calls).toEqual(["off", "off"]);
	});

	test("GET health answers ok without running", async () => {
		const calls: string[] = [];
		const base = start(async (a) => void calls.push(a));
		for (const p of ["/wake", "/"]) {
			const res = await fetch(`${base}${p}`, { headers: auth });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
		}
		expect(calls).toEqual([]);
	});

	test("runner rejection answers 500 with the message", async () => {
		const base = start(async () => {
			throw new Error("remote.sh exploded");
		});
		const res = await fetch(`${base}/wake`, { method: "POST", headers: auth });
		expect(res.status).toBe(500);
		expect(JSON.stringify(await res.json())).toContain("remote.sh exploded");
	});

	test("unknown path answers 404", async () => {
		const base = start(async () => {});
		const res = await fetch(`${base}/nope`, { method: "POST", headers: auth });
		expect(res.status).toBe(404);
	});

	test("stop leaves nothing listening", async () => {
		const base = start(async () => {});
		server?.stop(true);
		server = null;
		await expect(fetch(`${base}/wake`, { headers: auth })).rejects.toThrow();
	});

	test("a POST with a foreign Origin or none at all is 403 and does not run", async () => {
		const calls: string[] = [];
		const base = start(async (a) => void calls.push(a));
		for (const headers of [
			{ ...identity, Origin: "https://evil.example" },
			identity,
			{ ...identity, "Sec-Fetch-Site": "cross-site" },
		]) {
			for (const p of ["/wake/off", "/wake"]) {
				const res = await fetch(`${base}${p}`, { method: "POST", headers });
				expect(res.status).toBe(403);
				expect((await res.json()).error.code).toBe("forbidden_origin");
			}
		}
		expect(calls).toEqual([]);
	});

	test("a POST without Origin passes when Sec-Fetch-Site is same-origin or none", async () => {
		const calls: string[] = [];
		const base = start(async (a) => void calls.push(a));
		for (const site of ["same-origin", "none"]) {
			const res = await fetch(`${base}/wake/off`, { method: "POST", headers: { ...identity, "Sec-Fetch-Site": site } });
			expect(res.status).toBe(200);
		}
		expect(calls).toEqual(["off", "off"]);
	});

	test("GET health needs no Origin", async () => {
		const base = start(async () => {});
		expect((await fetch(`${base}/wake`, { headers: identity })).status).toBe(200);
	});

	test("Bun.serve is started with the idle timeout disabled", () => {
		const spy = spyOn(Bun, "serve");
		try {
			start(async () => {});
			expect(spy.mock.calls[0]?.[0]).toMatchObject({ idleTimeout: 0 });
		} finally {
			spy.mockRestore();
		}
	});
});
