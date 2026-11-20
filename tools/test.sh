#!/usr/bin/env bash
# Runs the unit tests with a throwaway HOME and XDG dirs and an otherwise
# empty environment, so no test can read or write the real profile, keyring,
# D-Bus session or Chrome data. `npm test` runs this.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d -t supernova-test.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home" "$tmp/config" "$tmp/data" "$tmp/state" "$tmp/cache" "$tmp/run"
chmod 700 "$tmp/run"
node_bin="$(command -v node)"
cd "$root"
[ $# -eq 0 ] && set -- test/*.test.js
exec env -i \
  PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  HOME="$tmp/home" \
  XDG_CONFIG_HOME="$tmp/config" XDG_DATA_HOME="$tmp/data" XDG_STATE_HOME="$tmp/state" \
  XDG_CACHE_HOME="$tmp/cache" XDG_RUNTIME_DIR="$tmp/run" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$tmp/run/no-bus" \
  LANG=C.UTF-8 TZ=UTC \
  "$node_bin" --test "$@"
