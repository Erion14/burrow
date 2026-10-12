# Setting Burrow up on your laptop

Hand it to your coding agent, or do it by hand.

## Give it to your agent

Paste the prompt below into an agent that has shell access to the laptop (omp,
Claude Code, Codex, whatever you run). It is written to inspect first, to ask
before sudo, and to verify at the end instead of assuming.

```text
Set up Burrow (https://github.com/Erion14/burrow) on this laptop so I can drive
omp agents from my phone over Tailscale, then verify it.

Gather and report these facts before changing anything:
1. `bun --version` (needs 1.4+). If bun is missing, install it the way this
   distro prefers, and tell me the command you used.
2. `omp --version` and the absolute path of the omp binary. Burrow spawns
   `omp --mode rpc-ui`, one process per session.
3. `tailscale status --json`: my laptop's login name (User[Self.UserID] ->
   LoginName) and DNS name (Self.DNSName, without the trailing dot), and whether
   `OperatorUser` is my own user, since `tailscale serve` needs that to run
   without sudo.
4. Where omp keeps session files, normally `~/.omp/agent/sessions`.
5. How this desktop session handles idle and lid events (Hyprland with hypridle,
   GNOME, none), because that decides which parts of `host/` apply here.
6. Which repos I want on the allowlist. Ask me, do not guess.

Then do this:
- Clone the repo somewhere permanent, run `bun install` and `bun run build`.
- Write `~/.config/burrow/repos` with one absolute repo path per line, and, if I
  want alerts, `~/.config/burrow/ntfy` with my ntfy topic URL.
- Run `host/install.sh` and show me the sudo commands it prints before I run
  them. Adapt what does not apply to this machine: `host/` targets Fedora with
  Hyprland, systemd --user with linger, and GDM. Keep two things whatever the
  setup: the `burrow-wake` user service and the permanent `tailscale serve`
  config with `/` on 7470 and `/wake` on 7471. Never use `tailscale funnel`.
- Verify, and show me the output of each check:
  * `bun test` passes.
  * `systemctl --user is-active burrow-wake` says active.
  * `GET https://<laptop>.<tailnet>.ts.net/wake` answers {"ok":true} with my
    tailnet identity.
  * `curl http://127.0.0.1:7470/health` (no Tailscale-User-Login header) is 403.
  * `remote.sh on` starts burrow.service and `remote.sh off` stops it, while
    `/wake` still answers.
  * After a reboot with nobody logged in, `/wake` still answers.
- Finish with: the exact URL to open on the phone, the reminder to use Chrome's
  "Install app", the note that the first load needs Remote mode on (the shell is
  cached after that), and a list of anything you changed outside the repo or
  could not verify.

Do not change my omp config, my shell config, or anything under `~/.omp` other
than reading it.
```

## By hand

1. **Requirements.** Bun 1.4+, `omp` on `PATH`, Tailscale on the laptop and the
   phone with the same tailnet, `OperatorUser` set to your user, and Chrome on
   the phone.
2. **Build.**

   ```bash
   git clone https://github.com/Erion14/burrow
   cd burrow
   bun install
   bun run build
   ```

3. **Configure.** One absolute repo path per line in `~/.config/burrow/repos`.
   Optionally an ntfy topic URL in `~/.config/burrow/ntfy`.
4. **Host parts.** `host/install.sh` installs the user units and scripts, enables
   `burrow-wake`, and sets the permanent `tailscale serve` config. It prints the
   two sudo commands it will not run (a logind drop-in and a GDM dconf key).
   Read `host/README.md` for what each piece does and what to skip on a different
   desktop.
5. **Phone.** Open `https://<laptop>.<tailnet>.ts.net/` in Chrome, install it,
   then turn Remote on. Burrow has to be running for that first load; after it
   the shell is cached and Turn ON works while Remote is off.

## What Burrow assumes about the laptop

- `systemd --user` with linger enabled, so `burrow-wake` starts at boot without a
  login and the phone always has something to wake.
- Tailscale's operator set to your user, and no `tailscale funnel`.
- `omp` on `PATH` for the user the service runs as.
- A way to stay awake on the charger: the lid closed must not suspend, and the
  idle listener must not suspend either. `host/` implements that with a logind
  drop-in, a sleep guard shared by `hypridle` and `lid.sh`, and a GDM dconf key
  that stops the login screen from suspending on AC. Skip any of those only if
  the desktop already behaves that way, and check `/wake` after a reboot either
  way.
- Session files under `~/.omp/agent/sessions` (change `BURROW_SESSIONS_DIR`
  otherwise). Burrow reads their header `cwd` to list recent sessions, and scans
  `/proc/*/fd` to refuse resuming a session another omp process holds open.
