import { readdir, readlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

export interface OpenProcOptions {
	excludePids?: Set<number>;
	ownPid?: number;
}

/**
 * Maps session file path to the pid holding it open. omp keeps its session file
 * open, so /proc/<pid>/fd is how a session at the host is detected.
 */
export async function sessionFileOwners(
	sessionsDir: string,
	options: OpenProcOptions = {},
): Promise<Map<string, number>> {
	const owners = new Map<string, number>();
	const ownPid = options.ownPid ?? process.pid;
	const prefix = sessionsDir.endsWith(sep) ? sessionsDir : sessionsDir + sep;
	let pids: string[];
	try {
		pids = await readdir("/proc");
	} catch {
		return owners;
	}
	await Promise.all(
		pids.map(async (name) => {
			if (!/^\d+$/.test(name)) return;
			const pid = Number(name);
			if (pid === ownPid || options.excludePids?.has(pid)) return;
			let fds: string[];
			try {
				fds = await readdir(`/proc/${name}/fd`);
			} catch {
				return;
			}
			const found: string[] = [];
			for (const fd of fds) {
				try {
					const target = await readlink(join("/proc", name, "fd", fd));
					if (target.startsWith(prefix) && target.endsWith(".jsonl")) found.push(target);
				} catch {}
			}
			for (const target of found) {
				const current = owners.get(target);
				// Lowest pid wins so the answer does not depend on scan timing.
				if (current === undefined || pid < current) owners.set(target, pid);
			}
		}),
	);
	return owners;
}

/** Session files live at <sessionsDir>/<folder>/<file>.jsonl, so the scan root is two levels up. */
export async function isSessionOpen(path: string, options: OpenProcOptions = {}): Promise<boolean> {
	return (await sessionFileOwners(dirname(dirname(path)), options)).has(path);
}
