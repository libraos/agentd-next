#!/usr/bin/env bash
# Runs every flow against a fresh scripts/mobile-ui-host.ts, on the one booted device or emulator.
#   apps/mobile/maestro/run-flows.sh <address the device reaches this machine at> <output dir>
# An Android emulator reaches its host at 10.0.2.2; an iOS simulator shares the host's network.
set -euo pipefail

device_host=$1
out=$(mkdir -p "$2" && cd "$2" && pwd)
repo=$(cd "$(dirname "$0")/../../.." && pwd)
flows="$repo/apps/mobile/maestro"

node "$repo/scripts/mobile-ui-host.ts" start --bind 0.0.0.0 --device-host "$device_host" \
  --base-dir "$out/host" >"$out/host.json" &
host_pid=$!
trap 'kill "$host_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 240); do
  [ -s "$out/host.json" ] && break
  if ! kill -0 "$host_pid" 2>/dev/null; then
    cat "$out/host/server.log" >&2 || true
    exit 1
  fi
  sleep 1
done

field() { node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).$1" "$out/host.json"; }
host_env=(
  -e "HOST=$(field host)"
  -e "CODE=$(field code)"
  -e "ENVIRONMENT_ID=$(field environmentId)"
  -e "ENVIRONMENT_NAME=$(field environmentName)"
)

# takeScreenshot writes beside the working directory.
mkdir -p "$out/screenshots"
cd "$out/screenshots"
maestro test --test-output-dir "$out/maestro" "${host_env[@]}" "$flows/pair-and-engine.yaml"
node "$repo/scripts/mobile-ui-host.ts" revoke-all --base-dir "$out/host"
maestro test --test-output-dir "$out/maestro" "${host_env[@]}" "$flows/pair-revoked.yaml"
maestro test --test-output-dir "$out/maestro" "$flows/pair-loopback.yaml"
