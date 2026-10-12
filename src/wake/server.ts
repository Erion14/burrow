// Always-on wake path: the only thing that answers while Burrow is off.
// Tailscale serve may or may not strip the /wake prefix, so both forms work.

import type { Server } from "bun";
import { authorizeRequest, denialResponse } from "../server/auth";
import type { BurrowConfig } from "../server/config";

export type RemoteAction = "on" | "off";

function actionFor(method: string, path: string): RemoteAction | "health" | null {
	if (method === "POST") {
		if (path.endsWith("/wake/off") || path.endsWith("/off")) return "off";
		if (path.endsWith("/wake/on") || path.endsWith("/wake") || path === "/") return "on";
	}
	if (method === "GET" && (path.endsWith("/wake") || path === "/" || path.endsWith("/"))) return "health";
	return null;
}

export function createWakeServer(config: BurrowConfig, runRemote: (action: RemoteAction) => Promise<void>): Server<undefined> {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: config.wakePort,
		async fetch(req) {
			const denial = authorizeRequest(req, config);
			if (denial !== null) return denialResponse(denial);

			const action = actionFor(req.method, new URL(req.url).pathname);
			if (action === null) {
				return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
			}
			if (action === "health") return Response.json({ ok: true });
			try {
				await runRemote(action);
				return Response.json({ ok: true });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return Response.json({ error: { code: "remote_failed", message } }, { status: 500 });
			}
		},
	});
}
