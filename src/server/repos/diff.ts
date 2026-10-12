import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DiffFile, DiffResponse } from "../../shared/types";

const DEFAULT_MAX_BYTES = 512_000;
const DEFAULT_MAX_FILE_BYTES = 200_000;
/** Per git call: the response is capped far lower, this only bounds memory. */
const DEFAULT_MAX_OUTPUT_BYTES = 8_000_000;
/** Well under any client patience; past it the response is cut, not failed. */
const DEFAULT_DEADLINE_MS = 20_000;
const DEFAULT_MAX_UNTRACKED_FILES = 200;
const DEFAULT_MAX_UNTRACKED_FILE_BYTES = 1_048_576;
const STDERR_LIMIT_BYTES = 64_000;
/** Untracked files are diffed one git process each; this many run at once. */
const UNTRACKED_CONCURRENCY = 8;
/** Skipped file names listed in a notice line before the rest is summed up. */
const NOTICE_NAME_LIMIT = 5;

export interface DiffOptions {
	/** Cap on the unified text of the whole response. */
	maxBytes?: number;
	/** Cap on the unified text of one file. */
	maxFileBytes?: number;
	/** Cap on what is read from one git process. */
	maxOutputBytes?: number;
	/** Wall-clock budget of the whole diff; past it the response is truncated. */
	deadlineMs?: number;
	/** Untracked files rendered per repository. */
	maxUntrackedFiles?: number;
	/** Untracked files larger than this are listed in the notice instead of diffed. */
	maxUntrackedFileBytes?: number;
}

/** Limits shared by every git call of one diff, plus what got cut. */
interface Budget {
	deadline: number;
	deadlineMs: number;
	maxOutputBytes: number;
	maxUntrackedFiles: number;
	maxUntrackedFileBytes: number;
	timedOut: boolean;
	outputCut: boolean;
}

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
	/** The output is partial: the deadline passed or the output cap was hit. */
	cut: boolean;
}

/** Reads at most `limit` bytes; a cut can end mid record, see `wholeRecords`. */
async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<{ text: string; cut: boolean }> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return { text: decoder.decode(Buffer.concat(chunks)), cut: false };
		if (size + value.length <= limit) {
			chunks.push(value);
			size += value.length;
			continue;
		}
		chunks.push(value.subarray(0, limit - size));
		await reader.cancel();
		return { text: decoder.decode(Buffer.concat(chunks)), cut: true };
	}
}

/**
 * Runs git without ever holding more than the output cap or outliving the
 * deadline. A cut result is partial output, not a failure, so its exit code
 * (a kill) is not checked.
 */
