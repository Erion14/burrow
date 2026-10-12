# Burrow: phone remote work for omp (and later Tern)

A phone web app (PWA) for working with omp agents on this laptop while away from
home: prompt them, answer their questions and approvals, and review what they
changed, from the Samsung S25. The laptop stays at home on the charger for long
periods. Burrow is reachable only over Tailscale and runs while Remote mode is on.

## Decisions (2026-10-12 grilling, revised after review)

| Area | Decision |
|---|---|
| Purpose | Remote work from the phone: prompt agents, answer them, review their changes. Not a terminal replacement. |
| Form | PWA installed from Chrome ("Install app"). No APK. A service worker caches the app shell, so the app opens even while Burrow is off. |
| Stack | Bun + TypeScript backend (`Bun.serve` for HTTP and WebSocket, no framework), Preact frontend bundled with `bun build` (no Vite), `bun test` for tests, omp's own `dark-rainforest` theme (the palette bundled with omp, same one the TUI uses) so the phone reads like omp and Tern. |
| Network | Tailscale only, through one permanent `tailscale serve` config: `/` to `burrow` on 127.0.0.1:7470, `/wake` (`--set-path /wake`) to `burrow-wake` on 127.0.0.1:7471. Never `funnel`. |
| Auth | Tailscale identity, checked by Burrow. Binding to 127.0.0.1 is not auth on its own: every request needs a `Tailscale-User-Login` equal to the laptop's own Tailscale login (read from `tailscale status --json` at startup), and every WebSocket upgrade needs the Burrow `Origin`. |
| Host | The laptop stays home on the charger for long periods. On the charger it never suspends, lid open or closed, Remote on or off. On battery it behaves as before. |
| Lifecycle | Remote ON starts `burrow.service` and takes the existing sleep inhibitor (which covers battery). Remote OFF stops both. `burrow-wake` and the serve config stay up, so the phone can always turn Remote ON. |
| Agents | Burrow spawns omp itself (`omp --mode rpc-ui`), one process per session, with the laptop's config and approval settings. Today that is `tools.approvalMode = yolo`, so a phone started agent runs commands without asking, exactly as at the laptop; approval dialogs appear only for tools that force one. Sessions are ordinary omp session files. RPC mode pins neutral defaults for task isolation, memory, advisor, and bash/eval auto background unless the config sets them explicitly; set them in config wherever the phone must behave like the laptop. |
| Handoff | Laptop to phone: quit omp at the laptop, then resume the session from the phone. Phone to laptop: "Hand off to laptop" stops Burrow's process, then `omp -r <id>`. A session file is never written by two processes: omp keeps its session file open, so Burrow scans `/proc/*/fd` and refuses to resume a session that another process has open. |
| Repos | Allowlist only, in `~/.config/burrow/repos` (one absolute path per line). New agents start only in these. Paths are compared after resolving symlinks. Recent sessions are filtered by the `cwd` in the session header, never by the session folder name, which is ambiguous (`-code-logistics-backend`). The allowlist scopes where agents start; it is not a sandbox. |
| Review | Phase 1: transcript with tool cards, subagent progress, and a read only diff of the session's repo. A workspace directory that holds several git repos (for example `~/code`) diffs each repo found one level down and prefixes the paths. Phase 2: commit and push. |
| Alerts | Only "agent finished" and "agent needs your answer", sent through ntfy to the topic in `~/.config/burrow/ntfy` (the same topic as `~/.omp/agent/extensions/ntfy-notify.ts`). |
| Lost phone | Kill switch: remove the S25 from the tailnet in the Tailscale admin console. A passkey prompt when the app opens is the cheapest second factor, if one is wanted later. |
| Laptop sessions | omp started in a Tern tab: chat view if `/collab` is on, else Tern terminal view (phase 3). |
| Tern | Later (phase 3): snapshot view + command box + key bar (Esc, Tab, ^C, arrows). |
| Desktop | wayvnc on a headless virtual output, started on demand, opened with AVNC (phase 4). |
| Fallback | Termux + mosh + herdr stays as it is. |

## Architecture

```
S25 (PWA) --HTTPS/WSS over tailnet--> tailscale serve (permanent config)
                                        |-- /      --> burrow (Bun, 127.0.0.1:7470)   [Remote ON only]
                                        |               |-- omp --mode rpc-ui  (one process per agent session)
                                        |               |-- git (diff [phase 1], status, commit, push [phase 2])
                                        |               |-- tern CLI (ls/capture/send/events) [phase 3]
                                        |               '-- wayvnc (on demand) [phase 4]
                                        '-- /wake  --> burrow-wake (127.0.0.1:7471, always on, tiny) --> remote.sh on
```

