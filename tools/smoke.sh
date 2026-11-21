#!/usr/bin/env bash
# Starts Supernova headless, twice, and fails unless both starts work:
#
#   1. SUPERNOVA_SMOKE=1: the browser checks its page preload, internal API
#      and UI itself (smokeTest() in src/main/main.js) and prints
#      "supernova: smoke ok".
#   2. A page named on the command line, as `supernova <file>` opens one: its
#      title must reach the saved session, so the argument was read (a packaged
#      build slices argv differently from `electron .`) and the page loaded.
#
#   tools/smoke.sh <binary> [app dir]
#     tools/smoke.sh .electron/electron .                         the source tree
#     tools/smoke.sh packaging/arch/pkg/supernova/usr/lib/supernova/supernova
#     tools/smoke.sh /usr/bin/supernova                           the installed package
#
# Each start gets its own throwaway profile, HOME and XDG dirs, and an
# otherwise empty environment: no display, no D-Bus session or system bus, so
# nothing of the user's is read or written.
#
# Chromium's sandbox stays on, as it runs for the user, except as root, where
# Chromium refuses it, or with SUPERNOVA_SMOKE_NO_SANDBOX=1, for containers
# whose seccomp policy forbids the user namespaces it is built on (Docker's
# default one does, so CI sets it).
set -euo pipefail

die() { printf 'smoke: %s\n' "$*" >&2; exit 1; }

(($# == 1 || $# == 2)) || die "usage: tools/smoke.sh <binary> [app dir]"
bin=$1
if [[ $bin != */* ]]; then
  bin=$(command -v -- "$bin") || die "$1: no such command"
fi
[[ -f $bin && -x $bin ]] || die "$bin is not an executable"
bin=$(cd -- "$(dirname -- "$bin")" && pwd)/${bin##*/}
app=()
if (($# == 2)); then app=("$(cd -- "$2" && pwd)"); fi

tmp=$(mktemp -d -t supernova-smoke.XXXXXX)
pid=
cleanup() {
  # timeout leads the browser's process group: this stops all of it.
  if [[ -n $pid ]]; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
  rm -rf -- "$tmp"
}
trap cleanup EXIT

flags=(--ozone-platform=headless)
if ((EUID == 0)); then
  echo "smoke: running as root, where Chromium's sandbox cannot run: --no-sandbox"
  flags+=(--no-sandbox)
elif [[ ${SUPERNOVA_SMOKE_NO_SANDBOX:-} == 1 ]]; then
  echo "smoke: SUPERNOVA_SMOKE_NO_SANDBOX=1: --no-sandbox"
  flags+=(--no-sandbox)
elif command -v unshare >/dev/null && ! unshare --user --pid --net --fork true 2>/dev/null; then
  die "this machine forbids unprivileged user namespaces, which Chromium's sandbox needs" \
    "(and the package ships no setuid helper). In a container that forbids them, set SUPERNOVA_SMOKE_NO_SANDBOX=1."
fi

# clean_env <name>: sets env_cmd, an `env -i` with a fresh home under $tmp/<name>.
clean_env() {
  local h=$tmp/$1
  mkdir -p "$h"/{home,config,data,state,cache,run,tmp,profile}
  chmod 700 "$h/run"
  profile=$h/profile
  env_cmd=(env -i
    PATH=/usr/bin:/bin
    HOME="$h/home" TMPDIR="$h/tmp"
    XDG_CONFIG_HOME="$h/config" XDG_DATA_HOME="$h/data" XDG_STATE_HOME="$h/state"
    XDG_CACHE_HOME="$h/cache" XDG_RUNTIME_DIR="$h/run"
    DBUS_SESSION_BUS_ADDRESS="unix:path=$h/run/no-bus"
    DBUS_SYSTEM_BUS_ADDRESS="unix:path=$h/run/no-system-bus"
    LANG=C.UTF-8 TZ=UTC
    SUPERNOVA_PROFILE="$h/profile")
}

show_log() { echo "--- $1 (last 40 lines)" >&2; tail -n 40 -- "$1" >&2; echo "---" >&2; }

# 1. The browser's own check. `timeout` runs it in a process group of its own
# and stops the whole group (renderers, GPU process) if it hangs.
clean_env check
log=$tmp/check.log
status=0
"${env_cmd[@]}" SUPERNOVA_SMOKE=1 timeout -k 5 90 "$bin" "${app[@]}" "${flags[@]}" >"$log" 2>&1 || status=$?
if ! line=$(grep -m1 '^supernova: smoke ok' "$log"); then
  show_log "$log"
  die "the browser's check failed (exit $status)"
fi
echo "smoke: $line"

# 2. A page from the command line. The title is only in the page, not in its
# path, so seeing it in session.json means the page itself was loaded. The
# switches go before the app folder here, as Electron allows (url.js ownArgs
# and its test check that the folder is not taken for a page).
clean_env url
title=supernova-smoke-$$-$RANDOM
page=$tmp/page/smoke-page.html
mkdir -p "${page%/*}"
printf '<!doctype html><meta charset="utf-8"><title>%s</title><p>%s</p>\n' "$title" "$title" >"$page"
log=$tmp/url.log
"${env_cmd[@]}" timeout -k 5 90 "$bin" "${flags[@]}" "${app[@]}" "$page" >"$log" 2>&1 &
pid=$!
found=0
for ((i = 0; i < 300; i++)); do
  if grep -qF "\"$title\"" "$profile/session.json" 2>/dev/null; then found=1; break; fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.1
done
# timeout passes the TERM on to the browser's whole process group.
kill -TERM "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
pid=
if ((!found)); then
  show_log "$log"
  die "$page, given on the command line, did not open (its title never reached session.json)"
fi
echo "smoke: the command line's page opened (\"$title\" in session.json)"
echo "smoke: ok ($bin)"
