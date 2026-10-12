#!/usr/bin/env bash
#
#   sleep-guard.sh suspend-if-battery   suspend unless a charger is connected
#   sleep-guard.sh on-ac                exit 0 on AC power, 1 on battery
#   sleep-guard.sh --help               this text
#
# The one place that decides "may the host suspend now?" (hypridle, lid.sh).

set -uo pipefail

on_ac() {
    local d
    for d in /sys/class/power_supply/*; do
        [[ -r $d/type && $(cat "$d/type" 2>/dev/null) == Mains ]] || continue
        [[ $(cat "$d/online" 2>/dev/null) == 1 ]] && return 0
    done
    return 1
}

case ${1:-} in
    suspend-if-battery) on_ac && exit 0; exec systemctl suspend ;;
    on-ac)              on_ac ;;
    -h|--help)          sed -n '3,6p' "$0" | sed 's/^# \{0,1\}//' ;;
    *)                  sed -n '3,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