- `burrow` and `burrow-wake` bind 127.0.0.1 only; `tailscale serve` is the single entry point. Its config is set once and never toggled, so `/wake` answers while Burrow is off. `/` then fails, and the cached app shell shows "Remote is OFF" with a Turn ON button that calls `/wake` (same origin, no CORS).
- Every request needs the owner's `Tailscale-User-Login`, and every WebSocket upgrade also needs the Burrow `Origin`. A page open in the laptop's browser can open a WebSocket to 127.0.0.1, and it must never reach omp.
- Every state-changing request (POST, PUT, PATCH, DELETE) to `burrow` or `burrow-wake` also needs `Origin` equal to the Burrow origin; a missing `Origin` passes only with `Sec-Fetch-Site: same-origin` or `none`. `tailscale serve` adds the owner's login to every request from the phone, so without this any page open in the phone's browser could turn Remote OFF or start an agent with a plain form POST. GET needs no `Origin`.
- Neither server has an idle timeout: a resume or a large diff can take longer than Bun's default 10 s, and a dropped answer would leave the phone guessing while the work goes on.
- The server owns the omp processes and keeps each session's state in memory: the transcript (from `message_end`, plus the message in progress built from deltas), open dialogs, and status. A phone that connects or reconnects gets a snapshot, then live events. Dropped connections are the normal case on mobile data.
- Every message from the phone carries a client id, and the server ignores ids it has already seen, so a message sent during a dropout reaches the agent exactly once. Every message with a client id gets an ack, including one that cannot be applied (malformed, or sent on a socket without a session): that ack has status `error` and the id is not recorded, so the phone stops resending it.
- One WebSocket per open phone screen. Streamed text is batched (about 100 ms) before sending. A list socket gets the session list as soon as it attaches. A socket whose send is dropped or whose outgoing buffer passes 4 MB is closed with code 1013, so a phone that stopped reading reconnects and takes a fresh snapshot instead of a transcript with holes.
- A session is stopped when no phone is attached, `get_state` reports `isSettled` and not `hasPendingAsyncWork`, no dialog is open, and all of that has held for the idle timeout. It stays resumable from the session file.

### omp RPC mapping (see `omp://rpc.md`)

| Phone action | RPC |
|---|---|
| Start a session | Spawn `omp --mode rpc-ui` in the repo, then `negotiate_protocol` (v2), `set_event_filter` with `messageUpdates: "delta"`, `set_ask_dialog` on, `set_subagent_subscription` at `progress` |
| Resume old session | Spawn with `--resume <session file>`. (`open_session` takes a folder and continues its newest session, so it does not fit.) |
| Send message | `prompt` with `streamingBehavior: "followUp"` always set, so the same call works idle or busy |
| Interrupt | `abort` (or `abort_and_restore_queue` to put queued text back in the message box) |
| Show transcript | Server memory. `get_messages_page` only right after spawning for a resume (it refuses while a turn streams) |
| Dialogs | `extension_ui_request` with `select`, `confirm`, `input`, `editor`, or `ask`; answer with `extension_ui_response`; `cancel` withdraws an open one. Tool approvals arrive as `confirm` or `select`. `notify`, `setStatus`, `setWidget` are display only. |
| Status dot | `get_state` (`isStreaming`, `isSettled`) + event stream. Finished means `session_settled`, not `agent_end`, which fires for every turn |
| Subagent progress | `get_subagents` + `subagent_progress` frames |
| Model picker [P2] | `get_available_models`, `set_model` |
| Cancel subagent [P2] | `cancel_subagent` |

Framing: stdout frames cap at 1 MiB. With protocol v2, larger frames arrive as `rpc_chunk` sequences that the server reassembles. The server keeps reading stdout after closing stdin, or omp cannot exit.

## Testing

Test first, one behavior at a time, with `bun test` and tests beside the code.

