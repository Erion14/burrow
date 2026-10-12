// Tailscale identity is the whole of Burrow's auth. `tailscale serve` injects
// Tailscale-User-Login for every proxied request, so a request without it did
// not come through the proxy. Binding to 127.0.0.1 is not auth on its own: a
// page in the laptop's browser can reach the loopback port directly, which is
// also why a WebSocket upgrade additionally has to carry the Burrow Origin.

import type { BurrowConfig } from "./config";

export const IDENTITY_HEADER = "tailscale-user-login";

export interface AuthDenial {
	code: "forbidden_identity" | "forbidden_origin";
	message: string;
}

export interface AuthOptions {
	/** WebSocket upgrades are also checked against the Burrow Origin. */
	requireOrigin?: boolean;
}

export function authorizeRequest(req: Request, config: BurrowConfig, options: AuthOptions = {}): AuthDenial | null {
	const login = req.headers.get(IDENTITY_HEADER);
	if (login === null || login.toLowerCase() !== config.ownerLogin.toLowerCase()) {
		return {
			code: "forbidden_identity",
			message: `requests need a ${IDENTITY_HEADER} header matching the laptop owner over Tailscale`,
		};
	}
	if (options.requireOrigin === true) {
		const origin = req.headers.get("origin");
		if (origin !== config.origin) {
			return { code: "forbidden_origin", message: `WebSocket upgrades need the Origin ${config.origin}` };
		}
	}
	return null;
}

export function denialResponse(denial: AuthDenial): Response {
	return Response.json({ error: { code: denial.code, message: denial.message } }, { status: 403 });
}
