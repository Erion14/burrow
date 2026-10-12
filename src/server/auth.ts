// Tailscale identity is the whole of Burrow's auth. `tailscale serve` injects
// Tailscale-User-Login for every proxied request, so a request without it did
// not come through the proxy. Binding to 127.0.0.1 is not auth on its own: a
// page in the laptop's browser can reach the loopback port directly, which is
// also why a WebSocket upgrade additionally has to carry the Burrow Origin.
// The identity header is also added to cross-site requests from any page open
// in the owner's browser (a form POST or a no-cors fetch needs no preflight),
// so state-changing methods must prove they come from the Burrow origin too.

import type { BurrowConfig } from "./config";

export const IDENTITY_HEADER = "tailscale-user-login";

const STATE_CHANGING_METHODS: Record<string, true> = { POST: true, PUT: true, PATCH: true, DELETE: true };
/** Fetch metadata that only a same-origin page or a direct, user-typed request carries. */
const TRUSTED_FETCH_SITES: Record<string, true> = { "same-origin": true, none: true };

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
	const origin = req.headers.get("origin");
	if (options.requireOrigin === true) {
		if (origin !== config.origin) {
			return { code: "forbidden_origin", message: `WebSocket upgrades need the Origin ${config.origin}` };
		}
	} else if (Object.hasOwn(STATE_CHANGING_METHODS, req.method) && origin !== config.origin) {
		// The installed PWA and curl may omit Origin but then send a trusted Sec-Fetch-Site.
		const site = req.headers.get("sec-fetch-site");
		if (origin !== null || site === null || !Object.hasOwn(TRUSTED_FETCH_SITES, site)) {
			return { code: "forbidden_origin", message: `${req.method} requests need the Origin ${config.origin}` };
		}
	}
	return null;
}

export function denialResponse(denial: AuthDenial): Response {
	return Response.json({ error: { code: denial.code, message: denial.message } }, { status: 403 });
}
