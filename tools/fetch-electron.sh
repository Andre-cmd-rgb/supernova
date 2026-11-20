#!/bin/bash
# Download the pinned castlabs Electron (electron.lock) into .electron/,
# checking its sha256 first. Re-running is cheap: the zip is cached.
set -euo pipefail
cd "$(dirname "$0")/.."
. <(grep -E '^(version|url|sha256)=' electron.lock)
mkdir -p .electron-cache
zip=.electron-cache/electron-$version-linux-x64.zip
if [[ ! -f $zip ]] || ! echo "$sha256  $zip" | sha256sum -c --quiet 2>/dev/null; then
  curl -fL --retry 3 -o "$zip.part" "$url"
  echo "$sha256  $zip.part" | sha256sum -c --quiet
  mv "$zip.part" "$zip"
fi
if [[ ! -f .electron/version ]] || [[ $(cat .electron/.lock-version 2>/dev/null) != "$version" ]]; then
  rm -rf .electron && mkdir .electron
  bsdtar -xf "$zip" -C .electron 2>/dev/null || unzip -q "$zip" -d .electron
  echo "$version" > .electron/.lock-version
fi
echo ".electron/ has castlabs Electron $version"
