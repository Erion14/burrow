#!/usr/bin/env bash
#
# Install the Burrow host parts for this laptop. Idempotent.
#   install.sh              install user parts, set tailscale serve, print sudo steps
#   install.sh --print-only only print what would run
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PRINT=0
case ${1:-} in
    --print-only) PRINT=1 ;;
    "") ;;
    *) echo "usage: install.sh [--print-only]" >&2; exit 2 ;;
esac

run() { printf '+ %s\n' "$*"; (( PRINT )) || "$@"; }

SCRIPTS=$HOME/.config/hypr/scripts
UNITS=$HOME/.config/systemd/user

run mkdir -p "$SCRIPTS" "$UNITS"
for f in remote.sh lid.sh sleep-guard.sh; do
    run install -m 0755 "$HERE/$f" "$SCRIPTS/$f"
done
# hypridle.conf keeps $HOME as a placeholder, since the repo must not carry a
# path from one machine; the installed copy gets the real home directory.
printf '+ expand $HOME in hypridle.conf -> %s\n' "$HOME/.config/hypr/hypridle.conf"
(( PRINT )) || sed "s|\$HOME|$HOME|g" "$HERE/hypridle.conf" > "$HOME/.config/hypr/hypridle.conf"
(( PRINT )) || chmod 0644 "$HOME/.config/hypr/hypridle.conf"
for u in burrow.service burrow-wake.service; do
    run install -m 0644 "$HERE/systemd/$u" "$UNITS/$u"
done
run systemctl --user daemon-reload
run systemctl --user enable --now burrow-wake.service

run tailscale serve --bg --https=443 --set-path /wake http://127.0.0.1:7471
run tailscale serve --bg --https=443 http://127.0.0.1:7470

cat <<EOF

Not run (needs sudo). Run these yourself:
  sudo install -D -m 0644 $HERE/logind/60-burrow-lid.conf /etc/systemd/logind.conf.d/60-burrow-lid.conf
  sudo install -D -m 0644 $HERE/gdm/90-burrow-idle /etc/dconf/db/gdm.d/90-burrow-idle && sudo dconf update

hypridle reads its config at start: restart it (or log out and in) to pick up the change.
EOF