async function git(repo: string, args: string[], budget: Budget, okCodes: number[] = [0]): Promise<GitResult> {
	const remaining = budget.deadline - Date.now();
	if (remaining <= 0) {
		budget.timedOut = true;
		return { code: -1, stdout: "", stderr: "", cut: true };
	}
	// quotePath=false keeps non ASCII paths readable in the diff headers.
	const proc = Bun.spawn(["git", "-C", repo, "-c", "core.quotePath=false", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, remaining);
	const [stdout, stderr, code] = await Promise.all([
		readCapped(proc.stdout, budget.maxOutputBytes).then((result) => {
			if (result.cut) proc.kill();
			return result;
		}),
		readCapped(proc.stderr, STDERR_LIMIT_BYTES),
		proc.exited,
	]);
	clearTimeout(timer);
	if (timedOut) budget.timedOut = true;
	else if (stdout.cut) budget.outputCut = true;
	const cut = timedOut || stdout.cut;
	if (!cut && !okCodes.includes(code)) {
		throw new Error(`git ${args[0]} failed (${code}): ${stderr.text.trim()}`);
	}
	return { code, stdout: stdout.text, stderr: stderr.text, cut };
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

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** Output of a git call without the half record a cut leaves at the end. */
function wholeRecords(result: GitResult, separator: string): string {
	return result.cut ? result.stdout.slice(0, result.stdout.lastIndexOf(separator) + 1) : result.stdout;
}

interface RepoDiff {
	sections: Section[];
	/** Notice lines about what this repository left out. */
	notes: string[];
	truncated: boolean;
}

/** Sections of one git working tree, paths relative to it. Throws when git fails. */
async function repoSections(repoPath: string, budget: Budget): Promise<RepoDiff> {
	const head = await git(repoPath, ["rev-parse", "--verify", "--quiet", "HEAD"], budget, [0, 1]);
	if (head.cut) return { sections: [], notes: [], truncated: true };
	const [tracked, status] = await Promise.all([
		git(
			repoPath,
			head.code === 0 ? ["diff", "HEAD", "--no-color", "--no-ext-diff", "-U3"] : ["diff", "--cached", "--no-color", "--no-ext-diff", "-U3"],
			budget,
		),
		git(repoPath, ["status", "--porcelain", "-z", "-uall"], budget),
	]);
	const porcelain = parsePorcelain(wholeRecords(status, "\0"));
	const notes: string[] = [];
	let truncated = tracked.cut || status.cut;

	const sections = splitDiff(wholeRecords(tracked, "\n"), false);
	const conflicts = new Set(porcelain.filter((p) => isConflict(p.code)).map((p) => p.path));
	for (const section of sections) {
		if (conflicts.has(section.path)) section.status = "conflict";
	}
	const seen = new Set(sections.map((s) => s.path));
	for (const path of conflicts) {
		if (!seen.has(path)) sections.push({ path, status: "conflict", binary: false, unified: "" });
	}

	// A build output or dependency tree left untracked can hold thousands of
	// files; stat first so oversized ones never reach git, and stop at the cap.
	const untracked = porcelain.filter((p) => p.code === "??").map((p) => p.path);
	const chosen: { path: string; directory: boolean }[] = [];
	const oversized: string[] = [];
	let examined = 0;
	for (const path of untracked) {
		if (chosen.length >= budget.maxUntrackedFiles) break;
		if (Date.now() >= budget.deadline) {
			budget.timedOut = true;
			break;
		}
		examined++;
		try {
			const info = await lstat(join(repoPath, path));
			if (info.isFile() && info.size > budget.maxUntrackedFileBytes) oversized.push(path);
			else chosen.push({ path, directory: info.isDirectory() });
		} catch {
			// Gone since git status ran.
		}
	}
	if (examined < untracked.length) {
		truncated = true;
		if (!budget.timedOut) notes.push(`showing ${chosen.length} of ${untracked.length} untracked files`);
	}
	if (oversized.length > 0) {
		truncated = true;
		const names = oversized.slice(0, NOTICE_NAME_LIMIT).join(", ");
		const more = oversized.length > NOTICE_NAME_LIMIT ? `, and ${oversized.length - NOTICE_NAME_LIMIT} more` : "";
		const files = oversized.length === 1 ? "file" : "files";
		notes.push(`skipped ${oversized.length} untracked ${files} over ${Math.round(budget.maxUntrackedFileBytes / 1024)} KB: ${names}${more}`);
	}

	const rendered: (Section | undefined)[] = new Array(chosen.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < chosen.length) {
			const index = next++;
			const entry = chosen[index];
			if (entry === undefined) return;
			// An untracked nested repository: git would diff its whole tree.
			if (entry.directory) {
				rendered[index] = { path: entry.path, status: "untracked", binary: false, unified: "" };
				continue;
			}
			// --no-index exits 1 whenever the files differ, which is always true against /dev/null.
			const result = await git(repoPath, ["diff", "--no-index", "--no-color", "-U3", "/dev/null", entry.path], budget, [0, 1]);
			if (budget.timedOut) return;
			const parsed = splitDiff(wholeRecords(result, "\n"), true)[0];
			rendered[index] = parsed
				? { ...parsed, path: entry.path, status: "untracked" }
				: { path: entry.path, status: "untracked", binary: false, unified: "" };
		}
	};
	await Promise.all(Array.from({ length: Math.min(UNTRACKED_CONCURRENCY, chosen.length) }, worker));
	for (const section of rendered) if (section !== undefined) sections.push(section);
	if (budget.timedOut) truncated = true;
	return { sections, notes, truncated };
}

function buildFiles(sections: Section[], maxBytes: number, maxFileBytes: number): { files: DiffFile[]; truncated: boolean } {
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
	return { files, truncated };
}

const MAX_CHILD_REPOS = 8;

/**
 * Diff of a git working tree. When `repoPath` is not one (a workspace directory
 * holding several repos), the immediate child repositories are diffed and merged
 * with paths prefixed by the child name, and `notice` explains it. Whatever the
 * limits leave out sets `truncated` and gets a `notice` line.
 */
export async function gitDiff(repoPath: string, options: DiffOptions = {}): Promise<DiffResponse> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
	const budget: Budget = {
		deadline: Date.now() + deadlineMs,
		deadlineMs,
		maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
		maxUntrackedFiles: options.maxUntrackedFiles ?? DEFAULT_MAX_UNTRACKED_FILES,
		maxUntrackedFileBytes: options.maxUntrackedFileBytes ?? DEFAULT_MAX_UNTRACKED_FILE_BYTES,
		timedOut: false,
		outputCut: false,
	};
	const limitNotes = (): string[] => {
		const lines: string[] = [];
		if (budget.timedOut) lines.push(`diff stopped after ${budget.deadlineMs / 1000} s; the rest is not shown`);
		if (budget.outputCut) lines.push(`git output over ${Math.round(budget.maxOutputBytes / 1024)} KB was cut`);
		return lines;
	};

	if (!(await isDirectory(repoPath))) throw new Error(`Repo directory does not exist: ${repoPath}`);

	const inside = await git(repoPath, ["rev-parse", "--is-inside-work-tree"], budget, [0, 128]);
	if (inside.cut) return { repo: repoPath, files: [], truncated: true, notice: limitNotes().join("\n") };
	if (inside.code === 0 && inside.stdout.trim() === "true") {
		const repo = await repoSections(repoPath, budget);
		const built = buildFiles(repo.sections, maxBytes, maxFileBytes);
		const notes = [...repo.notes, ...limitNotes()];
		const response: DiffResponse = { repo: repoPath, files: built.files, truncated: built.truncated || repo.truncated };
		if (notes.length > 0) response.notice = notes.join("\n");
		return response;
	}

	const notLines: string[] = [];
	let entries: string[] = [];
	try {
		entries = (await readdir(repoPath, { withFileTypes: true }))
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => e.name)
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	} catch {}
	const children: string[] = [];
	for (const name of entries) {
		if (children.length >= MAX_CHILD_REPOS) break;
		try {
			await stat(join(repoPath, name, ".git"));
			children.push(name);
		} catch {}
	}

	const merged: Section[] = [];
	let shown = 0;
	let truncated = false;
	for (const name of children) {
		if (budget.timedOut) break;
		try {
			const repo = await repoSections(join(repoPath, name), budget);
			for (const s of repo.sections) merged.push({ ...s, path: `${name}/${s.path}` });
			for (const note of repo.notes) notLines.push(`${name}: ${note}`);
			if (repo.truncated) truncated = true;
			shown++;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			notLines.push(`${name}: ${msg.split("\n")[0]}`);
		}
	}
	merged.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	const head =
		children.length === 0
			? "not a git repository and no git repositories found one level below"
			: `not a git repository; showing ${shown} git ${shown === 1 ? "repository" : "repositories"} below`;
	const built = buildFiles(merged, maxBytes, maxFileBytes);
	return {
		repo: repoPath,
		files: built.files,
		truncated: built.truncated || truncated || budget.timedOut,
		notice: [head, ...notLines, ...limitNotes()].join("\n"),
	};
}
