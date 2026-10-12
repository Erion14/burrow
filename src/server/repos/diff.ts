import { stat } from "node:fs/promises";
import type { DiffFile, DiffResponse } from "../../shared/types";

const DEFAULT_MAX_BYTES = 512_000;
const DEFAULT_MAX_FILE_BYTES = 200_000;

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function git(repo: string, args: string[], okCodes: number[] = [0]): Promise<GitResult> {
	// quotePath=false keeps non ASCII paths readable in the diff headers.
	const proc = Bun.spawn(["git", "-C", repo, "-c", "core.quotePath=false", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (!okCodes.includes(code)) {
		throw new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`);
	}
	return { code, stdout, stderr };
}

interface Porcelain {
	code: string;
	path: string;
}

function parsePorcelain(out: string): Porcelain[] {
	const parts = out.split("\0");
	const entries: Porcelain[] = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i] ?? "";
		if (part.length < 4) continue;
		const code = part.slice(0, 2);
		entries.push({ code, path: part.slice(3) });
		// Renames and copies carry the origin path as the next NUL field.
		if (code.includes("R") || code.includes("C")) i++;
	}
	return entries;
}

function isConflict(code: string): boolean {
	return code.includes("U") || code === "AA" || code === "DD";
}

interface Section {
	path: string;
	status: DiffFile["status"];
	binary: boolean;
	unified: string;
}

function splitDiff(text: string, untracked: boolean): Section[] {
	const sections: Section[] = [];
	const lines = text.split("\n");
	let current: string[] | null = null;
	const blocks: string[][] = [];
	for (const line of lines) {
		if (line.startsWith("diff --git ") || line.startsWith("diff --cc ")) {
			current = [line];
			blocks.push(current);
		} else current?.push(line);
	}
	for (const block of blocks) {
		const first = block[0] ?? "";
		let status: DiffFile["status"] = untracked ? "untracked" : "modified";
		let binary = false;
		let renameTo: string | null = null;
		let hunkStart = -1;
		let minusPath: string | null = null;
		let plusPath: string | null = null;
		for (let i = 1; i < block.length; i++) {
			const line = block[i] as string;
			if (line.startsWith("@@")) {
				hunkStart = i;
				break;
			}
			if (line.startsWith("new file mode") && !untracked) status = "added";
			else if (line.startsWith("deleted file mode")) status = "deleted";
			else if (line.startsWith("rename to ")) {
				status = "renamed";
				renameTo = line.slice("rename to ".length);
			} else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) binary = true;
			else if (line.startsWith("--- ")) minusPath = line.slice(4);
			else if (line.startsWith("+++ ")) plusPath = line.slice(4);
		}
		let path = renameTo;
		if (path === null && plusPath !== null && plusPath !== "/dev/null") path = plusPath.replace(/^b\//, "");
		if (path === null && minusPath !== null && minusPath !== "/dev/null") path = minusPath.replace(/^a\//, "");
		if (path === null) {
			// Binary or mode only change: a/P b/P with identical halves.
			const rest = first.replace(/^diff --(git|cc) /, "");
			const half = (rest.length - 5) / 2;
			path = Number.isInteger(half) && rest.startsWith("a/") ? rest.slice(2, 2 + half) : rest.replace(/^b?\//, "");
		}
		let unified = hunkStart === -1 ? "" : block.slice(hunkStart).join("\n");
		if (unified !== "" && !unified.endsWith("\n")) unified += "\n";
		sections.push({ path, status, binary, unified });
	}
	return sections;
}

function countChanges(unified: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const line of unified.split("\n")) {
		if (line.startsWith("+")) additions++;
		else if (line.startsWith("-")) deletions++;
	}
	return { additions, deletions };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Cuts to at most `limit` bytes on a line boundary so no hunk line is half shown. */
function capBytes(text: string, limit: number): { text: string; cut: boolean } {
	const bytes = encoder.encode(text);
	if (bytes.length <= limit) return { text, cut: false };
	let end = limit;
	while (end > 0 && bytes[end - 1] !== 0x0a) end--;
	return { text: decoder.decode(bytes.subarray(0, end)), cut: true };
}

export async function gitDiff(
	repoPath: string,
	options: { maxBytes?: number; maxFileBytes?: number } = {},
): Promise<DiffResponse> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

	let isDir = false;
	try {
		isDir = (await stat(repoPath)).isDirectory();
	} catch {}
	if (!isDir) throw new Error(`Repo directory does not exist: ${repoPath}`);

	const hasHead = (await git(repoPath, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1])).code === 0;
	const [tracked, status] = await Promise.all([
		git(repoPath, hasHead ? ["diff", "HEAD", "--no-color", "--no-ext-diff", "-U3"] : ["diff", "--cached", "--no-color", "--no-ext-diff", "-U3"]),
		git(repoPath, ["status", "--porcelain", "-z", "-uall"]),
	]);
	const porcelain = parsePorcelain(status.stdout);

	const sections = splitDiff(tracked.stdout, false);
	const conflicts = new Set(porcelain.filter((p) => isConflict(p.code)).map((p) => p.path));
	for (const section of sections) {
		if (conflicts.has(section.path)) section.status = "conflict";
	}
	const seen = new Set(sections.map((s) => s.path));
	for (const path of conflicts) {
		if (!seen.has(path)) sections.push({ path, status: "conflict", binary: false, unified: "" });
	}

	for (const entry of porcelain) {
		if (entry.code !== "??") continue;
		// --no-index exits 1 whenever the files differ, which is always true against /dev/null.
		const result = await git(repoPath, ["diff", "--no-index", "--no-color", "-U3", "/dev/null", entry.path], [0, 1]);
		const parsed = splitDiff(result.stdout, true)[0];
		sections.push(
			parsed
				? { ...parsed, path: entry.path, status: "untracked" }
				: { path: entry.path, status: "untracked", binary: false, unified: "" },
		);
	}

	let truncated = false;
	let remaining = maxBytes;
	const files: DiffFile[] = [];
	for (const section of sections) {
		const unified = section.binary ? "" : section.unified;
		const { additions, deletions } = countChanges(unified);
		const perFile = capBytes(unified, maxFileBytes);
		const total = capBytes(perFile.text, Math.max(remaining, 0));
		if (perFile.cut || total.cut) truncated = true;
		remaining -= encoder.encode(total.text).length;
		files.push({
			path: section.path,
			status: section.status,
			unified: total.text,
			additions,
			deletions,
			binary: section.binary,
		});
	}
	return { repo: repoPath, files, truncated };
}
