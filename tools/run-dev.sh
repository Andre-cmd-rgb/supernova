#!/bin/bash
# Run Supernova from the source tree with the pinned castlabs Electron.
# SUPERNOVA_PROFILE=/some/dir keeps a separate profile (used by tests/bench).
cd "$(dirname "$0")/.."
unset ELECTRON_RUN_AS_NODE
[[ -x .electron/electron ]] || tools/fetch-electron.sh
[[ -f dist/preload/page-preload.js ]] || node tools/build.mjs
exec .electron/electron . "$@"
