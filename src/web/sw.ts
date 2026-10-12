// Service worker: caches the app shell so Burrow opens while the server is
// off, and never caches anything dynamic (/api, /ws, /wake).
//
// The tsconfig has the DOM lib only, so the few service worker globals used
// here are declared locally instead of pulling in the webworker lib.

interface ExtendableEvent extends Event {
	waitUntil(promise: Promise<unknown>): void;
}

interface FetchEvent extends ExtendableEvent {
	readonly request: Request;
	respondWith(response: Promise<Response> | Response): void;
}

interface WorkerScope {
	skipWaiting(): Promise<void>;
	clients: { claim(): Promise<void> };
	addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
	addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
}

const scope = self as unknown as WorkerScope;

const CACHE = "burrow-shell";
const SHELL_URL = "/index.html";
const STATIC_FILES = [SHELL_URL, "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];
const NEVER_CACHED = ["/api", "/ws", "/wake"];

function isDynamic(pathname: string): boolean {
	return NEVER_CACHED.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isStatic(pathname: string): boolean {
	return pathname.startsWith("/assets/") || pathname.startsWith("/icons/") || pathname === "/manifest.webmanifest";
}

/** Bundle files the built index.html references (entry, css, preloaded chunks). */
function assetsIn(html: string): string[] {
	const found = new Set<string>();
	for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) found.add(match[1]!);
	return [...found];
}

async function installShell(): Promise<void> {
	const cache = await caches.open(CACHE);
	// Fetched as "/" (what navigations request) and stored under SHELL_URL.
	const response = await fetch("/", { cache: "reload" });
	if (!response.ok) throw new Error(`shell fetch failed: ${response.status}`);
	const html = await response.clone().text();
	await cache.put(SHELL_URL, response);
	await cache.addAll([...STATIC_FILES.slice(1), ...assetsIn(html)]);
}

// Hashed bundle names change on every deploy; drop the ones the new shell no
// longer references so the cache does not grow forever.
async function dropStaleAssets(): Promise<void> {
	const cache = await caches.open(CACHE);
	const shell = await cache.match(SHELL_URL);
	if (shell === undefined) return;
	const keep = assetsIn(await shell.text());
	for (const request of await cache.keys()) {
		const { pathname } = new URL(request.url);
		if (pathname.startsWith("/assets/") && !keep.includes(pathname)) await cache.delete(request);
	}
}

async function navigate(request: Request): Promise<Response> {
	const cache = await caches.open(CACHE);
	try {
		const response = await fetch(request);
		// With Burrow off, tailscale serve answers 502: that is "down", not a page.
		if (response.ok) return response;
	} catch {
		// network failure: fall through to the cached shell
	}
	const shell = await cache.match(SHELL_URL);
	if (shell !== undefined) return shell;
	return fetch(request);
}

async function cacheFirst(request: Request): Promise<Response> {
	const cache = await caches.open(CACHE);
	const hit = await cache.match(request);
	if (hit !== undefined) return hit;
	const response = await fetch(request);
	if (response.ok) await cache.put(request, response.clone());
	return response;
}

scope.addEventListener("install", (event) => {
	event.waitUntil(installShell().then(() => scope.skipWaiting()));
});

scope.addEventListener("activate", (event) => {
	event.waitUntil(dropStaleAssets().then(() => scope.clients.claim()));
});

scope.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== location.origin || isDynamic(url.pathname)) return;
	if (request.mode === "navigate") {
		event.respondWith(navigate(request));
		return;
	}
	if (isStatic(url.pathname)) event.respondWith(cacheFirst(request));
});
