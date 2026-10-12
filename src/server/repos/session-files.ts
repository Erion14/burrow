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

/** Only the first lines are read: the header and title sit at the top, and files can be huge. */
async function readHead(file: string): Promise<string[]> {
	const text = await Bun.file(file).slice(0, 512 * 1024).text();
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

export async function listRecentSessions(
	sessionsDir: string,
	allowedPaths: string[],
	options: { limit?: number; maxAgeDays?: number } = {},
): Promise<RecentSession[]> {
	const limit = options.limit ?? 30;
	const minMtime = options.maxAgeDays === undefined ? 0 : Date.now() - options.maxAgeDays * 86_400_000;
	const allowed = new Set((await listRepos(allowedPaths)).map((r) => r.path));

	const candidates: { file: string; mtimeMs: number }[] = [];
	try {
		for await (const folder of await opendir(sessionsDir)) {
			if (!folder.isDirectory()) continue;
			const dir = join(sessionsDir, folder.name);
			try {
				for await (const f of await opendir(dir)) {
					if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
					const file = join(dir, f.name);
					try {
						const { mtimeMs } = await stat(file);
						if (mtimeMs >= minMtime) candidates.push({ file, mtimeMs });
					} catch {}
				}
			} catch {}
		}
	} catch {
		return [];
	}
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

	const out: RecentSession[] = [];
	for (const { file, mtimeMs } of candidates) {
		if (out.length >= limit) break;
		try {
			const parsed = parseHead(await readHead(file));
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
