// The file menu's one call: the session repo's paths for a query. A failure is
// null rather than an exception, because the menu shows nothing instead of an
// error banner, and an answer is cached per session and query so narrowing and
// retyping a path does not ask the repo index for rows it already ranked.

export interface FilesAnswer {
	items: { path: string; dir: boolean }[];
	truncated: boolean;
}

/** The rows the phone asks for, the API's own default cap. */
const LIMIT = 20;

/** Distinct session and query pairs kept; the oldest is dropped past that. */
const CACHE_LIMIT = 40;

const cache = new Map<string, FilesAnswer>();

function remember(key: string, answer: FilesAnswer): void {
	if (cache.size >= CACHE_LIMIT) {
		const oldest = cache.keys().next();
		if (!oldest.done) cache.delete(oldest.value);
	}
	cache.set(key, answer);
}

/**
 * The file rows for a query in a session's repo, or null when the server refuses
 * the session or the request never lands. The query is what the user typed after
 * the `@`; the server owns the ranking.
 */
export async function fetchFiles(sessionId: string, query: string, signal?: AbortSignal): Promise<FilesAnswer | null> {
	const key = `${sessionId}:${query}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	try {
		const response = await fetch(
			`/api/files?session=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(query)}&limit=${LIMIT}`,
			signal === undefined ? undefined : { signal },
		);
		if (!response.ok) return null;
		const answer = (await response.json()) as FilesAnswer;
		remember(key, answer);
		return answer;
	} catch {
		// Offline, aborted, or a body that is not JSON: the menu stays closed.
		return null;
	}
}
