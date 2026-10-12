# Burrow: repo guide for agents

Burrow is the phone remote for omp: a Bun + TypeScript server, a Preact PWA,
and a small set of host files (systemd units, `tailscale serve` config, power
settings). `PLAN.md` is the source of truth for behavior; read it before
changing anything.

## Layout

- `src/shared/` types and the wire protocol shared by server and web app.
- `src/server/` the server: config, auth, omp RPC port, session manager,
  HTTP/WebSocket layer, alerts, git diff, idle stop.
- `src/web/` the PWA: Preact screens, app state, connection module, service worker.
- `src/wake/` the always on `burrow-wake` server behind `/wake`.
- `test/` cross-cutting test helpers, including `test/fake-omp.ts`.
- `host/` files installed on the laptop (systemd user units, logind and GDM
  power settings, `remote.sh`, `lid.sh`, install script).
- `tools/` build scripts.

## Rules

- Test first, one behavior at a time, with `bun test`. Tests live beside the
  code as `*.test.ts`. omp is the only faked port; everything else (Bun.serve on
  port 0, git in temporary repos, session files in a temporary directory, ntfy
  as a local HTTP server) runs for real.
- Expected failures are values, not exceptions: return `Result<T>` style
  results across module boundaries.
- No extra dependencies. Bun and the standard library cover this project; do
  not add a framework, a router, or a test helper library.
- Style: tabs, double quotes, semicolons, `import type` for type-only imports.
  No em dashes in comments or docs.
- Comments explain why (a protocol quirk, an invariant, a failure mode), never
  what the line below does.
- Never leave a spawned process or a listening server behind in a test: kill it
  in `afterEach` even when the test fails.
- `bun run typecheck` and `bun test` must pass before work is finished.
