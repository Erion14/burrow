import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAlerter, formatDuration } from "./alerts";

interface Hit {
  body: string;
  title: string | null;
  click: string | null;
}

let server: Bun.Server<undefined>;
let hits: Hit[];
let mode: "ok" | "500" | "close";

beforeEach(() => {
  hits = [];
  mode = "ok";
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      hits.push({ body: await req.text(), title: req.headers.get("Title"), click: req.headers.get("Click") });
      if (mode === "close") {
        server.stop(true);
        return new Response("x");
      }
      return new Response("", { status: mode === "500" ? 500 : 200 });
    },
  });
});

afterEach(() => {
  server.stop(true);
});

async function waitFor(n: number): Promise<void> {
  for (let i = 0; i < 100 && hits.length < n; i++) await Bun.sleep(10);
}

const make = () => createAlerter({ ntfyUrl: `http://127.0.0.1:${server.port}/topic`, origin: "https://box.ts.net" });

describe("alerts", () => {
  test("settled posts fixed body with Title and Click", async () => {
    make().sessionSettled({ sessionId: "s1", repoName: "burrow", durationMs: 192_000 });
    await waitFor(1);
    expect(hits).toEqual([{ body: "Finished (3m 12s)", title: "burrow", click: "https://box.ts.net/?session=s1" }]);
  });

  test("dialog posts Needs your answer", async () => {
    make().dialogOpened({ sessionId: "s2", repoName: "r", method: "ask" });
    await waitFor(1);
    expect(hits).toEqual([{ body: "Needs your answer", title: "r", click: "https://box.ts.net/?session=s2" }]);
  });

  test("notify, setStatus, setWidget send nothing", async () => {
    const a = make();
    for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url", "bogus"]) {
      a.dialogOpened({ sessionId: "s", repoName: "r", method });
    }
    await Bun.sleep(100);
    expect(hits).toEqual([]);
  });

  test("needsAnswer", () => {
    const a = make();
    for (const m of ["select", "confirm", "input", "editor", "ask"]) expect(a.needsAnswer(m)).toBe(true);
    for (const m of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url", "x", "toString"]) {
      expect(a.needsAnswer(m)).toBe(false);
    }
  });

  test("bodies never contain transcript text", async () => {
    const secret = "SECRET transcript content";
    const a = make();
    a.sessionSettled({ sessionId: "s", repoName: "r", durationMs: 1000 });
    a.dialogOpened({ sessionId: "s", repoName: "r", method: "select" });
    await waitFor(2);
    expect(hits.map((h) => h.body).sort()).toEqual(["Finished (1s)", "Needs your answer"]);
    expect(JSON.stringify(hits)).not.toContain(secret);
  });

  test("500 response does not throw", async () => {
    mode = "500";
    expect(() => make().sessionSettled({ sessionId: "s", repoName: "r", durationMs: 1 })).not.toThrow();
    await waitFor(1);
    await Bun.sleep(50);
    expect(hits.length).toBe(1);
  });

  test("closed connection does not reject", async () => {
    const unhandled: unknown[] = [];
    const h = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", h);
    server.stop(true);
    expect(() => make().dialogOpened({ sessionId: "s", repoName: "r", method: "confirm" })).not.toThrow();
    await Bun.sleep(200);
    process.off("unhandledRejection", h);
    expect(unhandled).toEqual([]);
  });

  test("throwing and rejecting fetchImpl are swallowed", async () => {
    const throwing = createAlerter({ ntfyUrl: "http://x", origin: "o", fetchImpl: (() => { throw new Error("boom"); }) as unknown as typeof fetch });
    const rejecting = createAlerter({ ntfyUrl: "http://x", origin: "o", fetchImpl: (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch });
    expect(() => throwing.sessionSettled({ sessionId: "s", repoName: "r", durationMs: 1 })).not.toThrow();
    expect(() => rejecting.sessionSettled({ sessionId: "s", repoName: "r", durationMs: 1 })).not.toThrow();
    await Bun.sleep(20);
  });

  test("null ntfyUrl does nothing", async () => {
    let called = false;
    const a = createAlerter({ ntfyUrl: null, origin: "o", fetchImpl: (() => { called = true; return Promise.resolve(new Response()); }) as unknown as typeof fetch });
    a.sessionSettled({ sessionId: "s", repoName: "r", durationMs: 1 });
    a.dialogOpened({ sessionId: "s", repoName: "r", method: "ask" });
    expect(called).toBe(false);
  });

  test("formatDuration", () => {
    expect(formatDuration(9_000)).toBe("9s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(192_000)).toBe("3m 12s");
  });
});
