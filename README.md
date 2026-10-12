# Burrow

Work with omp agents on this laptop from the phone: prompt them, answer their
questions, watch what they do, and review the diff, from the Samsung S25.

Burrow is reachable only over Tailscale, and runs only while Remote mode is on.
`PLAN.md` is the design and the source of truth for behavior.

```
S25 (PWA) --HTTPS/WSS over tailnet--> tailscale serve (permanent config)
                                       |-- /     --> burrow (Bun, 127.0.0.1:7470)   [Remote ON only]
                                       |              |-- omp --mode rpc-ui  (one process per session)
                                       |              |-- git diff
                                       |              '-- ntfy alerts
                                       '-- /wake  --> burrow-wake (127.0.0.1:7471, always on) --> remote.sh on
```

## Layout

| Path | What it is |
| --- | --- |
| `src/shared/` | Types and the wire protocol shared by the server and the phone app. |
| `src/server/omp/` | The omp RPC transport: framing, protocol v2 reassembly, one process per session. |
| `src/server/sessions/` | Session manager, transcript, dialog and status tracking. |
| `src/server/repos/` | Repo allowlist, omp session file scan, open session detection, git diff. |
| `src/server/http.ts`, `ws.ts` | The HTTP API and the WebSocket hub (auth, client ids, batching). |
| `src/server/alerts.ts` | The two ntfy pushes: finished, and needs your answer. |
| `src/web/` | The PWA: Preact screens, app state, reconnecting client, service worker. |
| `src/wake/` | `burrow-wake`, the tiny always on server behind `/wake`. |
| `host/` | Laptop files: systemd units, `remote.sh`, `sleep-guard.sh`, logind and GDM settings. See `host/README.md`. |
| `test/fake-omp.ts` | The only faked port: a scriptable omp that speaks the RPC protocol over stdio. |

## Develop

```bash
bun install
bun test                 # unit and integration tests (no model calls)
bun run typecheck
bun run build            # bundles the PWA into dist/web
bun run start            # runs the server on 127.0.0.1:7470
bun run wake             # runs the wake server on 127.0.0.1:7471
```

Tests never call a model: they drive `test/fake-omp.ts` through the same spawn
path as omp, with real HTTP, WebSocket, git repos and session files.

## Configuration

| File | Purpose |
| --- | --- |
| `~/.config/burrow/repos` | Allowlist, one absolute repo path per line. Agents only ever start in these. |
| `~/.config/burrow/ntfy` | One line: the ntfy topic URL for alerts. Empty or missing means no alerts. |

Environment overrides, all optional: `BURROW_PORT`, `BURROW_WAKE_PORT`,
`BURROW_OWNER_LOGIN`, `BURROW_ORIGIN`, `BURROW_CONFIG_DIR`, `BURROW_REPOS_FILE`,
`BURROW_NTFY_FILE`, `BURROW_OMP_COMMAND`, `BURROW_SESSIONS_DIR`,
`BURROW_IDLE_TIMEOUT_MS`, `BURROW_WEB_ROOT`, `BURROW_REMOTE_SH` (wake server).

## Access rules

`tailscale serve` is the only entry point. Every request must carry a
`Tailscale-User-Login` header equal to this laptop's own login (read from
`tailscale status --json` at startup), and every WebSocket upgrade must also
carry the Burrow `Origin`. A page in the laptop's browser can reach
`127.0.0.1:7470` directly, which is why the origin check exists, and why a
foreign header can never reach omp.

## Phone

Open `https://<laptop>.<tailnet>.ts.net/` in Chrome and use "Install app". The
service worker caches the shell, so the app opens even while Burrow is off and
offers to turn Remote ON through `/wake`.

## Host

`host/install.sh` installs the user parts (scripts, systemd user units, the
permanent `tailscale serve` config) and prints the two sudo commands that keep
the laptop awake on the charger with the lid closed. Details in
`host/README.md`.
