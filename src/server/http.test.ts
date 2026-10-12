import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { FakeManager, makeSnapshot, makeSummary } from "../../test/fake-manager";
import type { ApiErrorBody, BootstrapResponse } from "../shared/protocol";
import type { DiffResponse } from "../shared/types";
import type { BurrowConfig } from "./config";
import { createHttpServer } from "./http";
import { createHub, type Hub, type SocketData } from "./ws";

const OWNER = "owner@example.com";
const ORIGIN = "https://burrow.tailnet.ts.net";
const AUTH = { "tailscale-user-login": OWNER };

let root: string;
let repoDir: string;
let webRoot: string;
let manager: FakeManager;
let hub: Hub;
let server: Server<SocketData>;
let diffCalls: string[];
let diffImpl: (repoPath: string) => Promise<DiffResponse>;

function makeConfig(): BurrowConfig {
	return {
		port: 0,
		wakePort: 0,
		ownerLogin: OWNER,
		origin: ORIGIN,
		repos: [repoDir],
		ntfyUrl: null,
		ompCommand: ["omp"],
		sessionsDir: join(root, "sessions"),
		configDir: join(root, "config"),
		webRoot,
		idleTimeoutMs: 1000,
	};
}

function api(path: string, init: RequestInit = {}, authed = true): Promise<Response> {
	const headers = new Headers(init.headers);
	if (authed) headers.set("tailscale-user-login", OWNER);
	return fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers });
}

function post(path: string, body: unknown, authed = true): Promise<Response> {
	return api(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, authed);
}

async function errorBody(res: Response): Promise<ApiErrorBody["error"]> {
	const body = (await res.json()) as ApiErrorBody;
	return body.error;
}

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "burrow-http-")));
	repoDir = join(root, "repo");
	webRoot = join(root, "dist");
	await mkdir(repoDir);
	await mkdir(join(webRoot, "assets"), { recursive: true });
	await writeFile(join(webRoot, "index.html"), "<html>shell</html>");
	await writeFile(join(webRoot, "sw.js"), "// sw");
	await writeFile(join(webRoot, "manifest.webmanifest"), "{}");
	await writeFile(join(webRoot, "assets", "app.js"), "console.log(1)");
	await writeFile(join(root, "secret.txt"), "secret");
	diffCalls = [];
	diffImpl = async (repoPath) => ({ repo: repoPath, files: [], truncated: false });
	manager = new FakeManager();
	hub = createHub({ manager, origin: ORIGIN, ownerLogin: OWNER });
	server = createHttpServer({
		config: makeConfig(),
		manager,
		hub,
		diff: (repoPath) => {
			diffCalls.push(repoPath);
			return diffImpl(repoPath);
		},
	});
});

afterEach(async () => {
	server.stop(true);
	hub.close();
	await rm(root, { recursive: true, force: true });
});

describe("auth", () => {
	test("every API route without the identity header is 403 and never reaches the manager", async () => {
		const calls: [string, string, unknown?][] = [
			["GET", "/health"],
			["GET", "/api/bootstrap"],
			["POST", "/api/sessions", { repoPath: repoDir }],
			["POST", "/api/sessions/s1/stop", {}],
			["GET", "/api/sessions/s1/diff"],
		];
		for (const [method, path, body] of calls) {
			const res = await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) }, false);
			expect(res.status).toBe(403);
			expect((await errorBody(res)).code).toBe("forbidden_identity");
		}
		expect(manager.listCalls).toBe(0);
		expect(manager.startCalls).toHaveLength(0);
		expect(manager.stopCalls).toHaveLength(0);
		expect(manager.snapshotCalls).toHaveLength(0);
		expect(diffCalls).toHaveLength(0);
	});

	test("a different identity is 403", async () => {
		const res = await api("/health", { headers: { "tailscale-user-login": "other@example.com" } }, false);
		expect(res.status).toBe(403);
	});
});

