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
  "open at laptop" marker from a `/proc` scan.
- ntfy alerts for "finished" and "needs your answer".
- Host parts: `burrow-wake`, `remote.sh` integration, sleep guard, logind and
  GDM settings that keep the laptop awake on the charger with the lid closed.
