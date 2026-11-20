#!/usr/bin/env bash
# Alternates Chrome and Supernova over several rounds, windowed and
# fullscreen, plus Supernova on (simulated) battery, then prints medians.
#   bench/series.sh [rounds=3] [seconds=30]
# QUALITY=hd1080 (the default) holds both browsers to the same stream, so the
# numbers compare the browsers and not YouTube's choice; QUALITY=auto leaves
# the choice to YouTube.
set -euo pipefail
cd "$(dirname "$0")/.."
rounds="${1:-3}"
seconds="${2:-30}"
since="$(date -u +%Y-%m-%dT%H:%M:%S)"
quality="${QUALITY:-hd1080}"
q=()
[ "$quality" != auto ] && q=(--quality "$quality")
for r in $(seq "$rounds"); do
  for extra in "" "--fullscreen"; do
    for b in chrome supernova; do
      node bench/yt-bench.mjs --browser "$b" --seconds "$seconds" "${q[@]}" $extra || echo "run failed: $b $extra"
      sleep 4
    done
  done
  node bench/yt-bench.mjs --browser supernova --battery --seconds "$seconds" "${q[@]}" || echo "run failed: battery"
  sleep 4
done
node bench/summary.mjs --since "$since"
