import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { FakeManager, makeSnapshot, makeSummary } from "../../test/fake-manager";
import type { ApiErrorBody, BootstrapResponse } from "../shared/protocol";
import type { DiffResponse } from "../shared/types";
import type { BurrowConfig } from "./config";
import { createHttpServer } from "./http";
import type { FileListResponse } from "./repos/files";
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
let fileCalls: { root: string; query: string; limit: number }[];
let fileImpl: (root: string, query: string, limit: number) => Promise<FileListResponse>;

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
	if (authed) {
		headers.set("tailscale-user-login", OWNER);
		if (!headers.has("origin")) headers.set("origin", ORIGIN);
	}
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
	fileCalls = [];
	fileImpl = async () => ({ items: [], truncated: false });
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
		fileIndex: {
			list(root, query, limit) {
				fileCalls.push({ root, query, limit });
				return fileImpl(root, query, limit);
			},
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
			["POST", "/api/sessions/adopt", { sessionFile: "/x/y.jsonl" }],
			["POST", "/api/sessions/watch", { sessionFile: "/x/y.jsonl" }],
			["POST", "/api/sessions/s1/stop", {}],
			["GET", "/api/sessions/s1/diff"],
			["GET", "/api/files?session=s1"],
		];
		for (const [method, path, body] of calls) {
			const res = await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) }, false);
			expect(res.status).toBe(403);
			expect((await errorBody(res)).code).toBe("forbidden_identity");
		}
		expect(manager.listCalls).toBe(0);
		expect(manager.startCalls).toHaveLength(0);
		expect(manager.adoptCalls).toHaveLength(0);
		expect(manager.watchCalls).toHaveLength(0);
		expect(manager.stopCalls).toHaveLength(0);
		expect(manager.snapshotCalls).toHaveLength(0);
		expect(diffCalls).toHaveLength(0);
		expect(fileCalls).toHaveLength(0);
	});

	test("a different identity is 403", async () => {
		const res = await api("/health", { headers: { "tailscale-user-login": "other@example.com" } }, false);
		expect(res.status).toBe(403);
	});
});

describe("origin on state-changing requests", () => {
	function raw(path: string, method: string, headers: Record<string, string>): Promise<Response> {
		return fetch(`http://127.0.0.1:${server.port}${path}`, {
			method,
			headers: { ...AUTH, "content-type": "application/json", ...headers },
			body: method === "GET" ? undefined : JSON.stringify({ repoPath: repoDir }),
		});
	}

	test("a POST with a foreign Origin is 403 and never reaches the manager", async () => {
		for (const path of ["/api/sessions", "/api/sessions/s1/stop"]) {
			const res = await raw(path, "POST", { origin: "https://evil.example" });
			expect(res.status).toBe(403);
			expect((await errorBody(res)).code).toBe("forbidden_origin");
		}
		expect(manager.startCalls).toHaveLength(0);
		expect(manager.stopCalls).toHaveLength(0);
	});

	test("a POST with no Origin is 403 unless Sec-Fetch-Site says same-origin or none", async () => {
		for (const headers of [{}, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }] as Record<string, string>[]) {
			const res = await raw("/api/sessions", "POST", headers);
			expect(res.status).toBe(403);
			expect((await errorBody(res)).code).toBe("forbidden_origin");
		}
		expect(manager.startCalls).toHaveLength(0);
		for (const site of ["same-origin", "none"]) {
			expect((await raw("/api/sessions", "POST", { "sec-fetch-site": site })).status).toBe(200);
		}
		expect(manager.startCalls).toHaveLength(2);
	});

	test("an Origin of null or a variant of the Burrow origin is 403 even with same-origin fetch metadata", async () => {
		for (const origin of ["null", `${ORIGIN}/`, "http://burrow.tailnet.ts.net"]) {
			const res = await raw("/api/sessions", "POST", { origin, "sec-fetch-site": "same-origin" });
			expect(res.status).toBe(403);
		}
		expect(manager.startCalls).toHaveLength(0);
	});

	test("the same POST from the Burrow Origin passes", async () => {
		const res = await raw("/api/sessions", "POST", { origin: ORIGIN });
		expect(res.status).toBe(200);
		expect(manager.startCalls).toEqual([{ repoPath: repoDir }]);
	});

	test("GET needs no Origin", async () => {
		expect((await raw("/api/bootstrap", "GET", {})).status).toBe(200);
		expect((await raw("/health", "GET", { origin: "https://evil.example" })).status).toBe(200);
		const files = await raw("/api/files?session=nope", "GET", {});
		expect(files.status).toBe(404);
		expect((await errorBody(files)).code).toBe("session_not_found");
	});
});

