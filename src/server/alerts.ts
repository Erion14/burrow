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
    try {
      const pending = doFetch(url, {
        method: "POST",
        body,
        headers: {
          Title: repoName,
          Click: `${options.origin}/?session=${encodeURIComponent(sessionId)}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      Promise.resolve(pending).catch(() => {});
    } catch {
      // a failed push must never disturb a session
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
