#!/bin/bash
# Zips the macOS release builds (both Intel and Apple Silicon) for GitHub
# Release attachment. Run from the repo root: packaging/macos/build.sh <version>
#
# Expects (already built by the caller):
#   dist/FileConverterApp/FileConverterApp-mac_x64    (neu build --release --embed-resources)
#   dist/FileConverterApp/FileConverterApp-mac_arm64
#   binaries/mac_x64/ffmpeg                            (node setup.mjs, or copied --
#     evermeet.cx ships one build used for both arches, see setup.mjs)
#   binaries/mac_arm64/ffmpeg
set -euo pipefail

VERSION="${1:?Usage: build.sh <version>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$REPO_ROOT/release-assets"
mkdir -p "$OUT_DIR"

for ARCH in x64 arm64; do
  EXE="$REPO_ROOT/dist/FileConverterApp/FileConverterApp-mac_${ARCH}"
  FFMPEG_BIN="$REPO_ROOT/binaries/mac_${ARCH}/ffmpeg"
  if [ ! -f "$EXE" ]; then
    echo "Missing $EXE -- run 'neu build --release --embed-resources' first" >&2
    exit 1
  fi
  if [ ! -f "$FFMPEG_BIN" ]; then
    echo "Missing $FFMPEG_BIN -- run 'node setup.mjs' first (see packaging note on copying to both arches)" >&2
    exit 1
  fi

  STAGE_DIR="$(mktemp -d)"
  mkdir -p "$STAGE_DIR/binaries/mac_${ARCH}"
  install -m 755 "$EXE" "$STAGE_DIR/sorai-toolkit"
  install -m 755 "$FFMPEG_BIN" "$STAGE_DIR/binaries/mac_${ARCH}/ffmpeg"

  ZIP_PATH="$OUT_DIR/sorai-toolkit-${VERSION}-mac_${ARCH}.zip"
  (cd "$STAGE_DIR" && zip -qr "$ZIP_PATH" .)
  rm -rf "$STAGE_DIR"
  echo "Built $ZIP_PATH"
done
