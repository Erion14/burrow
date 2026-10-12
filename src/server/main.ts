// Burrow's composition root: config, the omp session manager, the HTTP and
// WebSocket surface, the idle stopper. Started by burrow.service when Remote
// mode is on, stopped by `remote.sh off`.

import { createAlerter } from "./alerts";
import { loadConfig } from "./config";
import { createHttpServer } from "./http";
import { createIdleStopper } from "./idle";
import { gitDiff } from "./repos/diff";
import { createSessionManager } from "./sessions/manager";
import { createHub } from "./ws";

const config = await loadConfig();

const alerter = createAlerter({ ntfyUrl: config.ntfyUrl, origin: config.origin });
const manager = createSessionManager({ config, alerter });
const hub = createHub({
	manager,
	origin: config.origin,
	ownerLogin: config.ownerLogin,
	repos: config.repos,
});
const server = createHttpServer({
	config,
	manager,
	hub,
	diff: (repoPath: string) => gitDiff(repoPath),
});

// One phone attached to a session is enough to keep it alive; the socket count
// is per session, so the stopper never counts a socket looking at another one.
const idle = createIdleStopper({
	manager,
	attachedCount: (sessionId: string) => (hub.attachedSessionIds().has(sessionId) ? 1 : 0),
	timeoutMs: config.idleTimeoutMs,
});
idle.start();

console.log(
	`burrow listening on http://127.0.0.1:${server.port} ` +
		`(owner ${config.ownerLogin}, origin ${config.origin}, ${config.repos.length} allowlisted repos)`,
);
if (config.repos.length === 0) console.warn(`no allowlisted repos: add absolute paths to ${config.configDir}/repos`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.log(`burrow shutting down (${signal})`);
	idle.stop();
	await server.stop(true);
	hub.close();
	await manager.shutdown();
	process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