- omp is the only faked port. `test/fake-omp.ts` speaks the RPC protocol over stdio (ready frame, responses by id, scripted event sequences, `rpc_chunk` frames), and Burrow starts it through the same spawn path as `omp`, with the command taken from config.
- Everything else is real: `Bun.serve` on port 0 driven by real HTTP and WebSocket clients, git in temporary repos, session files in a temporary session folder, a local HTTP server standing in for ntfy, and a real child process holding a session file open for the "open at laptop" case.
- PWA logic that decides behavior (reconnect, resend with the same client id, building dialog answers) lives in plain modules tested with `bun test`. Screens are checked on the phone.
- Negative cases, each asserting what must not happen:
  - missing or foreign `Tailscale-User-Login`: 403, no omp process started
  - foreign `Origin` on a WebSocket upgrade, or a foreign or missing `Origin` on a POST: refused
  - repo outside the allowlist, reached through a symlink, or containing `..`: refused, no process started
  - resume of a session another process has open: refused, no second writer
  - the same client id sent twice: one `prompt`
  - several `agent_end` before `session_settled`: one "Finished" alert
  - `notify`, `setStatus`, `setWidget`: no alert
  - alert bodies never contain transcript text
  - idle stop never fires with pending async work, an open dialog, or a phone attached
- One manual smoke against the real `omp --mode rpc-ui` in a scratch repo before Phase 1 closes. It costs a model call, so it stays out of the suite.
- Host changes (power settings, serve config, units) are checked by hand against the acceptance list.

## Phases

### Phase 1: agents core and review (first usable version)
1. `burrow` server: spawn and supervise `omp --mode rpc-ui` per session (setup as in the RPC table), v2 framing with chunk reassembly, per session state with a snapshot on connect, client message ids, Tailscale identity and origin checks, and the session list (running sessions + recent session files whose header `cwd` is allowlisted; a session open in another omp process shows "open at laptop" and cannot be resumed).
2. PWA:
   - Sessions screen: status dot (working / needs answer / idle), "+ New agent" with repo picker, resume, "open at laptop" marker.
   - Chat screen: streaming text, collapsed tool cards, subagent progress, dialogs (buttons for `ask` and `select`, yes and no for `confirm`, a text box for `input` and `editor`), message box, stop button, "Hand off to laptop".
   - Diff screen: read only `git diff HEAD` plus untracked files for the session's repo, per file, unified, wrapped for the phone. Bounded so a large untracked tree cannot stall it: the whole diff stops after 20 s, each git call's output is capped, at most 200 untracked files are rendered, and untracked files over 1 MB are skipped. Whatever is left out sets `truncated` and adds a `notice` line.
   - Service worker with the cached shell and the "Remote is OFF, turn ON" screen.
3. Remote integration: the permanent `tailscale serve` config (`/` and `/wake`). `remote.sh on` takes the sleep inhibitor (as today) and starts `burrow.service`; `off` stops both. Remote OFF button in the app.
4. Stay awake on the charger:
   - One "suspend unless on AC" check, used by `lid.sh` `sleep_now` and by the hypridle 900 s listener. Today both suspend whenever Remote is off, so `burrow-wake` would vanish 15 minutes after you leave. Locking and turning the screen off stay as they are.
   - After a reboot nobody is logged in: the GDM login screen runs, `lid.sh` and hypridle do not. Cover that with a logind config file setting `HandleLidSwitchExternalPower=lock` (no lid override exists today, so logind suspends on lid close even on the charger), and turn off GDM's idle suspend on AC (`sleep-inactive-ac-type='nothing'` in `/etc/dconf/db/gdm.d/`, then `dconf update`).
   - `burrow-wake`: always on user service with one action, `remote.sh on`. Linger is already on, so it starts at boot without a login.
5. Alerts: the server POSTs to the ntfy topic for every session Burrow runs (no `[ntfy]` tag needed). "Finished (3m 12s)" is sent on `session_settled`. "Needs your answer" is sent when a dialog opens (`select`, `confirm`, `input`, `editor`, `ask`), never for `notify`, `setStatus`, or `setWidget`. It sets the `Title` header (repo name, reduced to printable ASCII because a header cannot carry a Cyrillic name; omitted when nothing is left) and a `Click` header with the Burrow session URL, so tapping the alert opens the app on that session. A failed push is logged and never disturbs the session. Bodies never include transcript text: anyone who knows a public ntfy.sh topic can read it. The existing `ntfy-notify.ts` extension also loads in omp processes spawned by Burrow, so a phone prompt tagged `[ntfy]` would push twice. Burrow sets `BURROW=1` in the omp environment, and the extension returns early when it is set.

