import { opendir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { listRepos } from "./allowlist";

export interface RecentSession {
	sessionId: string;
	sessionFile: string;
	cwd: string;
	title: string;
	updatedAt: string;
}

const HEADER_LINES = 200;
export const HEAD_BYTES = 64 * 1024;
const MAX_FILES = 400;
const CACHE_MAX = 2000;
const STAT_BATCH = 64;
const TITLE_MAX = 60;

interface Parsed {
	sessionId: string;
	cwd: string;
	title: string;
}

function userText(message: unknown): string | null {
	if (typeof message !== "object" || message === null) return null;
	const m = message as { role?: unknown; content?: unknown };
	if (m.role !== "user") return null;
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		const parts = m.content
			.filter((c): c is { type: string; text: string } => c?.type === "text" && typeof c.text === "string")
			.map((c) => c.text);
		return parts.length > 0 ? parts.join("\n") : null;
	}
	return null;
}

/**
 * Only the head is read. The session header is line 1 and the title entry follows it, both tiny.
 * The first-user-message title fallback may sit behind a few tool/system entries, so the bound is
 * 64 KiB (and at most HEADER_LINES lines): comfortably deep enough for those, ~8x less than before.
 * A cut-off final line simply fails JSON.parse and is skipped.
 */
async function readHead(file: string): Promise<string[]> {
	sessionFileStats.headReads++;
	const text = await Bun.file(file).slice(0, HEAD_BYTES).text();
	return text.split("\n", HEADER_LINES);
}

function parseHead(lines: string[]): Parsed | null {
	let sessionId: string | null = null;
	let cwd: string | null = null;
	let title = "";
	let firstUser = "";
	for (const line of lines) {
		if (line.length === 0) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		if (entry.type === "session" && sessionId === null) {
			if (typeof entry.cwd === "string" && typeof entry.id === "string") {
				cwd = entry.cwd;
				sessionId = entry.id;
			}
		} else if (entry.type === "title" && typeof entry.title === "string" && entry.title.trim() !== "") {
			title = entry.title.trim();
		} else if (entry.type === "message" && firstUser === "") {
			const text = userText(entry.message)?.trim();
			if (text) firstUser = text;
		}
	}
	if (sessionId === null || cwd === null) return null;
	return { sessionId, cwd, title: title || firstUser.replace(/\s+/g, " ").slice(0, TITLE_MAX) || sessionId };
}

export interface ListOptions {
	limit?: number;
	/** Only files modified within this many days are considered. Default 30; Infinity disables. */
	maxAgeDays?: number;
	/** Upper bound on files considered (newest by mtime first). Default 400. */
	maxFiles?: number;
	/** Clock injection for tests. */
	now?: () => number;
}

/** Observable counters so tests can prove what was (not) read. */
export const sessionFileStats = { headReads: 0 };

interface CacheEntry {
	mtimeMs: number;
	size: number;
	parsed: Parsed | null;
}
const headCache = new Map<string, CacheEntry>();

export function clearSessionHeaderCache(): void {
	headCache.clear();
}

function remember(file: string, entry: CacheEntry): void {
	headCache.delete(file);
	headCache.set(file, entry);
	// Map iterates in insertion order, so the first key is the least recently used.
	while (headCache.size > CACHE_MAX) {
		const oldest = headCache.keys().next().value;
		if (oldest === undefined) break;
		headCache.delete(oldest);
	}
}

async function parsedFor(file: string, mtimeMs: number, size: number): Promise<Parsed | null> {
	const hit = headCache.get(file);
	if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
		remember(file, hit);
		return hit.parsed;
	}
	const parsed = parseHead(await readHead(file));
	remember(file, { mtimeMs, size, parsed });
	return parsed;
}

export async function listRecentSessions(
	sessionsDir: string,
	allowedPaths: string[],
	options: ListOptions = {},
): Promise<RecentSession[]> {
	const limit = options.limit ?? 30;
	const maxFiles = options.maxFiles ?? MAX_FILES;
	const now = options.now ?? Date.now;
	const minMtime = now() - (options.maxAgeDays ?? 30) * 86_400_000;
	const allowed = new Set((await listRepos(allowedPaths)).map((r) => r.path));

	const paths: string[] = [];
	try {
		for await (const folder of await opendir(sessionsDir)) {
			if (!folder.isDirectory()) continue;
			const dir = join(sessionsDir, folder.name);
			try {
				for await (const f of await opendir(dir)) {
					if (f.isFile() && f.name.endsWith(".jsonl")) paths.push(join(dir, f.name));
				}
			} catch {}
		}
	} catch {
		return [];
	}

	// Stat only; nothing is opened until the mtime filter and the file cap have been applied.
	const candidates: { file: string; mtimeMs: number; size: number }[] = [];
	for (let i = 0; i < paths.length; i += STAT_BATCH) {
		await Promise.all(
			paths.slice(i, i + STAT_BATCH).map(async (file) => {
				try {
					const { mtimeMs, size } = await stat(file);
					if (mtimeMs >= minMtime) candidates.push({ file, mtimeMs, size });
				} catch {}
			}),
		);
	}
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	candidates.length = Math.min(candidates.length, maxFiles);

	const out: RecentSession[] = [];
	for (const { file, mtimeMs, size } of candidates) {
		if (out.length >= limit) break;
		try {
			const parsed = await parsedFor(file, mtimeMs, size);
			if (parsed === null) continue;
			const realCwd = await realpath(parsed.cwd);
			if (!allowed.has(realCwd)) continue;
			out.push({
				sessionId: parsed.sessionId,
				sessionFile: file,
				cwd: realCwd,
				title: parsed.title,
				updatedAt: new Date(mtimeMs).toISOString(),
			});
		} catch {}
	}
	return out;
}
