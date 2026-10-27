// The Burrow HTTP surface: a small JSON API, the WebSocket upgrade, and the
// built phone app. Everything except the static shell sits behind the
// Tailscale identity check.

import { join, normalize, sep } from "node:path";
import type { Server } from "bun";
import type { ApiErrorBody, BootstrapResponse } from "../shared/protocol";
import type { DiffResponse } from "../shared/types";
import { authorizeRequest, denialResponse } from "./auth";
import type { BurrowConfig } from "./config";
import { listRepos, resolveRepo } from "./repos/allowlist";
import { createFileIndexer, DEFAULT_LIMIT, MAX_LIMIT, type FileIndexer } from "./repos/files";
import type { BurrowError, SessionManagerPort } from "./sessions/port";
import type { Hub, SocketData } from "./ws";

export interface HttpServerOptions {
	config: BurrowConfig;
	manager: SessionManagerPort;
	hub: Hub;
	/** Diff of the working tree of a repo; throws with the git stderr text on failure. */
	diff: (repoPath: string) => Promise<DiffResponse>;
	/** File index behind GET /api/files; the default caches one index per repo root. */
	fileIndex?: FileIndexer;
}

/** Manager error codes that mean the session is held elsewhere and stays so; answered 409. */
const CONFLICT_CODES: ReadonlySet<string> = new Set(["session_conflict", "open_elsewhere", "holder_not_omp", "takeover_failed"]);

function errorResponse(status: number, code: string, message: string, headers?: HeadersInit): Response {
	const body: ApiErrorBody = { error: { code, message } };
	return Response.json(body, { status, headers });
}

