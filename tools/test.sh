#!/usr/bin/env bash
# Runs the unit tests with a throwaway HOME and XDG dirs and an otherwise
# empty environment, so no test can read or write the real profile, keyring,
# D-Bus (session or system bus) or Chrome data, and TMPDIR inside the same throwaway dir, so
# what tests leave in os.tmpdir() goes with it. `npm test` runs this.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d -t supernova-test.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home" "$tmp/config" "$tmp/data" "$tmp/state" "$tmp/cache" "$tmp/run" "$tmp/tmp"
chmod 700 "$tmp/run"
node_bin="$(command -v node)"
cd "$root"
[ $# -eq 0 ] && set -- test/*.test.js
# Not exec: the EXIT trap must run to remove the throwaway dirs.
env -i \
  PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  HOME="$tmp/home" \
  XDG_CONFIG_HOME="$tmp/config" XDG_DATA_HOME="$tmp/data" XDG_STATE_HOME="$tmp/state" \
  XDG_CACHE_HOME="$tmp/cache" XDG_RUNTIME_DIR="$tmp/run" TMPDIR="$tmp/tmp" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$tmp/run/no-bus" \
  DBUS_SYSTEM_BUS_ADDRESS="unix:path=$tmp/run/no-system-bus" \
  LANG=C.UTF-8 TZ=UTC \
  "$node_bin" --test "$@"