Acceptance:
- From the S25 on mobile data: open the app, start an agent in an allowlisted repo, answer an `ask` with a button and another with free text, interrupt a turn, close the app, reopen it, and the transcript is intact.
- Airplane mode on and off during a streaming turn loses no text, and a message sent during the dropout reaches the agent exactly once.
- The Diff screen shows every change the agent made in the repo, new files included.
- With the app closed, one alert arrives when a session settles (not one per turn) and one when an agent opens a dialog. Status updates send no alert.
- At the laptop, after "Hand off to laptop", `omp -r <id>` continues the session started on the phone. A session quit at the laptop resumes from the phone. A session still open at the laptop cannot be resumed from the phone.
- Remote OFF from the phone: `burrow.service` stops and only `/wake` answers through `tailscale serve`. Turning Remote ON from the phone works after the laptop has sat on the charger with the lid closed for several hours, and after a reboot with nobody logged in.
- A request or WebSocket sent straight to 127.0.0.1 without the owner's Tailscale login, or a WebSocket upgrade from another origin, is refused.
- A repo outside the allowlist cannot be chosen or passed to the server, including through a symlink or `..`.

Build order (each slice test first, each usable on its own):
1. Host: power settings on the charger, the `tailscale serve` config, `burrow-wake`, `remote.sh` starting and stopping `burrow.service`. No Burrow code is needed, and it proves the wake path before anything depends on it. Check: lid closed on the charger for over 15 minutes, then a reboot, and `/wake` still answers.
2. RPC client against the fake omp: spawn, v2 negotiation, chunk reassembly, responses matched by id, stdout drained after stdin closes.
3. Session core: start in an allowlisted repo, `prompt` with `streamingBehavior`, `abort`, transcript state from deltas, snapshot.
4. HTTP and WebSocket server: identity and origin checks, client ids, snapshot then live events, batching.
5. Minimal PWA: one chat screen, installable, service worker with the cached shell and the "Remote is OFF" screen. First real use from the S25 on mobile data.
6. Sessions screen: session list, resume, "open at laptop", "Hand off to laptop".
7. Dialogs, server and screen.
8. Alerts, plus the `BURROW=1` guard in `ntfy-notify.ts`.
9. Diff screen.
10. Idle stop.

### Phase 2: ship and steer
Model picker, cancel subagent, git commit and push for allowlisted repos, home card with laptop status (reuse `~/.config/hypr/scripts/temps.sh` + battery) and git status of allowlisted repos.

### Phase 3: Tern
Terminals section using `tern ls --json`, `tern capture --html`, `tern send`/`tern run`, `tern events`. Laptop started omp sessions: chat view through collab when enabled, else the Tern view. This also lets you leave the desk without quitting omp first.

### Phase 4: desktop on demand
"Desktop" button: create a Hyprland headless output, start wayvnc on it (tailnet only), open AVNC by deep link. Stop both when leaving. The laptop's own screen stays locked.

## Risks to verify early
- ntfy `Click` deep links into the installed PWA on the S25 (opens the app vs a Chrome tab).
- After a reboot (GDM login screen, no Hyprland): the laptop stays awake on the charger with the lid closed, and `burrow-wake` answers.
- Heat with the lid closed on the charger for days: keep it where it can ventilate.
- Hyprland headless output + wayvnc + hyprlock interaction (phase 4).

## Verified on this laptop (2026-10-12)
- Bun 1.4.2 and Tailscale 1.102.4 are installed; `tailscale serve` supports `--set-path`. Ports 7470 and 7471 are free.
- `remote.sh` (on, off, sleep inhibitor) already exists; Burrow extends it.
- omp keeps each session file open (`/proc/<pid>/fd` links to it), which is how Burrow detects a session open at the laptop.
- `ask.timeout = 0`, so an `ask` waits until it is answered. `tools.approvalMode = yolo` with no per tool policies, so agents do not stop for approvals.
- Linger is on, the disk is not encrypted (a reboot needs no passphrase), and the battery stops charging at 80% (`charge_control_end_threshold`).
- No `HandleLidSwitch*` override exists in any logind config, and GDM has no `sleep-inactive` override, which is why step 4 adds both.

## Known, out of scope
- `tailscale0` is in the firewalld `trusted` zone, so every service listening on all interfaces (ports 6379, 1434, 9009, 11470, 12470 as of 2026-10-12) is reachable from the tailnet whether Burrow runs or not. Burrow does not change that.
