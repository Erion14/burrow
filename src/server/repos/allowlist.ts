import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { RepoOption } from "../../shared/types";
import type { Result } from "../sessions/port";

async function resolveDir(raw: string): Promise<string | null> {
	try {
		const real = await realpath(raw);
		return (await stat(real)).isDirectory() ? real : null;
	} catch {
		return null;
	}
}

export async function listRepos(rawPaths: string[]): Promise<RepoOption[]> {
	const resolved = await Promise.all(rawPaths.map(resolveDir));
	const seen = new Set<string>();
	const repos: RepoOption[] = [];
	for (const path of resolved) {
		if (path === null || seen.has(path)) continue;
		seen.add(path);
		repos.push({ path, name: basename(path) });
	}
	return repos;
}

function notAllowed(requestedPath: string): Result<RepoOption> {
	return { ok: false, error: { code: "repo_not_allowed", message: `Repo not allowed: ${requestedPath}` } };
}

/** Compares after realpath on both sides, so symlinks can neither escape nor alias the allowlist. */
export async function resolveRepo(rawPaths: string[], requestedPath: string): Promise<Result<RepoOption>> {
	if (requestedPath.split(/[\\/]/).includes("..")) return notAllowed(requestedPath);
	const real = await resolveDir(requestedPath);
	if (real === null) return notAllowed(requestedPath);
	const repo = (await listRepos(rawPaths)).find((r) => r.path === real);
	return repo ? { ok: true, value: repo } : notAllowed(requestedPath);
}
