// Burrow configuration: defaults, the two files under ~/.config/burrow,
// and the Tailscale identity read once at startup.

import { homedir } from "node:os";
import { join } from "node:path";

export interface BurrowConfig {
	port: number;
	wakePort: number;
	/** Tailscale login of the host's owner; the only accepted caller. */
	ownerLogin: string;
	/** Exact Origin accepted on WebSocket upgrades, for example https://host.tailnet.ts.net */
	origin: string;
	/** Raw allowlist lines from ~/.config/burrow/repos. */
	repos: string[];
	ntfyUrl: string | null;
	/** Command used to spawn omp, for example ["omp", "--mode", "rpc-ui"]. */
	ompCommand: string[];
	sessionsDir: string;
	configDir: string;
	webRoot: string;
	idleTimeoutMs: number;
}

export interface TailscaleIdentity {
	login: string;
	dnsName: string;
}

export interface DetectTailscaleOptions {
	run?: () => Promise<{ code: number; stdout: string; stderr: string }>;
	attempts?: number;
	delayMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_PORT = 7470;
export const DEFAULT_WAKE_PORT = 7471;
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

const CONFIG_DIR = join(homedir(), ".config", "burrow");
const SESSIONS_DIR = join(homedir(), ".omp", "agent", "sessions");

/** Non-empty, trimmed lines. Blank lines are skipped, order is preserved. */
export function parseLineFile(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/** Whitespace split; the omp command has no quoted arguments. */
export function splitCommand(text: string): string[] {
	return text.split(/\s+/).filter((part) => part.length > 0);
}

export async function readTextFile(path: string): Promise<string | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	return await file.text();
}

/** One `tailscale status --json` call, injectable so tests can script the reply. */
async function readTailscaleStatus(): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

/**
 * Reads the host's own Tailscale identity from `tailscale status --json`.
 * `Self.UserID` maps to the login in the `User` map; `Self.DNSName` carries a
 * trailing dot that the Origin header does not.
 *
 * Both services run this at startup, and at boot tailscaled may not have
 * reported a login yet, so it retries for a couple of minutes instead of
 * leaving the phone with nothing to wake.
 */
export async function detectTailscaleIdentity(options: DetectTailscaleOptions = {}): Promise<TailscaleIdentity> {
	const attempts = options.attempts ?? 30;
	const delayMs = options.delayMs ?? 2000;
	const run = options.run ?? readTailscaleStatus;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	let last = "no attempt was made";
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const { code, stdout, stderr } = await run();
			if (code !== 0) throw new Error(`tailscale status failed (${code}): ${stderr.trim()}`);
			const status = JSON.parse(stdout) as {
				Self?: { UserID?: number; DNSName?: string };
				User?: Record<string, { LoginName?: string }>;
			};
			const userId = status.Self?.UserID;
			const login = userId === undefined ? undefined : status.User?.[String(userId)]?.LoginName;
			const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
			if (!login || !dnsName) throw new Error("tailscale status --json carried no self login or DNS name");
			return { login, dnsName };
		} catch (error) {
			last = error instanceof Error ? error.message : String(error);
			if (attempt < attempts) {
				console.log(`tailscale identity not ready (${last}), retrying in ${delayMs} ms`);
				await sleep(delayMs);
			}
		}
	}
	throw new Error(`tailscale identity unavailable after ${attempts} attempts: ${last}`);
}

function intFromEnv(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	// 0 is allowed: it means "pick a free port", which tests rely on.
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`invalid number in environment: ${value}`);
	return parsed;
}

export async function loadConfig(env: Record<string, string | undefined> = Bun.env): Promise<BurrowConfig> {
	const configDir = env.BURROW_CONFIG_DIR ?? CONFIG_DIR;
	const reposFile = env.BURROW_REPOS_FILE ?? join(configDir, "repos");
	const ntfyFile = env.BURROW_NTFY_FILE ?? join(configDir, "ntfy");

	const reposText = (await readTextFile(reposFile)) ?? "";
	const ntfyText = await readTextFile(ntfyFile);
	const ntfyLines = ntfyText === null ? [] : parseLineFile(ntfyText);

	const ownerLogin = env.BURROW_OWNER_LOGIN ?? "";
	const origin = env.BURROW_ORIGIN ?? "";
	let identity: TailscaleIdentity | null = null;
	if (ownerLogin === "" || origin === "") identity = await detectTailscaleIdentity();

	return {
		port: intFromEnv(env.BURROW_PORT, DEFAULT_PORT),
		wakePort: intFromEnv(env.BURROW_WAKE_PORT, DEFAULT_WAKE_PORT),
		ownerLogin: ownerLogin === "" ? identity!.login : ownerLogin,
		origin: origin === "" ? `https://${identity!.dnsName}` : origin,
		repos: parseLineFile(reposText),
		ntfyUrl: ntfyLines[0] ?? null,
		ompCommand: env.BURROW_OMP_COMMAND ? splitCommand(env.BURROW_OMP_COMMAND) : ["omp", "--mode", "rpc-ui"],
		sessionsDir: env.BURROW_SESSIONS_DIR ?? SESSIONS_DIR,
		configDir,
		webRoot: env.BURROW_WEB_ROOT ?? join(import.meta.dir, "..", "..", "dist", "web"),
		idleTimeoutMs: intFromEnv(env.BURROW_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS),
	};
}
