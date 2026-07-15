#!/bin/bash
# Builds sorai-toolkit .deb and .rpm packages for linux_x64 using fpm.
# Run from the repo root: packaging/linux/build.sh <version>
#
# Expects (already built by the caller):
#   dist/FileConverterApp/FileConverterApp-linux_x64  (neu build --release --embed-resources)
#   binaries/linux_x64/ffmpeg                          (node setup.mjs)
#
# Requires: fpm (gem install fpm), and rpmbuild/dpkg-deb on PATH.
set -euo pipefail

VERSION="${1:?Usage: build.sh <version>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG_DIR="$REPO_ROOT/packaging/linux"
STAGE_DIR="$(mktemp -d)"
OUT_DIR="$REPO_ROOT/release-assets"

APP_EXE="$REPO_ROOT/dist/FileConverterApp/FileConverterApp-linux_x64"
FFMPEG_BIN="$REPO_ROOT/binaries/linux_x64/ffmpeg"

if [ ! -f "$APP_EXE" ]; then
  echo "Missing $APP_EXE -- run 'neu build --release --embed-resources' first" >&2
  exit 1
fi
if [ ! -f "$FFMPEG_BIN" ]; then
  echo "Missing $FFMPEG_BIN -- run 'node setup.mjs' first" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# ---- Stage the installed filesystem layout ----
mkdir -p "$STAGE_DIR/opt/sorai-toolkit/binaries/linux_x64"
mkdir -p "$STAGE_DIR/usr/bin"
mkdir -p "$STAGE_DIR/usr/share/applications"
mkdir -p "$STAGE_DIR/usr/share/pixmaps"

install -m 755 "$APP_EXE" "$STAGE_DIR/opt/sorai-toolkit/sorai-toolkit"
install -m 755 "$FFMPEG_BIN" "$STAGE_DIR/opt/sorai-toolkit/binaries/linux_x64/ffmpeg"
install -m 755 "$PKG_DIR/launcher.sh" "$STAGE_DIR/usr/bin/sorai-toolkit"
install -m 644 "$PKG_DIR/sorai-toolkit.desktop" "$STAGE_DIR/usr/share/applications/sorai-toolkit.desktop"
install -m 644 "$REPO_ROOT/resources/icons/appIcon.png" "$STAGE_DIR/usr/share/pixmaps/sorai-toolkit.png"

COMMON_ARGS=(
  -s dir
  -n sorai-toolkit
  -v "$VERSION"
  --description "Convert video, image, audio, and PDF files locally — no upload, no cloud processing."
  --url "https://github.com/chchee3300/FileConverterApp"
  --license MIT
  --maintainer "SORAI Toolkit"
  --vendor "SORAI Toolkit"
  --category utils
  -C "$STAGE_DIR"
)

echo "Building .deb..."
# libgtk-3-0/libwebkit2gtk-4.1-0: Neutralino's Linux binary renders its
# window via GTK+WebKitGTK (confirmed via ldd -- libgtk-3.so.0 is a direct
# dependency; webkit2gtk is loaded through GTK's widget factory, invisible
# to ldd but still required at runtime, verified by launching in a bare
# container that lacked it). Neither is guaranteed present outside a full
# desktop install, so declare them rather than let the app silently fail
# to open a window post-install.
fpm "${COMMON_ARGS[@]}" \
  -t deb \
  --architecture amd64 \
  --depends qpdf \
  --depends libgtk-3-0 \
  --depends libwebkit2gtk-4.1-0 \
  -p "$OUT_DIR/sorai-toolkit_${VERSION}_amd64.deb" \
  opt usr

echo "Building .rpm..."
fpm "${COMMON_ARGS[@]}" \
  -t rpm \
  --architecture x86_64 \
  --depends qpdf \
  --depends gtk3 \
  --depends webkit2gtk4.1 \
  -p "$OUT_DIR/sorai-toolkit-${VERSION}.x86_64.rpm" \
  opt usr

rm -rf "$STAGE_DIR"
echo "Done. Packages in $OUT_DIR:"
ls -la "$OUT_DIR"
