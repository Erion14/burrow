# Burrow

Work with omp agents on the laptop from the phone: prompt them, answer their
questions, watch the transcript and review the diff. Reachable only over
Tailscale, and only while Remote mode is on.

```
S25 --HTTPS/WSS over tailnet--> tailscale serve
                                  |-- /     -> burrow     127.0.0.1:7470  (Remote ON)
                                  '-- /wake -> burrow-wake 127.0.0.1:7471  (always on)
```

Burrow keeps one `omp --mode rpc-ui` process per session, holds each session's
transcript, dialogs and status in memory, and streams it to the phone over a
WebSocket. The session list is grouped by workspace, and a selector narrows it
to one workspace at a time. The phone is a Preact PWA whose shell is cached by a
service worker, so it opens even while Burrow is off and offers to turn Remote
on.

## Setup

```bash
bun install
host/install.sh          # user units, tailscale serve config, prints the sudo lines
```

- `~/.config/burrow/repos` is the allowlist, one absolute path per line (a
  directory holding several git repos works: its diffs are shown per repo).
- `~/.config/burrow/ntfy` is the ntfy topic for "finished" and "needs your
  answer" alerts; leave it out for no alerts.

## Develop

```bash
bun test         # fake omp over stdio, real HTTP, WebSocket, git and session files
bun run build    # bundles the PWA into dist/web
bun run start    # the server on 127.0.0.1:7470
```

## Access

Every request needs a `Tailscale-User-Login` header matching the laptop owner,
and state-changing requests also need the Burrow `Origin`. `tailscale serve` is
the only entry point; both servers bind loopback.

`PLAN.md` holds the design and the phase list.
