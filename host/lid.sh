#!/usr/bin/env bash
#
# Lid + external display handling for the Hyprland session.
#
#   lid.sh          run the watcher (started by exec-once in hyprland.conf)
#   lid.sh status   print what the watcher currently sees
#
# Replaces logind's lid handling for the session (it holds the handle-lid-switch
# inhibitor, like GNOME does), because logind suspends the moment an external
# display is unplugged while the lid is closed — which locks the screen.
#
#   dock monitor plugged in           internal panel off, ONLY that monitor lit (see
#                                     DOCK_MONITORS below). Fires once when it
#                                     appears, so `display extend` afterwards sticks
#                                     until the next replug. Unplug -> panel back on.
#
#   lid closed + external connected   internal panel off, work on the external
#   lid open, or no external          internal panel on (windows move back to it)
#   external unplugged, lid closed    wait LID_GRACE seconds for the lid to open,
#                                     then suspend (the bag case still sleeps)
#   lid closed, never docked          suspend right away, same as before
#
# Environment
#   LID_GRACE   seconds to wait after an unplug before suspending (default 60)
#   LID_POLL    seconds between checks (default 1)

set -uo pipefail

GRACE=${LID_GRACE:-60}
POLL=${LID_POLL:-1}
PANEL=eDP-1

# Monitors that always mean "external only". Each entry is a substring of the
# monitor's description (`hyprctl monitors all`), so it survives port changes.
DOCK_MONITORS=("PHL346E2LA")   # Philips 34" at the desk
CONF=$HOME/.config/hypr/monitors.conf

lid_closed() { grep -q closed /proc/acpi/button/lid/*/state 2>/dev/null; }

external() {
    local c
    for c in /sys/class/drm/card*-*; do
        [[ ${c##*/} == *-"$PANEL" ]] && continue
        [[ $(cat "$c/status" 2>/dev/null) == connected ]] && return 0
    done
    return 1
}

# The panel's rule from monitors.conf, so `display save` stays the one source.
panel_rule() {
    local rule
    rule=$(sed -n "s/^monitor *= *\($PANEL *,.*\)/\1/p" "$CONF" | grep -v disable | tail -1)
    printf '%s' "${rule:-$PANEL, preferred, 0x0, 1}"
}

# Hyprland refuses overlapping monitors (warns, does not register the change), and the
# panel's rule sits at 0x0 — where `display external` and the dock rule leave an
# external. So before the panel comes back, move every enabled, non-mirrored external
# beside it, keeping its current mode and scale. An external already on the left
# (negative x, i.e. `display extend left`) stays on the left; anything else goes right.
externals_beside_panel() {
    local json w
    json=$(hyprctl -j monitors all 2>/dev/null) || return 0
    w=$(jq -r --arg p "$PANEL" '.[] | select(.name == $p) | (.width / .scale) | floor' <<<"$json")
    [[ -n $w ]] || return 0
    jq -r --arg p "$PANEL" --argjson w "$w" '
        .[] | select(.name != $p and (.disabled | not) and .mirrorOf == "none")
        | (if .x < 0 then -((.width / .scale) | floor) else $w end) as $x
        | "\(.name), \(.width)x\(.height)@\(.refreshRate | floor), \($x)x0, \(.scale)"' <<<"$json" \
        | while IFS= read -r rule; do hyprctl -q keyword monitor "$rule"; done
}

panel() {   # panel on|off — only touches Hyprland on a change
    [[ ${PANEL_STATE:-} == "$1" ]] && return 0
    if [[ $1 == off ]]; then
        hyprctl -q keyword monitor "$PANEL, disable"
    else
        externals_beside_panel
        hyprctl -q keyword monitor "$(panel_rule)"
    fi
    PANEL_STATE=$1
}

# True when Hyprland has no enabled output at all. `panel()` only remembers what it
# last did, so it cannot see the panel being disabled behind its back (`display
# external`, nwg-displays, a manual hyprctl). Unplug the external after that and
# nothing would ever turn the panel back on: black screen, workspaces orphaned.
no_live_output() {
    hyprctl -j monitors all 2>/dev/null \
        | jq -e '[.[] | select((.disabled | not) and (.name | startswith("FALLBACK") | not))] | length == 0' \
        >/dev/null
}

# Connector name (e.g. DP-1) of a plugged-in dock monitor, or nothing.
dock_output() {
    local pat
    for pat in "${DOCK_MONITORS[@]}"; do
        hyprctl -j monitors all 2>/dev/null \
            | jq -er --arg p "$pat" --arg i "$PANEL" \
                '.[] | select(.name != $i and (.description | contains($p))) | .name' \
            | head -1 && return 0
    done
    return 1
}

# External only: dock monitor at the origin, internal panel off (same as `display external`).
dock_only() {
    # Panel off BEFORE the dock monitor takes the origin: both at 0x0 would overlap.
    hyprctl -q keyword monitor "$PANEL, disable"
    hyprctl -q keyword monitor "$1, preferred, 0x0, 1"
    PANEL_STATE=off
}

sleep_now() {
    loginctl lock-session
    # Remote mode (remote.sh) keeps the machine up: lock only, never suspend.
    "$(dirname "$0")/remote.sh" active && return 0
    sleep 1
    # On the charger the host stays up (lid closed, locked); on battery it suspends.
    "$(dirname "$0")/sleep-guard.sh" suspend-if-battery
}

status() {
    lid_closed && echo "lid:      closed" || echo "lid:      open"
    external && echo "external: connected" || echo "external: none"
    echo "panel:    $(panel_rule)"
    if systemd-inhibit --list --no-pager 2>/dev/null | grep "lid.sh" >/dev/null; then
        echo "watcher:  running"
    else
        echo "watcher:  not running"
    fi
}

watch() {
    local docked=0 was_closed=0 unplugged_at=0 dock dock_prev=
    lid_closed && was_closed=1
    external && docked=1
    while :; do
        # Safety net: nothing is lit, so the panel is the only way back regardless
        # of lid state or what the cache thinks. Forget the cache and force it on.
        if no_live_output; then PANEL_STATE=; panel on; fi
        # Dock monitor just appeared (or we just started with it attached): go external-only.
        dock=$(dock_output) || dock=
        if [[ -n $dock && -z $dock_prev ]]; then dock_only "$dock"; fi
        dock_prev=$dock
        if lid_closed; then
            if external; then
                docked=1; unplugged_at=0
                panel off
            else
                panel on
                if (( docked )); then
                    # Just unplugged with the lid shut: give it time to be opened.
                    (( unplugged_at )) || unplugged_at=$SECONDS
                    if (( SECONDS - unplugged_at >= GRACE )); then
                        docked=0; unplugged_at=0
                        sleep_now
                    fi
                elif (( ! was_closed )); then
                    sleep_now
                fi
            fi
            was_closed=1
        else
            external && docked=1 || docked=0
            unplugged_at=0
            # Lid just opened: panel comes back, unless a dock monitor means external-only.
            (( was_closed )) && [[ -z $dock ]] && panel on
            was_closed=0
        fi
        sleep "$POLL"
    done
}

case ${1:-run} in
    run)
        # Re-exec under the inhibitor: while it is held, logind leaves the lid to us.
        exec systemd-inhibit --what=handle-lid-switch --who=hyprland \
            --why="lid.sh handles the lid (docked / undocked)" --mode=block "$0" watch ;;
    watch)     watch ;;
    status)    status ;;
    -h|--help) sed -n '3,21p' "$0" | sed 's/^# \{0,1\}//' ;;
    *)         sed -n '3,21p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
