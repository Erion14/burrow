// Who holds a session file open. Taking a session over signals the holder, and the
// holder may be something else entirely (a `tail -f` on the session file), which
// must never be signalled. Everything here reads /proc and never throws.

import { readFile, readlink } from "node:fs/promises";
import { basename } from "node:path";

async function argv0(pid: number): Promise<string> {
	try {
		return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0")[0] ?? "";
	} catch {
		return "";
	}
}

async function exePath(pid: number): Promise<string> {
	try {
		return await readlink(`/proc/${pid}/exe`);
	} catch {
		return "";
	}
}

/** True when the process is an omp: launched as `omp...`, or its binary lives in an omp install. */
export async function isOmpProcess(pid: number): Promise<boolean> {
	const [arg0, exe] = await Promise.all([argv0(pid), exePath(pid)]);
	if (arg0 !== "" && basename(arg0).startsWith("omp")) return true;
	return exe.endsWith("/omp") || exe.includes("/omp/");
}

/** The kernel's short name for the process, for messages; the pid when /proc has none. */
export async function processName(pid: number): Promise<string> {
	try {
		const comm = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
		return comm === "" ? `pid ${pid}` : comm;
	} catch {
		return `pid ${pid}`;
	}
}
