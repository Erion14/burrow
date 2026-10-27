import { describe, expect, test } from "bun:test";
import { authorizeRequest, denialResponse } from "./auth";
import type { BurrowConfig } from "./config";

const config = { ownerLogin: "Owner@Example.com", origin: "https://host.tailnet.ts.net" } as BurrowConfig;

function req(headers: Record<string, string>): Request {
	return new Request("http://127.0.0.1:7470/", { headers });
}

describe("authorizeRequest identity", () => {
	test("owner login passes", () => {
		expect(authorizeRequest(req({ "Tailscale-User-Login": "Owner@Example.com" }), config)).toBeNull();
	});
	test("case differences pass", () => {
		expect(authorizeRequest(req({ "Tailscale-User-Login": "owner@example.COM" }), config)).toBeNull();
	});
	test("missing header is denied", () => {
		expect(authorizeRequest(req({}), config)?.code).toBe("forbidden_identity");
	});
	test("empty header is denied", () => {
		expect(authorizeRequest(req({ "Tailscale-User-Login": "" }), config)?.code).toBe("forbidden_identity");
	});
	test("different login is denied", () => {
		expect(authorizeRequest(req({ "Tailscale-User-Login": "other@example.com" }), config)?.code).toBe(
			"forbidden_identity",
		);
	});
});

describe("authorizeRequest origin", () => {
	const login = { "Tailscale-User-Login": "owner@example.com" };
	const opts = { requireOrigin: true };
	test("exact origin passes", () => {
		expect(authorizeRequest(req({ ...login, Origin: config.origin }), config, opts)).toBeNull();
	});
	test("missing origin is denied", () => {
		expect(authorizeRequest(req(login), config, opts)?.code).toBe("forbidden_origin");
	});
	test("different host is denied", () => {
		expect(authorizeRequest(req({ ...login, Origin: "https://evil.example.com" }), config, opts)?.code).toBe(
			"forbidden_origin",
		);
	});
	test("trailing slash variant is denied", () => {
		expect(authorizeRequest(req({ ...login, Origin: `${config.origin}/` }), config, opts)?.code).toBe(
			"forbidden_origin",
		);
	});
	test("origin is not checked on GET unless required", () => {
		expect(authorizeRequest(req(login), config)).toBeNull();
	});
	test("state-changing methods need the Burrow Origin or trusted fetch metadata", () => {
		const post = (headers: Record<string, string>, method = "POST") =>
			authorizeRequest(new Request("http://127.0.0.1:7470/", { method, headers: { ...login, ...headers } }), config);
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			expect(post({}, method)?.code).toBe("forbidden_origin");
			expect(post({ Origin: "https://evil.example.com" }, method)?.code).toBe("forbidden_origin");
			expect(post({ Origin: config.origin }, method)).toBeNull();
		}
		expect(post({ "Sec-Fetch-Site": "same-origin" })).toBeNull();
		expect(post({ "Sec-Fetch-Site": "none" })).toBeNull();
		expect(post({ "Sec-Fetch-Site": "cross-site" })?.code).toBe("forbidden_origin");
		expect(post({ Origin: "null", "Sec-Fetch-Site": "same-origin" })?.code).toBe("forbidden_origin");
	});
});

describe("denialResponse", () => {
	test("is 403 with the error body shape", async () => {
		const res = denialResponse({ code: "forbidden_identity", message: "nope" });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: { code: "forbidden_identity", message: "nope" } });
	});
});
