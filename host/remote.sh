#!/usr/bin/env bash
#
# Remote mode: keep the host awake so it can be driven from the phone
# (Tailscale + SSH/mosh -> `herdr`).
#
#   remote.sh [toggle] [source]   toggle; source (keybind/waybar) is logged
#   remote.sh on|off [source]     force a state
#   remote.sh status    JSON for the waybar custom/remote module
#   remote.sh active    exit 0 when remote mode is on (used by lid.sh)
#
# While on, a block inhibitor on sleep stops every suspend path: hypridle's
# 15-minute suspend and lid.sh's lid-close suspend. The screen still locks and
# blanks as usual, so closing the lid is safe. Leave it on the charger.

set -uo pipefail

WHO=remote-mode

# Anchored: an unanchored -f pattern also matches any concurrent `pgrep` run by
# another remote.sh instance (waybar polls it per bar), which flickered the icon.
pid() { pgrep -f "^systemd-inhibit --what=sleep --who=$WHO( |$)" | head -1; }
active() { [[ -n $(pid) ]]; }

notify() { command -v notify-send >/dev/null && notify-send -a remote "$@"; return 0; }

on() {
    # First, so a "turn on" from the phone recovers a stopped service even when
    # the inhibitor from an earlier `on` is still held.
    systemctl --user start burrow.service \
        || logger -t "$WHO" "could not start burrow.service"
    active && return 0
    setsid -f systemd-inhibit --what=sleep --who="$WHO" \
        --why="Remote mode: reachable over Tailscale" --mode=block \
        sleep infinity >/dev/null 2>&1
    notify "Remote mode ON" "The machine will not suspend. $(ip4)"
}

off() {
    local p; p=$(pid)
    [[ -n $p ]] && kill "$p"
    systemctl --user stop burrow.service \
        || logger -t "$WHO" "could not stop burrow.service"
    notify "Remote mode OFF" "Normal suspend restored."
}

ip4() { command -v tailscale >/dev/null && tailscale ip -4 2>/dev/null | head -1; }

status() {
    if active; then
        printf '{"text":"\xf3\xb0\xa2\xb9 on","class":"on","tooltip":"Remote mode ON: no suspend\\nTailscale %s\\nClick to turn off"}\n' "$(ip4)"
    else
        printf '{"text":"\xf3\xb0\xa2\xb9","class":"off","tooltip":"Remote mode off\\nClick to keep the host awake"}\n'
    fi
}

# Record who flipped it, so an unexpected "ON" can be traced: journalctl -t remote-mode
case ${1:-toggle} in toggle|on|off) logger -t "$WHO" "${1:-toggle} from ${2:-cli}" ;; esac

case ${1:-toggle} in
    toggle) if active; then off; else on; fi ;;
    on)     on ;;
    off)    off ;;
    status) status ;;
    active) active ;;
    *) sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