function managerErrorResponse(error: BurrowError): Response {
	return errorResponse(CONFLICT_CODES.has(error.code) ? 409 : 400, error.code, error.message);
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** null when the raw parameter is present but not a usable row count. */
function parseLimit(raw: string | null): number | null {
	if (raw === null) return DEFAULT_LIMIT;
	if (!/^\d+$/.test(raw)) return null;
	const limit = Number(raw);
	return limit >= 1 && limit <= MAX_LIMIT ? limit : null;
}

async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
	try {
		const value: unknown = await req.json();
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

async function serveShell(webRoot: string, pathname: string): Promise<Response> {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return errorResponse(400, "bad_request", "malformed path");
	}
	const rootDir = normalize(webRoot);
	const target = normalize(join(rootDir, decoded));
	if (target !== rootDir && !target.startsWith(rootDir + sep)) return errorResponse(404, "not_found", "no such file");

	const index = Bun.file(join(rootDir, "index.html"));
	if (!(await index.exists())) {
		return new Response("The web bundle is not built; run `bun run build` first.\n", {
			status: 503,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	}
	const noCache = { "cache-control": "no-cache" };
	if (decoded !== "/" && decoded !== "") {
		const file = Bun.file(target);
		if (target !== rootDir && (await file.exists())) {
			const headers = decoded === "/sw.js" || decoded === "/index.html" ? noCache : undefined;
			return new Response(file, { headers });
		}
		// A missing asset must not turn into HTML: the service worker would cache it.
		if (decoded.startsWith("/assets/")) return errorResponse(404, "not_found", "no such file");
	}
	return new Response(index, { headers: noCache });
}

export function createHttpServer(options: HttpServerOptions): Server<SocketData> {
	const { config, manager, hub, diff } = options;
	const fileIndex = options.fileIndex ?? createFileIndexer();

	async function route(req: Request, server: Server<SocketData>): Promise<Response> {
		const url = new URL(req.url);
		const path = url.pathname;
		const isApi = path === "/health" || path === "/ws" || path.startsWith("/api/");

		if (!isApi) {
			if (req.method !== "GET" && req.method !== "HEAD") {
				return errorResponse(405, "method_not_allowed", "only GET is served here", { allow: "GET, HEAD" });
			}
			return serveShell(config.webRoot, path);
		}

		if (path === "/ws") {
			// The hub does the identity and Origin check itself.
			if (req.method !== "GET") return errorResponse(405, "method_not_allowed", "use GET", { allow: "GET" });
			return hub.attach(req, server);
		}

		const denial = authorizeRequest(req, config);
		if (denial !== null) return denialResponse(denial);

		if (path === "/health") {
			return req.method === "GET" ? Response.json({ ok: true }) : methodNotAllowed("GET");
		}
		if (path === "/api/bootstrap") {
			if (req.method !== "GET") return methodNotAllowed("GET");
			const [repos, sessions] = await Promise.all([listRepos(config.repos), manager.list()]);
			const body: BootstrapResponse = { repos, sessions };
			return Response.json(body);
		}
		if (path === "/api/sessions") {
			if (req.method !== "POST") return methodNotAllowed("POST");
			return startSession(req);
		}
		if (path === "/api/sessions/adopt") {
			return req.method === "POST" ? adoptSession(req) : methodNotAllowed("POST");
		}
		if (path === "/api/sessions/watch") {
			return req.method === "POST" ? watchSession(req) : methodNotAllowed("POST");
		}
		if (path === "/api/files") {
			return req.method === "GET" ? listSessionFiles(url) : methodNotAllowed("GET");
		}
		const match = /^\/api\/sessions\/([^/]+)\/(stop|diff)$/.exec(path);
		if (match !== null) {
			const sessionId = decodeURIComponent(match[1] ?? "");
			if (match[2] === "stop") {
				return req.method === "POST" ? stopSession(sessionId) : methodNotAllowed("POST");
			}
			return req.method === "GET" ? sessionDiff(sessionId) : methodNotAllowed("GET");
		}
		return errorResponse(404, "not_found", `No such API route: ${path}`);
	}

	function methodNotAllowed(allow: string): Response {
		return errorResponse(405, "method_not_allowed", `use ${allow}`, { allow });
	}

	async function startSession(req: Request): Promise<Response> {
		const body = await readJsonObject(req);
		const repoPath = body?.repoPath;
		const sessionFile = body?.sessionFile;
		if (typeof repoPath !== "string" || repoPath.length === 0) {
			return errorResponse(400, "bad_request", "body needs a repoPath string");
		}
		if (sessionFile !== undefined && typeof sessionFile !== "string") {
			return errorResponse(400, "bad_request", "sessionFile must be a string");
		}
		const repo = await resolveRepo(config.repos, repoPath);
		if (!repo.ok) return errorResponse(400, repo.error.code, repo.error.message);
		const started = await manager.start(
			sessionFile === undefined ? { repoPath: repo.value.path } : { repoPath: repo.value.path, sessionFile },
		);
		if (!started.ok) return managerErrorResponse(started.error);
		return Response.json({ session: started.value });
	}

	async function adoptSession(req: Request): Promise<Response> {
		const sessionFile = (await readJsonObject(req))?.sessionFile;
		if (typeof sessionFile !== "string" || sessionFile.length === 0) {
			return errorResponse(400, "bad_request", "body needs a sessionFile string");
		}
		const adopted = await manager.adopt(sessionFile);
		if (!adopted.ok) return managerErrorResponse(adopted.error);
		return Response.json({ session: adopted.value });
	}

	/** Opens a read only view of a session file another process at the host holds. */
	async function watchSession(req: Request): Promise<Response> {
		const sessionFile = (await readJsonObject(req))?.sessionFile;
		if (typeof sessionFile !== "string" || sessionFile.length === 0) {
			return errorResponse(400, "bad_request", "body needs a sessionFile string");
		}
		const watched = await manager.watch(sessionFile);
		if (!watched.ok) return managerErrorResponse(watched.error);
		return Response.json({ session: watched.value });
	}

	async function stopSession(sessionId: string): Promise<Response> {
		const stopped = await manager.stop(sessionId, "handoff");
		if (!stopped.ok) return errorResponse(404, stopped.error.code, stopped.error.message);
		return Response.json({ ok: true });
	}

	async function sessionDiff(sessionId: string): Promise<Response> {
		const snapshot = manager.snapshot(sessionId);
		if (snapshot === null) return errorResponse(404, "session_not_found", `Unknown session: ${sessionId}`);
		try {
			return Response.json(await diff(snapshot.session.repo));
		} catch (err) {
			return errorResponse(500, "diff_failed", errorText(err));
		}
	}

	async function listSessionFiles(url: URL): Promise<Response> {
		const sessionId = url.searchParams.get("session");
		if (sessionId === null || sessionId.length === 0) return errorResponse(400, "bad_request", "session is required");
		const limit = parseLimit(url.searchParams.get("limit"));
		if (limit === null) return errorResponse(400, "bad_request", `limit must be an integer between 1 and ${MAX_LIMIT}`);
		const snapshot = manager.snapshot(sessionId);
		if (snapshot === null) return errorResponse(404, "session_not_found", `Unknown session: ${sessionId}`);
		return Response.json(await fileIndex.list(snapshot.session.repo, url.searchParams.get("q") ?? "", limit));
	}

	return Bun.serve<SocketData>({
		port: config.port,
		hostname: "127.0.0.1",
		// Bun's default 10 s idle timeout drops a request whose response is still
		// being computed (a resume waits on spawn, handshake and paging; a big diff
		// takes a while) and the phone sees a dropped socket while the work goes on.
		// Only the loopback proxy connects, so an unbounded wait costs nothing.
		idleTimeout: 0,
		websocket: hub.websocket,
		async fetch(req, server) {
			try {
				return await route(req, server);
			} catch (err) {
				// The text goes back; the stack never does.
				return errorResponse(500, "internal_error", errorText(err));
			}
		},
	});
}
