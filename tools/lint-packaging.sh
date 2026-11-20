#!/usr/bin/env bash
# The packaging checks that need no build, in seconds (CI runs them first):
#
#   - shellcheck: the launcher, these packaging tools and the PKGBUILD;
#   - desktop-file-validate: packaging/supernova.desktop;
#   - actionlint: .github/workflows/;
#   - the PKGBUILD's castlabs pins are electron.lock's, and its pkgver is
#     package.json's version as pacman spells it, which pacman sorts before
#     the release it leads to.
#
# Needs shellcheck, desktop-file-validate (desktop-file-utils), actionlint,
# vercmp (pacman) and node.
set -euo pipefail
cd "$(dirname "$0")/.."

failed=0
fail() { printf 'lint-packaging: %s\n' "$*" >&2; failed=1; }

for tool in shellcheck desktop-file-validate actionlint vercmp node; do
  command -v "$tool" >/dev/null || { fail "$tool is not installed"; exit 1; }
done

# The shell the packaging added (tools/fetch-electron.sh and run-dev.sh predate it).
shellcheck -x packaging/supernova tools/smoke.sh tools/lint-packaging.sh ||
  fail "shellcheck: the launcher or the packaging tools"
# makepkg sets srcdir and pkgdir (SC2154) and reads pkgname and the arrays
# (SC2034); a failing cd stops the build, as makepkg runs functions with -e (SC2164).
shellcheck --shell=bash --exclude=SC2034,SC2154,SC2164 packaging/arch/PKGBUILD || fail "shellcheck: the PKGBUILD"
desktop-file-validate packaging/supernova.desktop || fail "desktop-file-validate"
actionlint || fail "actionlint"

# The PKGBUILD's values, read in a subshell: at the top level it only sets
# variables and defines functions.
pkgbuild() {
  # shellcheck source=packaging/arch/PKGBUILD
  (. packaging/arch/PKGBUILD && "$@")
}
# shellcheck disable=SC2016 # expanded by the subshell, after sourcing
mapfile -t pins < <(pkgbuild eval 'printf "%s\n" "$_electron_version" "$_electron_url" "$_electron_sha256" "${sha256sums[1]}" "$pkgver"')
lock() { sed -n "s/^$1=//p" electron.lock; }
[[ ${pins[0]} == "$(lock version)" ]] || fail "PKGBUILD _electron_version=${pins[0]}, electron.lock version=$(lock version)"
[[ ${pins[1]} == "$(lock url)" ]] || fail "PKGBUILD _electron_url=${pins[1]}, electron.lock url=$(lock url)"
[[ ${pins[2]} == "$(lock sha256)" ]] || fail "PKGBUILD _electron_sha256=${pins[2]}, electron.lock sha256=$(lock sha256)"
[[ ${pins[3]} == "$(lock sha256)" ]] || fail "PKGBUILD sha256sums[1]=${pins[3]} is not electron.lock's sha256"

version=$(node -p 'require("./package.json").version')
if want=$(pkgbuild _pkgver_of "$version"); then
  [[ ${pins[4]} == "$want" ]] ||
    fail "PKGBUILD pkgver=${pins[4]}, but package.json's $version is $want (makepkg would rewrite the PKGBUILD)"
  if [[ $version == *-* ]]; then
    release=$(pkgbuild _pkgver_of "${version%%-*}")
    (($(vercmp "$want" "$release") < 0)) || fail "pacman sorts $want after $release"
  fi
else
  fail "package.json's version $version has no pkgver"
fi

((failed == 0)) || exit 1
echo "lint-packaging: ok"