describe("api", () => {
	test("GET /health", async () => {
		const res = await api("/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	test("GET /api/bootstrap lists repos and sessions", async () => {
		manager.addSession("s1");
		const res = await api("/api/bootstrap");
		expect(res.status).toBe(200);
		const body = (await res.json()) as BootstrapResponse;
		expect(body.repos).toEqual([{ path: repoDir, name: "repo" }]);
		expect(body.sessions.map((s) => s.id)).toEqual(["s1"]);
	});

	test("POST /api/sessions starts a session in an allowlisted repo", async () => {
		const summary = makeSummary("new", { repo: repoDir });
		manager.startResult = { ok: true, value: summary };
		const res = await post("/api/sessions", { repoPath: repoDir, sessionFile: "/x/y.jsonl" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ session: summary });
		expect(manager.startCalls).toEqual([{ repoPath: repoDir, sessionFile: "/x/y.jsonl" }]);
	});

	test("POST /api/sessions starts with the resolved repo path", async () => {
		const link = join(root, "link");
		await symlink(repoDir, link);
		const res = await post("/api/sessions", { repoPath: link });
		expect(res.status).toBe(200);
		expect(manager.startCalls).toEqual([{ repoPath: repoDir }]);
	});

	test("POST /api/sessions outside the allowlist is 400 and starts nothing", async () => {
		const res = await post("/api/sessions", { repoPath: root });
		expect(res.status).toBe(400);
		expect((await errorBody(res)).code).toBe("repo_not_allowed");
		expect(manager.startCalls).toHaveLength(0);
	});

	test("POST /api/sessions with a .. path is 400 and starts nothing", async () => {
		const res = await post("/api/sessions", { repoPath: `${repoDir}/../repo` });
		expect(res.status).toBe(400);
		expect((await errorBody(res)).code).toBe("repo_not_allowed");
		expect(manager.startCalls).toHaveLength(0);
	});

	test("POST /api/sessions with a bad body is 400", async () => {
		for (const body of [{}, { repoPath: 5 }, { repoPath: repoDir, sessionFile: 3 }]) {
			const res = await post("/api/sessions", body);
			expect(res.status).toBe(400);
			expect((await errorBody(res)).code).toBe("bad_request");
		}
		const res = await api("/api/sessions", { method: "POST", body: "{nope" });
		expect(res.status).toBe(400);
		expect(manager.startCalls).toHaveLength(0);
	});

	test("POST /api/sessions answers 409 when the manager reports a session conflict", async () => {
		manager.startResult = { ok: false, error: { code: "session_conflict", message: "open at the laptop" } };
		const res = await post("/api/sessions", { repoPath: repoDir });
		expect(res.status).toBe(409);
		expect(await errorBody(res)).toEqual({ code: "session_conflict", message: "open at the laptop" });
		expect(manager.startCalls).toHaveLength(1);
	});

	test("POST /api/sessions answers 400 for other manager failures", async () => {
		manager.startResult = { ok: false, error: { code: "start_failed", message: "omp did not start" } };
		const res = await post("/api/sessions", { repoPath: repoDir });
		expect(res.status).toBe(400);
		expect((await errorBody(res)).code).toBe("start_failed");
	});

	test("POST /api/sessions/:id/stop stops with reason handoff", async () => {
		const res = await post("/api/sessions/s1/stop", {});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(manager.stopCalls).toEqual([{ sessionId: "s1", reason: "handoff" }]);
	});

	test("stop for an unknown session is 404", async () => {
		manager.stopResult = { ok: false, error: { code: "session_not_found", message: "Unknown session: nope" } };
		const res = await post("/api/sessions/nope/stop", {});
		expect(res.status).toBe(404);
		expect((await errorBody(res)).code).toBe("session_not_found");
	});

	test("GET /api/sessions/:id/diff runs the diff on the session repo", async () => {
		manager.snapshots.set("s1", makeSnapshot("s1", { session: makeSummary("s1", { repo: repoDir }) }));
		const res = await api("/api/sessions/s1/diff");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ repo: repoDir, files: [], truncated: false });
		expect(diffCalls).toEqual([repoDir]);
	});

	test("diff for an unknown session is 404", async () => {
		const res = await api("/api/sessions/nope/diff");
		expect(res.status).toBe(404);
		expect((await errorBody(res)).code).toBe("session_not_found");
		expect(diffCalls).toHaveLength(0);
	});

	test("diff failure is 500 with the git text and no stack trace", async () => {
		manager.snapshots.set("s1", makeSnapshot("s1", { session: makeSummary("s1", { repo: repoDir }) }));
		diffImpl = async () => {
			throw new Error("git diff failed (128): fatal: not a git repository");
		};
		const res = await api("/api/sessions/s1/diff");
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(text).toContain("fatal: not a git repository");
		expect(text).not.toContain("    at ");
		const error = (JSON.parse(text) as ApiErrorBody).error;
		expect(error.code).toBe("diff_failed");
	});

	test("unknown API paths and wrong methods are JSON errors", async () => {
		const missing = await api("/api/nope");
		expect(missing.status).toBe(404);
		expect((await errorBody(missing)).code).toBe("not_found");
		const wrong = await api("/api/bootstrap", { method: "POST" });
		expect(wrong.status).toBe(405);
		expect((await errorBody(wrong)).code).toBe("method_not_allowed");
	});

	test("a throwing manager is a 500 error body without a stack", async () => {
		manager.list = async () => {
			throw new Error("kaput");
		};
		const res = await api("/api/bootstrap");
		expect(res.status).toBe(500);
		const text = await res.text();
		expect(text).not.toContain("    at ");
		expect((JSON.parse(text) as ApiErrorBody).error.code).toBe("internal_error");
	});
});

describe("static shell", () => {
	test("serves index.html for / and for unknown non-API paths", async () => {
		for (const path of ["/", "/session/abc", "/index.html"]) {
			const res = await api(path, {}, false);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe("<html>shell</html>");
		}
	});

	test("serves assets, sw.js and the manifest without the identity header", async () => {
		expect(await (await api("/assets/app.js", {}, false)).text()).toBe("console.log(1)");
		const sw = await api("/sw.js", {}, false);
		expect(await sw.text()).toBe("// sw");
		expect(sw.headers.get("cache-control")).toBe("no-cache");
		expect((await api("/manifest.webmanifest", {}, false)).status).toBe(200);
	});

	test("does not serve files outside the web root", async () => {
		const res = await api("/..%2Fsecret.txt", {}, false);
		expect(await res.text()).not.toContain("secret");
		const raw = await fetch(`http://127.0.0.1:${server.port}/../secret.txt`);
		expect(await raw.text()).not.toContain("secret");
	});

	test("a missing dist directory answers 503 with a text body", async () => {
		await rm(webRoot, { recursive: true });
		const res = await api("/", {}, false);
		expect(res.status).toBe(503);
		expect(await res.text()).toContain("not built");
	});
});