describe("slow requests", () => {
	test("Bun.serve is started with the idle timeout disabled", () => {
		const spy = spyOn(Bun, "serve");
		try {
			const extra = createHttpServer({ config: makeConfig(), manager, hub, diff: diffImpl });
			extra.stop(true);
			expect(spy.mock.calls[0]?.[0]).toMatchObject({ idleTimeout: 0 });
		} finally {
			spy.mockRestore();
		}
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
		manager.startResult = { ok: false, error: { code: "session_conflict", message: "open at the host" } };
		const res = await post("/api/sessions", { repoPath: repoDir });
		expect(res.status).toBe(409);
		expect(await errorBody(res)).toEqual({ code: "session_conflict", message: "open at the host" });
		expect(manager.startCalls).toHaveLength(1);
	});

	test("POST /api/sessions answers 400 for other manager failures", async () => {
		manager.startResult = { ok: false, error: { code: "start_failed", message: "omp did not start" } };
		const res = await post("/api/sessions", { repoPath: repoDir });
		expect(res.status).toBe(400);
		expect((await errorBody(res)).code).toBe("start_failed");
	});

	test("POST /api/sessions/adopt answers the taken over session", async () => {
		const summary = makeSummary("taken", { repo: repoDir, sessionFile: "/x/y.jsonl" });
		manager.adoptResult = { ok: true, value: summary };
		const res = await post("/api/sessions/adopt", { sessionFile: "/x/y.jsonl" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ session: summary });
		expect(manager.adoptCalls).toEqual(["/x/y.jsonl"]);
	});

	test("POST /api/sessions/adopt answers 409 when the holder cannot be stopped", async () => {
		for (const code of ["takeover_failed", "holder_not_omp"]) {
			manager.adoptResult = { ok: false, error: { code, message: "still held" } };
			const res = await post("/api/sessions/adopt", { sessionFile: "/x/y.jsonl" });
			expect(res.status).toBe(409);
			expect(await errorBody(res)).toEqual({ code, message: "still held" });
		}
	});

	test("POST /api/sessions/watch answers the followed session", async () => {
		const summary = makeSummary("watched", { running: false, openElsewhere: true, canTakeOver: true, sessionFile: "/x/y.jsonl" });
		manager.watchResult = { ok: true, value: summary };
		const res = await post("/api/sessions/watch", { sessionFile: "/x/y.jsonl" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ session: summary });
		expect(manager.watchCalls).toEqual(["/x/y.jsonl"]);
	});

	test("POST /api/sessions/watch answers 400 for a refused file and for a running session", async () => {
		for (const code of ["invalid_session_file", "repo_not_allowed", "already_running"]) {
			manager.watchResult = { ok: false, error: { code, message: "no" } };
			const res = await post("/api/sessions/watch", { sessionFile: "/x/y.jsonl" });
			expect(res.status).toBe(400);
			expect((await errorBody(res)).code).toBe(code);
		}
	});

	test("POST /api/sessions/watch with a bad body is 400 and watches nothing", async () => {
		for (const body of [{}, { sessionFile: "" }, { sessionFile: 7 }]) {
			const res = await post("/api/sessions/watch", body);
			expect(res.status).toBe(400);
			expect((await errorBody(res)).code).toBe("bad_request");
		}
		expect(manager.watchCalls).toHaveLength(0);
	});

	test("POST /api/sessions/adopt answers 400 for a refused file", async () => {
		for (const code of ["invalid_session_file", "repo_not_allowed"]) {
			manager.adoptResult = { ok: false, error: { code, message: "no" } };
			const res = await post("/api/sessions/adopt", { sessionFile: "/x/y.jsonl" });
			expect(res.status).toBe(400);
			expect((await errorBody(res)).code).toBe(code);
		}
	});

	test("POST /api/sessions/adopt with a bad body is 400 and adopts nothing", async () => {
		for (const body of [{}, { sessionFile: "" }, { sessionFile: 3 }]) {
			const res = await post("/api/sessions/adopt", body);
			expect(res.status).toBe(400);
			expect((await errorBody(res)).code).toBe("bad_request");
		}
		expect((await api("/api/sessions/adopt", { method: "POST", body: "{nope" })).status).toBe(400);
		expect((await api("/api/sessions/adopt")).status).toBe(405);
		expect(manager.adoptCalls).toHaveLength(0);
		expect(manager.watchCalls).toHaveLength(0);
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

describe("files", () => {
	// Called from every test below, so the snapshot shape stays in one place.
	function withSession(): void {
		manager.snapshots.set("s1", makeSnapshot("s1", { session: makeSummary("s1", { repo: repoDir }) }));
	}

	test("GET /api/files ranks the session repo with the query and the limit", async () => {
		withSession();
		const items = [
			{ path: "src", dir: true },
			{ path: "src/foo.ts", dir: false },
		];
		fileImpl = async () => ({ items, truncated: true });
		const res = await api("/api/files?session=s1&q=src&limit=5");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ items, truncated: true });
		expect(fileCalls).toEqual([{ root: repoDir, query: "src", limit: 5 }]);
	});

	test("the defaults are an empty query and 20 rows", async () => {
		withSession();
		const res = await api("/api/files?session=s1");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ items: [], truncated: false });
		expect(fileCalls).toEqual([{ root: repoDir, query: "", limit: 20 }]);
	});

	test("an unknown session is 404 and the index never runs", async () => {
		const res = await api("/api/files?session=nope&q=src");
		expect(res.status).toBe(404);
		expect((await errorBody(res)).code).toBe("session_not_found");
		expect(fileCalls).toHaveLength(0);
	});

	test("a bad limit is 400 and the index never runs", async () => {
		withSession();
		for (const limit of ["0", "1000", "-1", "abc", "2.5", ""]) {
			const res = await api(`/api/files?session=s1&limit=${limit}`);
			expect(res.status).toBe(400);
			expect((await errorBody(res)).code).toBe("bad_request");
		}
		expect(fileCalls).toHaveLength(0);
	});

	test("the limit bounds are 1 and 100", async () => {
		withSession();
		for (const limit of ["1", "100"]) {
			expect((await api(`/api/files?session=s1&limit=${limit}`)).status).toBe(200);
		}
		expect(fileCalls.map((call) => call.limit)).toEqual([1, 100]);
	});

	test("a missing session and a POST are refused", async () => {
		withSession();
		expect((await api("/api/files")).status).toBe(400);
		const wrong = await api("/api/files?session=s1", { method: "POST" });
		expect(wrong.status).toBe(405);
		expect((await errorBody(wrong)).code).toBe("method_not_allowed");
		expect(fileCalls).toHaveLength(0);
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
