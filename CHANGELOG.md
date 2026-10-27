# Changelog

## Unreleased

- The phone app is restyled on omp's own `dark-rainforest` theme.
- Sessions are grouped by workspace, with a selector to narrow the list to one.
- Workspace diffs: a directory holding several git repos diffs each one level
  down and prefixes the paths.
- Session list scan is bounded and cached (1504 session files: 1.2 s to 40 ms).
- Stop sends `abort_and_restore_queue`, so queued follow-ups no longer keep the
  agent running.
- One writer per session file under concurrent resumes, a deadline on session
  setup, and shutdown that reaches in-flight starts.
- POSTs require the Burrow `Origin`; neither server has an idle timeout; alert
  titles are ASCII safe; diffs are bounded in time and output.
- The phone drops pending messages on any ack, reconnects after a resume, reads
  a session the server is not running as stopped, and clears Remote OFF when the
  socket opens.
- `get_state` is read after setup, on settle and on `refresh_state`, and feeds
  the status line: model, thinking level, context usage, todos and goal.
- The phone gets omp's slash commands (`available_commands_update`, with a
  `get_available_commands` fallback) and, on `list_models`, the picker list with
  thinking levels; the model list is cached for five minutes.
- The phone drives the session: model and thinking pickers, `compact`, queued
  message remove, promote and restore, subagent cancel and steer, session rename,
  and goal pause, resume and drop. A mutation that changes state re-reads
  `get_state`, so the status line follows.
- Bash mode: a `!command` runs through omp's `bash` RPC and lands in the
  transcript as a terminal card that starts as running and ends with the exit
  code and the output tail, cut and labelled when the output is long.
- The phone's chat composer adds omp's key bar and chords, `@` file and `/`
  command completion, a `!` shell mode and a per session draft in
  `localStorage`; queued chips remove on a tap and promote on a long press, the
  agents list cancels and steers a subagent, and the header renames the session.
- The chat screen buzzes where a phone expects it (a key bar press, a chord, an
  answered question, a sent message) and a long press on a user or assistant
  bubble copies it: the item's text, an assistant turn with its thinking, a tool
  card's call and output, marked by a `copied` chip for a second.
- The phone ships its own font: a JetBrains Mono Nerd Font Mono subset (OFL,
  `src/web/fonts`) plus one symbol table in omp's `nerd` preset, so state marks,
  tool cards and chrome render the same on the phone as on the laptop.
- `@` file completion is served by `GET /api/files`: a per repo index (a git
  checkout, else its child checkouts, else a bounded walk), ranked and cached
  for sixty seconds.
- The sessions screen gained a search box and an attention sort: needs answer,
  then working, idle and stopped, newest first inside each group.
- The diff screen is a review surface: one fold per file with expand and collapse
  all, a copy path button that reports a refusal quietly, and a jump list past
  eight files. Folding never hides the notice or the truncation banner.
- A session held open by an omp at the host can be taken over from the phone:
  the row opens the session read only, the view says what it is, and taking it
  over stops that omp, waits for the session file, then resumes the session here.
  A holder that is not an omp is never signalled, and a holder that ignores the
  signal leaves the session untouched.
- A session another omp at the host holds can be read without touching it: the
  row opens a read only view, Burrow follows the session file as the host writes
  (new messages and completed tool calls appear on their own, a rewritten file
  replaces the view), and the composer is absent because nothing typed there
  could reach it. A holder appearing or quitting is reported on the row, so Take
  over is offered exactly when there is an omp to stop.

## 0.1.0

First usable version: sessions, chat, dialogs and diff from the phone.

- Bun server that spawns one `omp --mode rpc-ui` per session, with protocol v2
  framing and chunk reassembly.
- Per session state in memory (transcript from deltas, dialogs, status,
  subagent progress) and a snapshot on connect, then live events.
- Preact PWA with a cached shell, so it opens while Burrow is off and can turn
  Remote mode on through `/wake`.
- Tailscale identity and Origin checks on every request and upgrade.
- Repo allowlist, recent session files filtered by the header `cwd`, and an
  "in use elsewhere" marker from a `/proc` scan.
- ntfy alerts for "finished" and "needs your answer".
- Host parts: `burrow-wake`, `remote.sh` integration, sleep guard, logind and
  GDM settings that keep the host awake on the charger with the lid closed.
