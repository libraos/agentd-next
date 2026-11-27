#!/usr/bin/env bash
# Installs the Maestro CLI at MAESTRO_VERSION, refusing a download whose SHA-256 is not MAESTRO_SHA256.
set -euo pipefail

: "${MAESTRO_VERSION:?}" "${MAESTRO_SHA256:?}"
dir="$RUNNER_TEMP/maestro-cli"
mkdir -p "$dir"
curl -fsSL -o "$dir/maestro.zip" \
  "https://github.com/mobile-dev-inc/maestro/releases/download/cli-$MAESTRO_VERSION/maestro.zip"
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$dir/maestro.zip" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 "$dir/maestro.zip" | cut -d' ' -f1)
fi
if [ "$actual" != "$MAESTRO_SHA256" ]; then
  echo "maestro.zip has SHA-256 $actual, expected $MAESTRO_SHA256" >&2
  exit 1
fi
unzip -q "$dir/maestro.zip" -d "$dir"
echo "$dir/maestro/bin" >>"$GITHUB_PATH"
