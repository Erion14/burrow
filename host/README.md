# Burrow host setup

Host-side pieces that keep the host reachable from the phone. No Burrow
application code. Written for a Fedora machine running Hyprland, `systemd --user`
with linger enabled, and `tailscale serve` as the only entry point; on another
setup take the parts that apply.

`hypridle.conf` carries `$HOME` as a placeholder rather than a path from one
machine, and `install.sh` expands it while installing.

## What goes where

| Source | Destination |
| --- | --- |
| `remote.sh`, `lid.sh`, `sleep-guard.sh` | `~/.config/hypr/scripts/` (executable) |
| `hypridle.conf` | `~/.config/hypr/hypridle.conf` |
| `systemd/burrow.service` | `~/.config/systemd/user/` (started and stopped by `remote.sh on/off`) |
| `systemd/burrow-wake.service` | `~/.config/systemd/user/` (enabled, always on) |
| `logind/60-burrow-lid.conf` | `/etc/systemd/logind.conf.d/60-burrow-lid.conf` (sudo) |
| `gdm/90-burrow-idle` | `/etc/dconf/db/gdm.d/90-burrow-idle` (sudo) |

`sleep-guard.sh suspend-if-battery` is the single suspend decision: on the charger it does nothing, on battery it runs `systemctl suspend`. `lid.sh` and the 900 s hypridle listener both use it. `remote.sh on` still holds the sleep inhibitor and also starts `burrow.service`; `off` stops both.

## Install

    host/install.sh --print-only   # see every command
    host/install.sh

The script installs the user parts, enables `burrow-wake.service`, and sets the permanent serve config:

    tailscale serve --bg --https=443 --set-path /wake http://127.0.0.1:7471
    tailscale serve --bg --https=443 http://127.0.0.1:7470

It does not run the two sudo commands:

    sudo install -D -m 0644 host/logind/60-burrow-lid.conf /etc/systemd/logind.conf.d/60-burrow-lid.conf
    sudo install -D -m 0644 host/gdm/90-burrow-idle /etc/dconf/db/gdm.d/90-burrow-idle && sudo dconf update

Restart hypridle afterwards (`pkill hypridle; hyprctl dispatch exec hypridle`) so the new listener applies.

## Check

    tailscale serve status    # / -> 127.0.0.1:7470, /wake -> 127.0.0.1:7471
    systemctl --user status burrow-wake.service
    ~/.config/hypr/scripts/sleep-guard.sh on-ac; echo $?   # 0 on charger, 1 on battery

Hand checks (PLAN.md build order step 1):

1. Close the lid on the charger for over 15 minutes. The host must stay up.
2. Reboot. `/wake` must still answer over the tailnet.
3. `remote.sh on` starts `burrow.service`; `remote.sh off` stops it (`systemctl --user is-active burrow.service`).
4. On battery, lid close and the 15 minute idle still suspend.
