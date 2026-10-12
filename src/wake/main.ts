import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../server/config";
import { createWakeServer, type RemoteAction } from "./server";

const remoteScript = Bun.env.BURROW_REMOTE_SH ?? join(homedir(), ".config", "hypr", "scripts", "remote.sh");

async function runRemote(action: RemoteAction): Promise<void> {
	const proc = Bun.spawn([remoteScript, action], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		const detail = (stderr || stdout).trim();
		throw new Error(`remote.sh ${action} exited with code ${code}${detail ? `: ${detail}` : ""}`);
	}
}

const config = await loadConfig();
const server = createWakeServer(config, runRemote);
console.log(`burrow-wake listening on http://${server.hostname}:${server.port}`);
