// The file index behind the phone's @ menu. One index per repo root, built the
// cheapest way the directory allows: git decides what exists in a checkout, and
// a bounded walk covers everything else. Rows are ranked, never filtered to
// existence: the client inserts the path it picked.

import { opendir } from "node:fs/promises";
import { join } from "node:path";
import type { Result } from "../sessions/port";

/** One row of the @ menu. Directories are derived from the files they contain. */
export interface FileEntry {
	path: string;
	dir: boolean;
}

export interface FileListResponse {
	items: FileEntry[];
	truncated: boolean;
}

/** Rows the menu shows when the client does not ask for a count. */
export const DEFAULT_LIMIT = 20;
/** More rows than this are noise on a phone; a bigger ask is a client bug. */
export const MAX_LIMIT = 100;

const TTL_MS = 60_000;
/** Checkouts under a non-checkout root that are looked at, in name order. */
const MAX_CHILDREN = 40;

/** Names a walk never descends into: build output, dependency and cache trees. */
const WALK_SKIP: Record<string, true> = {
	".git": true,
	node_modules: true,
	dist: true,
	build: true,
	target: true,
	".venv": true,
	venv: true,
	__pycache__: true,
	".next": true,
	out: true,
};

const WALK_DEPTH = 8;
const WALK_MAX_PATHS = 20_000;
const WALK_DEADLINE_MS = 3_000;

/** Runs git in `cwd`; a missing binary and a non-zero exit are values, never throws. */
export type GitRunner = (cwd: string, args: string[]) => Promise<Result<string>>;

/** Lists the files under `root` relative to it, with "/" separators. */
export type WalkRunner = (root: string) => Promise<Result<string[]>>;

export interface FileIndexer {
	/** Ranks the index of `root` against `query` and returns at most `limit` rows. */
	list(root: string, query: string, limit: number): Promise<FileListResponse>;
}

export interface FileIndexerOptions {
	git?: GitRunner;
	walk?: WalkRunner;
	/** Injectable clock so tests can cross the TTL without waiting. */
	now?: () => number;
	ttlMs?: number;
}

export const spawnGit: GitRunner = async (cwd, args) => {
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(["git", "-C", cwd, ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			// A suggestion list must not take the repo lock, and the output is
			// parsed, so it must not follow the caller's locale.
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
		});
	} catch (err) {
		return { ok: false, error: { code: "git_spawn_failed", message: err instanceof Error ? err.message : String(err) } };
	}
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		return { ok: false, error: { code: "git_failed", message: `git ${args[0]} failed (${code}): ${stderr.trim().slice(0, 2000)}` } };
	}
	return { ok: true, value: stdout };
};

export const walkTree: WalkRunner = async (root) => {
	const files: string[] = [];
	const deadline = Date.now() + WALK_DEADLINE_MS;
	// Breadth first, so a list cut by the path cap or the deadline still holds
	// the shallow entries a menu actually offers.
	let level = [""];
	for (let depth = 1; depth <= WALK_DEPTH && level.length > 0; depth++) {
		const next: string[] = [];
		for (const prefix of level) {
			if (Date.now() >= deadline) return { ok: true, value: files };
			const parent = prefix === "" ? "" : `${prefix}/`;
			try {
				for await (const entry of await opendir(join(root, prefix))) {
					if (entry.isDirectory()) {
						if (WALK_SKIP[entry.name] === true) continue;
						next.push(parent + entry.name);
						continue;
					}
					if (!entry.isFile()) continue;
					files.push(parent + entry.name);
					if (files.length >= WALK_MAX_PATHS) return { ok: true, value: files };
					if ((files.length & 255) === 0 && Date.now() >= deadline) return { ok: true, value: files };
				}
			} catch {
				// A directory that vanished or cannot be read is not a failure.
				continue;
			}
		}
		level = next;
	}
	return { ok: true, value: files };
};

