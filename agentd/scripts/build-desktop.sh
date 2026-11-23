#!/usr/bin/env bash
# AgentD Next with agentd inside. Usage: agentd/scripts/build-desktop.sh linux|win|mac [arm64|x64]
#
# Writes release/AgentD-Next-<version>-<arch>.{deb,exe,dmg,zip}, AgentD-Next-x86_64.AppImage (no
# version in the name, so the updater replaces it in place) and the updater's latest*.yml. Nothing is
# published (.github/workflows/release.yml does that). For linux and win it runs the upstream packager
# (scripts/build-desktop-artifact.ts) by default inside a container made from electron-builder's Wine
# image, pinned by digest, plus Rust, MinGW and ImageMagick, so the host needs only Docker, git, gh and
# the repository's Node and dependencies. mac always builds on the host (a Mac with Xcode's command line
# tools and Rust), unsigned and ad-hoc signed; its arch defaults to the host's.
#
#   AGENTD_UPDATE_REPOSITORY  GitHub releases the app updates from (default libraos/agentd-next;
#                             empty: no update feed)
#   AGENTD_DIST_DIR=DIR       agentd release assets and their SHA256SUMS; unset: downloaded with gh
#   AGENTD_RELEASE=vX.Y.Z     the agentd release to download (default: the latest of libraos/agentd)
#   AGENTD_BUILD_ON_HOST=1    run the packager here, not in the container (the host then needs
#                             cargo, cc, make, libsecret-1-dev and ImageMagick; win: Windows with
#                             MSVC, run from Git Bash)
set -euo pipefail

usage="usage: $0 linux|win|mac [arm64|x64]"
platform=${1:-}
arch=${2:-}
case "$platform" in
  linux) target=AppImage os=linux ;;
  win) target=nsis os=windows ;;
  mac)
    target=dmg os=darwin
    if [ "$(uname -s)" != Darwin ]; then
      echo "mac builds need macOS (Xcode's codesign, hdiutil, sips)" >&2; exit 2
    fi
    AGENTD_BUILD_ON_HOST=1
    if [ -z "$arch" ]; then
      case "$(uname -m)" in arm64) arch=arm64 ;; *) arch=x64 ;; esac
    fi
    ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
arch=${arch:-x64}
case "$platform/$arch" in
  mac/arm64 | */x64) ;;
  *) echo "$usage (arm64 is mac only)" >&2; exit 2 ;;
esac
case "$arch" in arm64) cpu=arm64 ;; *) cpu=amd64 ;; esac
agentd_asset=agentd-$os-$cpu
[ "$platform" = win ] && agentd_asset=$agentd_asset.exe

repo=$(git -C "$(dirname -- "$0")" rev-parse --show-toplevel)
cd "$repo"

builder_image=electronuserland/builder@sha256:f3a8d451994c881d0972e7b1846ee4d4fdc15eb41fc6b1f350b38cbf99ca90fe
rust_toolchain=1.100.0
win_rust_target=x86_64-pc-windows-gnu
home_dir=$repo/release/.agentd-build-home

# Our own version, not upstream's: apps/desktop/package.json carries it (agentd/UPSTREAM.md names the base).
version=$(node -p 'require("./apps/desktop/package.json").version')
case "$version" in
  *[!0-9.]* | *.*.*.* | .* | *. | *..*) echo "bad version: $version (want x.y.z)" >&2; exit 2 ;;
  *.*.*) ;;
  *) echo "bad version: $version (want x.y.z)" >&2; exit 2 ;;
esac

if [ "${AGENTD_BUILD_INSIDE:-}" != 1 ]; then
  if [ -z "${AGENTD_DIST_DIR:-}" ]; then
    release=${AGENTD_RELEASE:-$(gh release view -R libraos/agentd --json tagName -q .tagName)}
    AGENTD_DIST_DIR=$repo/release/agentd-dist/$release
    # The Skills too: the packager bundles them beside the binary (#55).
    # The packager checks each one against SHA256SUMS before bundling it.
    if [ ! -s "$AGENTD_DIST_DIR/SHA256SUMS" ] || [ ! -s "$AGENTD_DIST_DIR/$agentd_asset" ] ||
      [ ! -s "$AGENTD_DIST_DIR/SKILL.md" ] || [ ! -s "$AGENTD_DIST_DIR/SKILL-agentd.md" ]; then
      mkdir -p "$AGENTD_DIST_DIR"
      gh release download "$release" -R libraos/agentd -D "$AGENTD_DIST_DIR" --clobber \
        -p SHA256SUMS -p "$agentd_asset" -p SKILL.md -p SKILL-agentd.md
    fi
  fi
  # pwd -W: Git Bash on Windows gives the Windows path that Node needs.
  AGENTD_DIST_DIR=$(cd "$AGENTD_DIST_DIR" && { pwd -W 2>/dev/null || pwd; })
  export AGENTD_DIST_DIR

  if [ "${AGENTD_BUILD_ON_HOST:-}" != 1 ]; then
    # Electron's runtime libraries: the packager runs the packaged app to fill the compile cache.
    dockerfile="FROM $builder_image
