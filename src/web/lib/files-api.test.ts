// The file menu's one call. It must never raise into the screen: the menu shows
// nothing instead of an error banner, and a repeated query is served from the
// cache so retyping a path does not hammer the repo index.

import { afterEach, describe, expect, test } from "bun:test";
import { fetchFiles } from "./files-api";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

interface Stub {
	calls: () => number;
	urls: () => string[];
}

/** Answers every call with `body`, counting them so the cache is visible. */
function stubFetch(body: unknown, status = 200): Stub {
	let calls = 0;
	const urls: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		calls++;
		urls.push(String(input));
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { calls: () => calls, urls: () => urls };
}

describe("fetchFiles", () => {
	test("encodes the session and the query, and asks for 20 rows", async () => {
		const stub = stubFetch({ items: [{ path: "src/a.ts", dir: false }], truncated: true });
		const answer = await fetchFiles("s 1", "src &co");
		expect(stub.urls()).toEqual(["/api/files?session=s%201&q=src%20%26co&limit=20"]);
		expect(answer).toEqual({ items: [{ path: "src/a.ts", dir: false }], truncated: true });
	});

	test("a non-OK answer is null", async () => {
		stubFetch({ error: "session_not_found" }, 404);
		expect(await fetchFiles("gone", "src")).toBeNull();
	});

	test("a thrown fetch is null", async () => {
		globalThis.fetch = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		expect(await fetchFiles("s1", "src")).toBeNull();
	});

	test("a repeated query is served from the cache", async () => {
		const stub = stubFetch({ items: [{ path: "src", dir: true }], truncated: false });
		const first = await fetchFiles("cache-1", "src");
		const second = await fetchFiles("cache-1", "src");
		expect(stub.calls()).toBe(1);
		expect(second).toEqual(first);
		// A different query is a different entry.
		await fetchFiles("cache-1", "src/");
		expect(stub.calls()).toBe(2);
	});

	test("a failure is not cached", async () => {
		stubFetch({ error: "nope" }, 500);
		await fetchFiles("fail-1", "src");
		const ok = stubFetch({ items: [{ path: "src", dir: true }], truncated: false });
		await fetchFiles("fail-1", "src");
		expect(ok.calls()).toBe(1);
	});

	test("the cache drops its oldest entry past 40 queries", async () => {
		const stub = stubFetch({ items: [], truncated: false });
		for (let i = 0; i < 41; i++) await fetchFiles("cap-1", `q${i}`);
		expect(stub.calls()).toBe(41);
		// The first query was pushed out; the last one is still served from the map.
		await fetchFiles("cap-1", "q0");
		await fetchFiles("cap-1", "q40");
		expect(stub.calls()).toBe(42);
	});

	test("the abort signal reaches the request", async () => {
		let seen: AbortSignal | undefined;
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			seen = init?.signal ?? undefined;
			return new Response(JSON.stringify({ items: [], truncated: false }));
		}) as unknown as typeof fetch;
		const controller = new AbortController();
		await fetchFiles("sig-1", "", controller.signal);
		expect(seen).toBe(controller.signal);
	});
});
