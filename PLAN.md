# Burrow — phone interface for omp (and later Tern)

A phone web app (PWA) for steering omp agents running on this laptop from the
Samsung S25. It is reachable only over Tailscale and runs while Remote mode is on.

## Decisions (from the 2026-10-12 grilling)

| Area | Decision |
|---|---|
| Form | PWA installed from Chrome ("Install app"). No APK. |
| Stack | Bun + TypeScript backend, Preact frontend, Catppuccin Mocha palette (same as Waybar). |
| Network | Tailscale only, via `tailscale serve` (HTTPS on the tailnet, never `funnel`). Tailscale identity is the only auth. |
| Lifecycle | Remote ON starts Burrow. Remote OFF stops it. A tiny always-on endpoint lets the phone turn Remote ON. |
| Lid | On the charger, lid close locks the screen and does not suspend, so the always-on endpoint stays reachable. On battery it suspends as before. |
| Agents | Burrow spawns omp itself (`omp --mode rpc-ui`) with the laptop's normal config and approval settings. Sessions are ordinary omp session files, so you can continue at the laptop with `omp -r <id>`. |
| Repos | Allowlist only, in `~/.config/burrow/repos` (one absolute path per line). New agents can start only in these. |
| Alerts | Only "agent finished" and "agent needs your answer". |
| Laptop sessions | omp started in a Tern tab: chat view if `/collab` is on, else Tern terminal view (phase 3). |
| Tern | Later (phase 3): snapshot view + command box + key bar (Esc, Tab, ^C, arrows). |
| Desktop | wayvnc on a headless virtual output, started on demand, opened with AVNC (phase 4). |
| Fallback | Termux + mosh + herdr stays as it is. |

## Architecture

```
S25 (PWA) --HTTPS/WSS over tailnet--> tailscale serve --> burrow (Bun, 127.0.0.1)
                                                            |-- omp --mode rpc-ui  (one process per agent session)
                                                            |-- git (status, diff, commit, push) [phase 2]
                                                            |-- tern CLI (ls/capture/send/events) [phase 3]
                                                            '-- wayvnc (on demand) [phase 4]
burrow-wake (always on, tiny) --> remote.sh on|off
```

- `burrow` binds 127.0.0.1 only; `tailscale serve` is the single entry point.
- One WebSocket per open phone screen. The server fans out omp RPC frames for that session.
- The server owns the omp processes. The phone can disconnect and reconnect at any time and replays the session with `get_messages`.
- Sessions with no turn running and no phone attached are stopped after an idle timeout. They stay resumable from the session file.

### omp RPC mapping (see `omp://rpc.md`)

| Phone action | RPC |
|---|---|
| Send message | `prompt` (idle), `steer` / follow-up (while busy) |
| Interrupt | `abort` (or `abort_and_restore_queue` to get queued text back) |
| Resume old session | `open_session` |
| Show transcript | `get_messages` / `get_messages_page` |
| Ask-tool buttons | `set_ask_dialog` on, answer `extension_ui_request` with `extension_ui_response` |
| Busy/idle/needs input | `get_state` + event stream (`agent_end`, `extension_ui_request`) |
| Model picker [P2] | `set_model`, `cycle_model` |
| Subagent panel [P2] | `get_subagents`, subagent subscriptions, `cancel_subagent` |

## Phases

### Phase 1 — agents core (first usable version)
1. `burrow` server: spawn and supervise `omp --mode rpc-ui` per session, JSONL framing, WebSocket bridge, session list (running + recent from omp's session dir, filtered to allowlisted repos).
2. PWA: Sessions screen (status dot: working / needs answer / idle, "+ New agent" with repo picker, resume), Chat screen (streaming text, collapsed tool cards, ask buttons, message box, stop button).
3. Remote integration: `remote.sh on` starts `burrow.service` and `tailscale serve`, and `off` stops both. Add a Remote OFF button in the app.
4. `burrow-wake`: always-on user service, tailnet-only, with one action (turn Remote ON). The lid on charger locks instead of suspending (`lid.sh`).
5. Alerts: Web Push (VAPID) on `agent_end` and on `extension_ui_request`.

Acceptance:
- From the S25 on mobile data: open the app, start an agent in an allowlisted repo, answer an `ask` with a button, interrupt a turn, close the app, reopen it, and the transcript is intact.
- A push alert arrives when an agent finishes and when it asks a question, with the app closed.
- At the laptop, `omp -r <id>` continues the phone-started session.
- Remote OFF from the phone: nothing listens on the tailnet except `burrow-wake`. Turning Remote ON from the phone works with the lid closed on the charger.
- A repo outside the allowlist cannot be chosen or passed to the server.

### Phase 2 — review and ship
Model picker, subagent panel, diff viewer (per-file, unified, mobile-wrapped), git commit/push for allowlisted repos, home card with laptop status (reuse `~/.config/hypr/scripts/temps.sh` + battery) and git status of allowlisted repos.

### Phase 3 — Tern
Terminals section using `tern ls --json`, `tern capture --html`, `tern send`/`tern run`, `tern events`. Laptop-started omp sessions: chat view through collab when enabled, else the Tern view.

### Phase 4 — desktop on demand
"Desktop" button: create a Hyprland headless output, start wayvnc on it (tailnet-only), open AVNC by deep link. Stop both when leaving. The laptop's own screen stays locked.

## Risks to verify early
- `rpc-ui` frame volume over mobile data: the server should coalesce streaming deltas before sending.
- Web Push on an installed PWA under a `*.ts.net` origin on Samsung/Chrome: verify on the S25 in phase 1, before building on it.
- Lid-closed + charger heat with the laptop in a bag.
- Hyprland headless output + wayvnc + hyprlock interaction (phase 4).
