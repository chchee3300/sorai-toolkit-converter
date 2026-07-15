# FileConverterApp

A desktop file converter for video, image, audio, and PDF files, built with [Neutralino.js](https://neutralino.js.org/) and React. Drag files in, tweak per-format settings, and convert locally — no upload, no cloud processing.

## Features

- **Video** — convert between MP4 / MKV / WebM / AVI / GIF, with codec selection, quality control, FPS adjustment, upscaling, trimming, and speed change.
- **Image** — convert between JPG / PNG / WebP / AVIF / ICO / PDF, with quality and resolution scaling (PNG uses a two-pass `palettegen`/`paletteuse` pipeline for better color quality).
- **Audio** — convert between MP3 / WAV / AAC / FLAC / OGG, with bitrate control, trimming, and speed change (`atempo`).
- **PDF** — optimize with linearize or compress modes.
- Live file-size estimation before you convert, batch conversion with a progress log, and automatic filename collision avoidance (`_converted`, `_converted_converted`, …) so re-running a conversion never overwrites the previous output.

## How it works

The UI (React + Vite, in `src/`) runs inside a [Neutralino.js](https://neutralino.js.org/) shell, which gives it native filesystem access and the ability to spawn local command-line tools. Conversions are performed by:

- [`ffmpeg`](https://ffmpeg.org/) — video, image, and audio conversion. Bundled on every platform, no separate install needed.
- [`qpdf`](https://qpdf.readthedocs.io/) — PDF optimization. Bundled on Windows; on macOS/Linux it's a system-installed dependency (`brew`/`apt`/etc.).
- [`img2pdf`](https://gitlab.mister-muffin.de/josch/img2pdf) — image-to-PDF conversion. Bundled on Windows; on macOS/Linux it's a system-installed dependency (`pip`).

These live in per-platform folders under `binaries/` (`win_x64/`, `mac_x64/`, `mac_arm64/`, `linux_x64/`), fetched by `setup.mjs` (see [Setup](#setup)).

## Requirements

- [Node.js](https://nodejs.org/) (for the Vite build and `setup.mjs`)
- The [Neutralino CLI](https://neutralino.js.org/docs/cli/neu-cli): `npm install -g @neutralinojs/neu`
- Windows, macOS, or Linux
- **macOS/Linux only**: `qpdf` and `img2pdf` must be installed system-wide for PDF features (`brew install qpdf` / `sudo apt install qpdf`, and `pip install img2pdf`) — ffmpeg is bundled on every platform, so video/image/audio conversion needs no extra install.

## Setup

```bash
npm install
node setup.mjs      # downloads ffmpeg (all platforms) into binaries/, plus qpdf/img2pdf on Windows;
                     # on macOS/Linux it checks for system qpdf/img2pdf and prints install hints if missing
```

## Development

```bash
npm run dev         # start the Vite dev server (UI only, in a browser)
neu run             # build the web UI and launch the Neutralino desktop shell
```

`neu run` serves the app from `web-dist/`, which is built from `src/` via Vite (`vite.config.mjs` also copies the Neutralino client library into place). Rebuild the UI with:

```bash
npm run build
```

## Project structure

```
src/                 React UI (components, hooks, settings state)
resources/           Static assets served by Neutralino (icons, styles, neutralino.js client, platform/command-builder libs)
binaries/            Bundled conversion binaries, per platform (fetched by setup.mjs):
                       win_x64/    ffmpeg.exe, qpdf.exe, img2pdf.exe + runtime DLLs
                       mac_x64/    ffmpeg
                       mac_arm64/  ffmpeg
                       linux_x64/  ffmpeg
bin/                 Neutralino runtime binaries (per-platform)
tests/               Regression/E2E test scripts and their fixture files (tests/fixtures/)
neutralino.config.json   Neutralino app configuration (window size, allowed native APIs, etc.)
setup.mjs            Downloads the third-party conversion binaries (cross-platform)
```

## Testing

```bash
node tests/test_conversion.js   # golden-master regression suite (all 4 conversion categories)
node tests/test_drop.js         # file drag-and-drop behavior
```

Both drive the real app end-to-end via Playwright and a `neu run` instance, so they must be run from the project root (they resolve `binaries/`, `.tmp/`, and `neutralino.config.json` relative to it). Fixtures live in `tests/fixtures/`.

## Releases

Versioning and GitHub Releases are automated with [semantic-release](https://semantic-release.gitbook.io/), driven by [Conventional Commits](https://www.conventionalcommits.org/) on `master`:

- `fix: ...` → patch release
- `feat: ...` → minor release
- `feat: ...` + a `BREAKING CHANGE:` footer (or `!` after the type, e.g. `feat!: ...`) → major release
- Other prefixes (`chore:`, `docs:`, `refactor:`, `test:`, etc.) don't trigger a release

Every push to `master` runs `.github/workflows/release.yml`, which:
1. Computes whether a release is warranted and, if so, the next version (`scripts/get-next-version.mjs`, semantic-release in dry-run).
2. Builds and packages all platforms in parallel: `.deb`/`.rpm` (Linux, via [fpm](https://fpm.readthedocs.io/)), `.zip` (Windows), and `.zip` ×2 for macOS (Intel + Apple Silicon).
3. Publishes the GitHub Release with those packages attached, and updates `CHANGELOG.md`.

No manual version bumping or tagging — the version number lives entirely in git tags/GitHub Releases, driven by commit messages.

To build a Linux package locally without CI: `neu build --release --embed-resources`, then `bash packaging/linux/build.sh <version>` (needs [fpm](https://fpm.readthedocs.io/en/latest/installing.html) and `rpmbuild` installed). Windows/macOS have equivalent `packaging/windows/build.ps1` / `packaging/macos/build.sh` scripts.

## License

[MIT](LICENSE)
