# Contributing

Thanks for looking. Burrow is a small project and the bar is simple: the tests
are the specification, and the behavior in `PLAN.md` is the intent.

## Setup

```bash
bun install
bun test          # no model calls, no network, no omp needed
bun run build     # bundles the PWA into dist/web
bun run typecheck
```

`bun run start` runs the server. It needs a Tailscale identity, so day to day
development happens through the test suite rather than a live server.

## How to change things

- **Test first.** Write the failing test, watch it fail for the right reason,
  then implement. Tests live beside the code as `*.test.ts`.
- **omp is the only faked port.** `test/fake-omp.ts` speaks the real RPC
  protocol over stdio. Everything else is real: `Bun.serve` on port 0, git in
  temporary repos, session files in a temporary directory, a local HTTP server
  standing in for ntfy.
- **Expected failures are values.** Return results (`Result<T>`, `status:
  "error"`) across module boundaries instead of throwing.
- **No new dependencies** without a reason that survives review. Bun and the
  standard library cover this project.
- **Never leave a process behind** in a test, even when it fails.
- Comments explain why (a protocol quirk, an invariant, a failure mode), never
  what the next line does.

Style: tabs, double quotes, semicolons, `import type` for type-only imports.
`bun run typecheck` and `bun test` must pass before a pull request.

## Pull requests

- One topic per pull request, with the test that proves it.
- Say what you verified and how, including anything you could not verify.
- `PLAN.md` is the design; if a change alters behavior described there, update
  it in the same pull request.

## Reporting

Bugs and ideas go to the issue tracker. Security reports go through
[SECURITY.md](SECURITY.md) instead.
