#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

apply=0
disable_system_conflict=0
for argument in "$@"; do
  case "$argument" in
    --apply) apply=1 ;;
    --disable-system-conflict) disable_system_conflict=1 ;;
    *) printf 'Unknown argument: %s\n' "$argument" >&2; exit 2 ;;
  esac
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
systemctl_bin="${SYSTEMCTL_BIN:-systemctl}"
sudo_bin="${SUDO_BIN:-sudo}"
project_dir="${PEDIVOY_PROJECT_DIR:-$HOME/.openclaw/workspace-pedivoy/PediVoy}"
node_bin="${PEDIVOY_NODE_BIN:-$HOME/.nvm/versions/node/v22.22.0/bin/node}"
units=(pedivoy-storage-maintenance.service pedivoy-storage-maintenance.timer)

validate_prerequisites() {
  local actual_node_version
  if [ ! -x "$node_bin" ]; then
    printf 'PediVoy maintenance requires executable Node from the validated Node v22.22.0 runtime.\n' >&2
    return 5
  fi
  actual_node_version="$("$node_bin" --version 2>/dev/null || true)"
  if [ "$actual_node_version" != 'v22.22.0' ]; then
    printf 'PediVoy requires Node v22.22.0; found %s at %s.\n' "${actual_node_version:-unknown}" "$node_bin" >&2
    return 5
  fi
  for required in \
    scripts/prepare-puppeteer-cache.js \
    scripts/storage-maintenance.js \
    config/storage-policy.json; do
    if [ ! -f "$project_dir/$required" ]; then
      printf 'PediVoy runtime prerequisite missing: %s\n' "$project_dir/$required" >&2
      return 5
    fi
  done
}

query_state() {
  local scope="$1"
  local action="$2"
  local output
  local status
  set +e
  if [ "$scope" = user ]; then
    output="$("$systemctl_bin" --user "$action" pedivoy.service 2>&1)"
    status=$?
  else
    output="$("$systemctl_bin" "$action" pedivoy.service 2>&1)"
    status=$?
  fi
  set -e
  if [ "$status" -eq 0 ]; then
    printf '1'
    return 0
  fi
  case "$action:$output" in
    is-enabled:disabled|is-enabled:static|is-enabled:indirect|is-enabled:masked|is-enabled:not-found|is-enabled:generated|is-enabled:transient|is-active:inactive|is-active:failed|is-active:unknown)
      printf '0'
      return 0
      ;;
  esac
  printf 'Cannot determine %s pedivoy.service state (%s): %s\n' "$scope" "$action" "${output:-no status returned}" >&2
  return 4
}

system_enabled="$(query_state system is-enabled)"
system_active="$(query_state system is-active)"
user_enabled="$(query_state user is-enabled)"
user_active="$(query_state user is-active)"
system_conflict=0
if [ "$system_enabled" -eq 1 ] || [ "$system_active" -eq 1 ]; then system_conflict=1; fi

printf 'PediVoy systemd installer: %s\n' "$([ "$apply" -eq 1 ] && printf apply || printf dry-run)"
printf 'system pedivoy.service enabled: %s; active: %s\n' "$system_enabled" "$system_active"
printf 'user pedivoy.service enabled: %s\n' "$user_enabled"
printf 'user pedivoy.service active: %s\n' "$user_active"
if [ "$system_conflict" -eq 1 ]; then
  printf 'Conflict detected: system pedivoy.service is enabled or active while the canonical unit is user-scoped.\n'
fi

if [ "$apply" -eq 0 ]; then
  printf 'DRY-RUN: would install maintenance units into %s and enable the maintenance timer without replacing pedivoy.service.\n' "$unit_dir"
  if [ "$system_conflict" -eq 1 ] && [ "$disable_system_conflict" -eq 0 ]; then
    printf 'DRY-RUN: apply would stop before changes unless --disable-system-conflict is explicit.\n'
  elif [ "$system_conflict" -eq 1 ]; then
    printf 'DRY-RUN: would disable and stop the system pedivoy.service first.\n'
  fi
  exit 0
fi

if [ "$system_conflict" -eq 1 ] && [ "$disable_system_conflict" -eq 0 ]; then
  printf 'Refusing apply: rerun with --disable-system-conflict to explicitly disable the system unit.\n' >&2
  exit 3
fi

validate_prerequisites

if [ "$system_conflict" -eq 1 ]; then
  if [ "$user_active" -ne 1 ]; then
    printf 'Refusing to disable system pedivoy.service because the canonical user service is not active.\n' >&2
    exit 6
  fi
  "$sudo_bin" "$systemctl_bin" disable --now pedivoy.service
fi

mkdir -p "$unit_dir"
for unit in "${units[@]}"; do
  install -m 0644 "$script_dir/$unit" "$unit_dir/$unit"
done
"$systemctl_bin" --user daemon-reload
"$systemctl_bin" --user enable --now pedivoy-storage-maintenance.timer
"$systemctl_bin" --user is-active pedivoy.service
"$systemctl_bin" --user is-enabled pedivoy-storage-maintenance.timer
printf 'Installed and enabled PediVoy maintenance units without replacing the active application service.\n'