function compareDefault(a: FileEntry, b: FileEntry): number {
	if (a.dir !== b.dir) return a.dir ? -1 : 1;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Every ancestor of every path is a directory row, so the client can drill in. */
function toEntries(paths: string[]): FileEntry[] {
	const dirs = new Set<string>();
	const files = new Set<string>();
	for (const path of paths) {
		if (path.length === 0) continue;
		for (let cut = path.indexOf("/"); cut !== -1; cut = path.indexOf("/", cut + 1)) dirs.add(path.slice(0, cut));
		files.add(path);
	}
	const entries: FileEntry[] = [];
	for (const path of dirs) entries.push({ path, dir: true });
	for (const path of files) entries.push({ path, dir: false });
	entries.sort(compareDefault);
	return entries;
}

/** True when every character of `query` appears in `text` in order. */
function isSubsequence(query: string, text: string): boolean {
	let at = 0;
	for (let i = 0; i < text.length && at < query.length; i++) {
		if (text[i] === query[at]) at++;
	}
	return at === query.length;
}

/** Lower is better; null when the query does not match at all. */
function rankOf(entry: FileEntry, query: string): number | null {
	const path = entry.path.toLowerCase();
	const cut = path.lastIndexOf("/");
	const base = cut === -1 ? path : path.slice(cut + 1);
	if (base.startsWith(query)) return 0;
	if (base.includes(query)) return 1;
	if (path.includes(query)) return 2;
	return isSubsequence(query, path) ? 3 : null;
}

interface Ranked {
	entry: FileEntry;
	rank: number;
}

function compareRanked(a: Ranked, b: Ranked): number {
	if (a.rank !== b.rank) return a.rank - b.rank;
	if (a.entry.dir !== b.entry.dir) return a.entry.dir ? -1 : 1;
	if (a.entry.path.length !== b.entry.path.length) return a.entry.path.length - b.entry.path.length;
	return compareDefault(a.entry, b.entry);
}

function select(entries: FileEntry[], query: string, limit: number): FileListResponse {
	const needle = query.trim().toLowerCase();
	if (needle === "") return { items: entries.slice(0, limit), truncated: entries.length > limit };
	const matched: Ranked[] = [];
	for (const entry of entries) {
		const rank = rankOf(entry, needle);
		if (rank !== null) matched.push({ entry, rank });
	}
	// The cached list is already in canonical order and sort() is stable, so
	// equal ranks keep directories first with paths ascending.
	matched.sort(compareRanked);
	return { items: matched.slice(0, limit).map((item) => item.entry), truncated: matched.length > limit };
}

interface Deps {
	git: GitRunner;
	walk: WalkRunner;
}

async function childDirs(root: string): Promise<string[]> {
	const names: string[] = [];
	try {
		for await (const entry of await opendir(root)) {
			if (entry.isDirectory()) names.push(entry.name);
		}
	} catch {
		return [];
	}
	names.sort();
	return names.slice(0, MAX_CHILDREN);
}

/** null when `dir` is not the top of a checkout; [] when it is but lists nothing. */
async function gitPaths(deps: Deps, dir: string): Promise<string[] | null> {
	const check = await deps.git(dir, ["rev-parse", "--is-inside-work-tree"]);
	if (!check.ok || check.value.trim() !== "true") return null;
	const listed = await deps.git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
	if (!listed.ok) return [];
	// -z output is NUL separated; the trailing separator leaves one empty field.
	const paths: string[] = [];
	for (const path of listed.value.split("\0")) if (path.length > 0) paths.push(path);
	return paths;
}

async function collectPaths(deps: Deps, root: string): Promise<string[]> {
	const own = await gitPaths(deps, root);
	if (own !== null) return own;

	const children = await childDirs(root);
	const listed = await Promise.all(
		children.map(async (child) => {
			const paths = await gitPaths(deps, join(root, child));
			return paths === null ? null : paths.map((path) => `${child}/${path}`);
		}),
	);
	const fromChildren: string[] = [];
	for (const paths of listed) if (paths !== null) fromChildren.push(...paths);
	if (fromChildren.length > 0) return fromChildren;

	const walked = await deps.walk(root);
	if (!walked.ok) throw new Error(walked.error.message);
	return walked.value;
}

export function createFileIndexer(options: FileIndexerOptions = {}): FileIndexer {
	const deps: Deps = { git: options.git ?? spawnGit, walk: options.walk ?? walkTree };
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? TTL_MS;
	const cache = new Map<string, { at: number; entries: FileEntry[] }>();
	const pending = new Map<string, Promise<FileEntry[]>>();

	function entriesFor(root: string): Promise<FileEntry[]> {
		const cached = cache.get(root);
		if (cached !== undefined && now() - cached.at < ttlMs) return Promise.resolve(cached.entries);
		const inFlight = pending.get(root);
		if (inFlight !== undefined) return inFlight;
		// A failed rebuild resolves to an empty list and is remembered for the
		// TTL: the phone loses suggestions, it does not get an error storm.
		const build = (async () => {
			try {
				const entries = toEntries(await collectPaths(deps, root));
				cache.set(root, { at: now(), entries });
				return entries;
			} catch {
				const entries: FileEntry[] = [];
				cache.set(root, { at: now(), entries });
				return entries;
			}
		})();
		pending.set(root, build);
		void build.finally(() => {
			if (pending.get(root) === build) pending.delete(root);
		});
		return build;
	}

	return {
		async list(root, query, limit) {
			return select(await entriesFor(root), query, limit);
		},
	};
}
