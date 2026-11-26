#!/usr/bin/env bash
# Release gate for the macOS build (#286): fails unless the app in the DMG and in the updater zip is
# signed with a Developer ID of $3's team, accepted by Gatekeeper as notarized, has its ticket
# stapled, and every Mach-O inside carries the hardened runtime and a secure timestamp.
# electron-builder skips notarization without the APPLE_API_* variables and still exits 0.
set -euo pipefail
dmg=$1 zip=$2 team=$3
failed=0
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/macos-signatures.XXXXXX")
mnt="$work/dmg"
trap 'hdiutil detach "$mnt" -quiet 2>/dev/null || true; rm -rf "$work"' EXIT

error() {
  echo "::error::$*"
  failed=1
}

check_app() {
  local app=$1 info file binary checked=0
  if [[ ! -d "$app" ]]; then
    error "missing $app"
    return
  fi
  codesign --verify --deep --strict --verbose=2 "$app" || error "$app fails codesign --verify"
  info=$(codesign -dvv "$app" 2>&1) || true
  grep -q "^TeamIdentifier=$team\$" <<<"$info" || error "$app is not signed by team $team"
  grep -q "^Authority=Developer ID Application: " <<<"$info" || error "$app has no Developer ID signature"
  spctl --assess --type execute -vv "$app" 2>&1 | tee "$work/spctl"
  grep -q "source=Notarized Developer ID" "$work/spctl" || error "Gatekeeper does not accept $app as notarized"
  xcrun stapler validate "$app" || error "$app has no stapled notarization ticket"
  # The engine binary, native modules and helpers: notarization needs each one signed this way.
  while IFS= read -r -d '' file; do
    file -b "$file" | grep -q "^Mach-O" || continue
    checked=$((checked + 1))
    binary=$(codesign -dvv "$file" 2>&1) || {
      error "$file is not signed"
      continue
    }
    grep -q "^TeamIdentifier=$team\$" <<<"$binary" || error "$file is not signed by team $team"
    grep -q "^CodeDirectory .*flags=.*runtime" <<<"$binary" || error "$file lacks the hardened runtime"
    grep -q "^Timestamp=" <<<"$binary" || error "$file has no secure timestamp"
  done < <(find "$app/Contents" -type f \( -perm -u+x -o -name "*.dylib" -o -name "*.node" -o -name "*.so" \) -print0)
  echo "$app: checked $checked Mach-O files"
}

hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mnt" -quiet
check_app "$mnt/LibraOS Next.app"
mkdir "$work/zip"
ditto -x -k "$zip" "$work/zip"
check_app "$work/zip/LibraOS Next.app"
exit "$failed"
