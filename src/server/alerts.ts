const DIALOG_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true, ask: true };

export interface AlerterOptions {
  ntfyUrl: string | null;
  origin: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface Alerter {
  sessionSettled(input: { sessionId: string; repoName: string; durationMs?: number }): void;
  dialogOpened(input: { sessionId: string; repoName: string; method: string }): void;
  needsAnswer(method: string): boolean;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function needsAnswer(method: string): boolean {
  return Object.hasOwn(DIALOG_METHODS, method);
}

export function createAlerter(options: AlerterOptions): Alerter {
  const doFetch = options.fetchImpl ?? fetch;

  function post(sessionId: string, repoName: string, body: string): void {
    const url = options.ntfyUrl;
    if (!url) return;
    const headers: Record<string, string> = {
      Click: `${options.origin}/?session=${encodeURIComponent(sessionId)}`,
    };
    // fetch rejects a header value outside Latin-1 (a Cyrillic repo name) and
    // ntfy reads raw header bytes as UTF-8, so only printable ASCII is safe.
    // NFKD first so accented Latin letters keep their base letter.
    const title = repoName.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").trim();
    if (title !== "") headers.Title = title;
    const report = (err: unknown) => {
      // A failed push must never disturb a session, but it should not vanish either.
      console.warn(`ntfy alert for ${repoName} failed: ${err instanceof Error ? err.message : String(err)}`);
    };
    try {
      const pending = doFetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(10_000) });
      Promise.resolve(pending).catch(report);
    } catch (err) {
      report(err);
    }
  }

  return {
    sessionSettled({ sessionId, repoName, durationMs }) {
      post(sessionId, repoName, durationMs === undefined ? "Finished" : `Finished (${formatDuration(durationMs)})`);
    },
    dialogOpened({ sessionId, repoName, method }) {
      if (!needsAnswer(method)) return;
      post(sessionId, repoName, "Needs your answer");
    },
    needsAnswer,
  };
}
