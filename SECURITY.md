# Security

## Reporting a vulnerability

Use GitHub's private reporting (Security, then "Report a vulnerability") so the
report stays out of the issue tracker until there is a fix. Please include what
you did, what you saw, and the smallest setup that shows it. Expect an answer
within a week.

## How Burrow is protected

- Both servers bind loopback only. `tailscale serve` is the single entry point,
  and it is never exposed with `tailscale funnel`.
- Every request must carry a `Tailscale-User-Login` header equal to the
  host's own tailnet login. A request that arrives straight at `127.0.0.1`
  has no such header and is refused.
- Every state-changing request (POST, PUT, PATCH, DELETE) must also carry the
  Burrow `Origin`, and every WebSocket upgrade must carry it too. Without that
  check, a page open in the owner's browser could post to loopback with the
  injected identity header.
- Repos are an allowlist, resolved through symlinks, and an agent can only be
  started in one of them. This scopes where agents start; it is not a sandbox.
- A session file is never opened by two processes. Burrow scans `/proc/*/fd`
  and refuses to resume a session another process holds.
- Alerts never contain transcript text: the topic is a public ntfy topic, so
  the body carries counts and durations only.

## Known limits, by design

- Anything listening on all interfaces on the tailnet is reachable from the
  tailnet, whether or not Burrow runs. Burrow does not change the firewall.
- The phone is trusted by tailnet identity alone. A passkey prompt on app open
  is a possible second factor and is not implemented yet.
- `tools.approvalMode` comes from the host's omp config, so an agent started
  from the phone runs commands with whatever approval setting the host uses.
