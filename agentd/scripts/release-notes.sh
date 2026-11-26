#!/usr/bin/env bash
# Release notes for a tag: the version line, "What's new in VERSION" from docs/release-notes/VERSION.md
# (written in the version bump), then the download and update help every release repeats.
#   release-notes.sh VERSION                  fails unless the notes file exists
#   release-notes.sh VERSION ENGINE_RELEASE   prints the notes
# The notes file is only read, never part of a heredoc or command line, so the shell runs nothing in it.
set -euo pipefail
version=${1:?usage: release-notes.sh VERSION [ENGINE_RELEASE]}
engine=${2:-}
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::release-notes.sh: '$version' is not a release version (x.y.z)" >&2
  exit 1
fi
root=$(cd "$(dirname "$0")/../.." && pwd)
file=docs/release-notes/$version.md
if ! [ -f "$root/$file" ] || ! grep -q '[^[:space:]]' "$root/$file"; then
  echo "::error::No release notes for $version: add $file, the list for \"What's new in $version\", in the version bump" >&2
  exit 1
fi
[ -n "$engine" ] || exit 0

whats_new=$(cat "$root/$file")
printf 'LibraOS Next %s, with LibraOS Engine %s and its Skills inside.\n\n' "$version" "$engine"
printf "**What's new in %s**\n\n%s\n\n" "$version" "$whats_new"
cat <<EOF
**Which file to download**

- macOS, Apple silicon (M1 or later): \`LibraOS-Next-$version-arm64.dmg\`
- macOS, Intel: \`LibraOS-Next-$version-x64.dmg\`
- Windows: \`LibraOS-Next-$version-x64.exe\`
- Linux: \`LibraOS-Next-x86_64.AppImage\`, or \`LibraOS-Next-$version-amd64.deb\` on Debian and Ubuntu

Not sure which Mac you have? Apple menu → About This Mac: "Chip: Apple M…" is Apple silicon, "Processor: Intel" is Intel.
The \`.zip\`, \`.blockmap\` and \`latest*.yml\` files are for automatic updates; you don't need them.

**Signing**

- **Windows:** the installer is signed by Nebula Nova, Inc. SmartScreen may still warn for a while after a release.
- **macOS:** the app is signed by Nebula Nova, Inc. and notarized by Apple.

The app checks for updates at launch and every four hours and asks before installing. On macOS, 0.4.0 and later (signed and notarized) update in place; 0.3.1 and earlier open this page instead, so install this version by hand once and it updates itself from then on. 0.1.10-agentd.8 and earlier do not check for updates: install this version by hand once.

Still on the app's earlier version under its old name? Its update installs LibraOS Next in its place on Windows and Linux; on macOS, install LibraOS Next from this page. Threads, settings and sign-in carry over.

Check a download against \`SHA256SUMS\`.
EOF