RUN apt-get update && apt-get install -y --no-install-recommends imagemagick mingw-w64 \\
      libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libnss3 libgbm1 libasound2 libxss1 libxshmfence1 libcups2 libdrm2 libxkbcommon0 \\
 && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:\$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain $rust_toolchain \\
      --target x86_64-unknown-linux-gnu --target $win_rust_target \\
 && chmod -R a+rX /opt/rustup /opt/cargo"
    image=agentd-desktop-builder:$(printf '%s' "$dockerfile" | sha256sum | cut -c1-16)
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      printf '%s\n' "$dockerfile" | docker build -t "$image" -
    fi
    mkdir -p "$home_dir"
    node_dir=$(dirname -- "$(command -v node)")
    git_common=$(cd "$(git rev-parse --git-common-dir)" && pwd)
    # The repository is mounted at /w: electron-builder's bundled makensis (3.0.4.1) dies with
    # "stack smashing detected" on include paths near 300 characters, which pnpm's patched
    # app-builder-lib directory reaches under a deep checkout.
    mounts=(-v "$repo:/w" -v "$node_dir:$node_dir:ro" -v "$git_common:$git_common:ro"
      -v "$AGENTD_DIST_DIR:/agentd-dist:ro")
    if [ -n "${npm_config_store_dir:-}" ]; then
      mounts+=(-v "$npm_config_store_dir:$npm_config_store_dir")
    fi
    exec docker run --rm --init -u "$(id -u):$(id -g)" "${mounts[@]}" -w /w \
      -e HOME=/w/release/.agentd-build-home -e CARGO_HOME=/w/release/.agentd-build-home/cargo \
      -e RUSTUP_HOME=/opt/rustup \
      -e PATH="$node_dir:/w/node_modules/.bin:/opt/cargo/bin:/usr/local/bin:/usr/bin:/bin" \
      -e AGENTD_BUILD_INSIDE=1 -e AGENTD_DIST_DIR=/agentd-dist -e AGENTD_UPDATE_REPOSITORY \
      -e npm_config_store_dir -e T3CODE_DESKTOP_VERBOSE -e T3CODE_DESKTOP_SKIP_BUILD \
      "$image" bash agentd/scripts/build-desktop.sh "$platform"
  fi
fi

export T3CODE_DESKTOP_VERSION=$version
# The feed is ours alone: a GitHub repository from the environment (CI sets one) must not choose it.
unset GITHUB_REPOSITORY
export T3CODE_DESKTOP_UPDATE_REPOSITORY=${AGENTD_UPDATE_REPOSITORY-libraos/agentd-next}

if [ "$platform" = win ] && [ "${AGENTD_BUILD_INSIDE:-}" = 1 ]; then
  # Off Windows there is no MSVC: build the resource monitor with MinGW and hand it to the
  # packager as a reused build at the MSVC target path it reads.
  cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml \
    --target "$win_rust_target"
  msvc_out=native/resource-monitor/target/x86_64-pc-windows-msvc/release
  mkdir -p "$msvc_out"
  cp "native/resource-monitor/target/$win_rust_target/release/t3-resource-monitor.exe" "$msvc_out/"
  export T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=1
fi

echo "[agentd] building $platform/$target $arch $version with agentd from $AGENTD_DIST_DIR"
node scripts/build-desktop-artifact.ts --platform "$platform" --target "$target" --arch "$arch"
if [ "$platform" = linux ] && [ -e "release/AgentD-Next-$version-x86_64.AppImage" ]; then
  # Without a feed the AppImage is versioned; it then carries x64 as on Windows. With one, its name
  # is what latest-linux.yml lists, so it stays.
  mv -f "release/AgentD-Next-$version-x86_64.AppImage" "release/AgentD-Next-$version-x64.AppImage"
fi
ls -l release/AgentD-Next-* release/*.yml 2>/dev/null || true
