#!/bin/bash
# Assembles SORAI Toolkit.app bundles (Intel + Apple Silicon) and wraps each
# in a drag-to-Applications .dmg. Run from the repo root:
#   packaging/macos/build.sh <version>
#
# Expects (already built by the caller):
#   dist/FileConverterApp/FileConverterApp-mac_x64    (neu build --release --embed-resources)
#   dist/FileConverterApp/FileConverterApp-mac_arm64
#   binaries/mac_x64/ffmpeg                            (node setup.mjs, or copied --
#     evermeet.cx ships one build used for both arches, see setup.mjs)
#   binaries/mac_arm64/ffmpeg
#
# macOS-only (sips/iconutil/hdiutil) -- must run on a real Mac or macos-latest CI.
set -euo pipefail

VERSION="${1:?Usage: build.sh <version>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG_DIR="$REPO_ROOT/packaging/macos"
OUT_DIR="$REPO_ROOT/release-assets"
mkdir -p "$OUT_DIR"

# ---- Build the .icns once (shared by both arch bundles) ----
ICNS_WORKDIR="$(mktemp -d)"
ICONSET="$ICNS_WORKDIR/AppIcon.iconset"
mkdir -p "$ICONSET"
SRC_ICON="$REPO_ROOT/resources/icons/appIcon.png"
for spec in "16:icon_16x16.png" "32:icon_16x16@2x.png" "32:icon_32x32.png" "64:icon_32x32@2x.png" \
            "128:icon_128x128.png" "256:icon_128x128@2x.png" "256:icon_256x256.png" \
            "512:icon_256x256@2x.png" "512:icon_512x512.png" "1024:icon_512x512@2x.png"; do
  size="${spec%%:*}"
  name="${spec#*:}"
  sips -z "$size" "$size" "$SRC_ICON" --out "$ICONSET/$name" >/dev/null
done
ICNS_PATH="$ICNS_WORKDIR/AppIcon.icns"
iconutil -c icns "$ICONSET" -o "$ICNS_PATH"

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

  APP_NAME="SORAI Toolkit.app"
  STAGE_DIR="$(mktemp -d)"
  APP_DIR="$STAGE_DIR/$APP_NAME"
  mkdir -p "$APP_DIR/Contents/MacOS/binaries/mac_${ARCH}" "$APP_DIR/Contents/Resources"

  sed "s/__VERSION__/${VERSION}/g" "$PKG_DIR/Info.plist" > "$APP_DIR/Contents/Info.plist"
  cp "$ICNS_PATH" "$APP_DIR/Contents/Resources/AppIcon.icns"
  install -m 755 "$EXE" "$APP_DIR/Contents/MacOS/sorai-toolkit"
  install -m 755 "$FFMPEG_BIN" "$APP_DIR/Contents/MacOS/binaries/mac_${ARCH}/ffmpeg"

  # Drag-to-Applications layout: the .app plus a symlink to /Applications,
  # both inside the volume hdiutil packages into the .dmg.
  ln -s /Applications "$STAGE_DIR/Applications"

  DMG_PATH="$OUT_DIR/sorai-toolkit-${VERSION}-mac_${ARCH}.dmg"
  hdiutil create -volname "SORAI Toolkit" -srcfolder "$STAGE_DIR" -ov -format UDZO "$DMG_PATH"
  rm -rf "$STAGE_DIR"
  echo "Built $DMG_PATH"
done

rm -rf "$ICNS_WORKDIR"
