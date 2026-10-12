# Burrow

[![ci](https://github.com/Erion14/burrow/actions/workflows/ci.yml/badge.svg)](https://github.com/Erion14/burrow/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![runtime: bun](https://img.shields.io/badge/runtime-bun-14151a.svg)](https://bun.sh)

Burrow is a phone remote for [omp](https://github.com/can1357/oh-my-pi) coding
agents. From the S25 it lets you prompt an agent that runs on the laptop, answer
its questions, watch the transcript and review the diff, while the laptop stays
home on the charger. It is not a terminal: Termux, mosh and herdr remain the
answer for real terminal work.

Reachable only over Tailscale, and only while Remote mode is on.

```
S25 (PWA) --HTTPS/WSS over tailnet--> tailscale serve
                                        |-- /     -> burrow     127.0.0.1:7470  (Remote ON)
                                        '-- /wake -> burrow-wake 127.0.0.1:7471  (always on)
```

## What it does

- **Sessions.** One `omp --mode rpc-ui` process per session, started in an
  allowlisted repo. Running sessions and recent session files, grouped by
  workspace, with a status dot: working, needs your answer, idle, stopped.
- **Chat.** Streaming text, thinking, collapsed tool cards, subagent progress,
  queued messages, and dialogs rendered for every kind omp asks: `select`,
  `confirm`, `input`, `editor` and `ask` (buttons, plus free text where omp
  allows it).
- **Diff.** Read only `git diff HEAD` plus untracked files per repo. A directory
  holding several git repos diffs each one below it, so a workspace like `~/code`
  works. Bounded so a large untracked tree cannot stall it.
- **Handoff.** "Hand off to laptop" stops Burrow's process, then `omp -r <id>`
  continues the same conversation. A session open at the laptop cannot be
  resumed from the phone: one writer per session file, checked through `/proc`.
- **Alerts.** Two pushes only, "finished" and "needs your answer", through ntfy,
  with a tap that opens that session. Bodies never contain transcript text.
- **Remote mode.** `remote.sh on` takes a sleep inhibitor and starts the server;
  off stops both. `burrow-wake` and the `tailscale serve` config stay up, so the
  phone can always turn Remote back on. On the charger the laptop stays awake
  with the lid closed, and the GDM login screen no longer suspends on AC.

## Requirements

- [Bun](https://bun.sh) 1.4 or newer, on the laptop.
- [omp](https://github.com/can1357/oh-my-pi) on `PATH`, with its config in place.
- [Tailscale](https://tailscale.com) on both devices, same tailnet, with the
  laptop's tailscale operator set to your own user (so `tailscale serve` needs
  no sudo).
- Chrome on the phone, for "Install app".

## Install

```bash
git clone https://github.com/Erion14/burrow && cd burrow
bun install
bun run build
host/install.sh            # units, scripts, tailscale serve config; prints the sudo lines
```

Then, on the phone:

1. Open `https://<laptop>.<tailnet>.ts.net/` in Chrome and use **Install app**.
   Burrow has to be running for that first load; after it, the shell is cached
   and Turn ON works while Remote is off.
2. Turn Remote on, start an agent in one of your repos, and send it a prompt.

`host/` is written for a Fedora laptop running Hyprland with systemd user
services and linger enabled. On another setup, read `host/README.md` and take
the parts that apply.

## Configuration

| File | Purpose |
| --- | --- |
| `~/.config/burrow/repos` | Allowlist, one absolute path per line. Agents only start in these. |
| `~/.config/burrow/ntfy` | One line: the ntfy topic URL for alerts. Missing means no alerts. |

Environment overrides: `BURROW_PORT`, `BURROW_WAKE_PORT`, `BURROW_OWNER_LOGIN`,
`BURROW_ORIGIN`, `BURROW_CONFIG_DIR`, `BURROW_REPOS_FILE`, `BURROW_NTFY_FILE`,
`BURROW_OMP_COMMAND`, `BURROW_SESSIONS_DIR`, `BURROW_IDLE_TIMEOUT_MS`,
`BURROW_WEB_ROOT`, `BURROW_REMOTE_SH`.

## Access rules

Every request must carry a `Tailscale-User-Login` header equal to the laptop's
own tailnet login, and every state-changing request and WebSocket upgrade must
also carry the Burrow `Origin`. A page in the laptop's browser can reach loopback
directly, which is why the origin check is there, and why a foreign header never
reaches omp.

## Development

```bash
bun test        # fake omp over stdio, real HTTP, WebSocket, git and session files
bun run build   # bundles the PWA into dist/web
bun run start   # the server on 127.0.0.1:7470
```

No test calls a model. `test/fake-omp.ts` speaks omp's RPC protocol over stdio
and is the only faked port; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md). Short version: loopback only, tailnet identity,
origin checks, allowlist, one writer per session file.

## License

MIT. See [LICENSE](LICENSE).
