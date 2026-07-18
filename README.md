# sorai-toolkit-converter

The **Converter tool** for [SORAI Toolkit](https://github.com/chchee3300/sorai-toolkit) — convert video, image, audio, and PDF files locally, no upload, no cloud processing. This repo is consumed by the [`sorai-toolkit`](https://github.com/chchee3300/sorai-toolkit) hub repo as an npm git dependency; it is **not** independently installable or shippable — the hub is the actual installable app.

## Features

- **Video** — convert between MP4 / MKV / WebM / AVI / GIF, with codec selection, quality control, FPS adjustment, upscaling, trimming, and speed change.
- **Image** — convert between JPG / PNG / WebP / AVIF / ICO / PDF, with quality and resolution scaling (PNG uses a two-pass `palettegen`/`paletteuse` pipeline for better color quality).
- **Audio** — convert between MP3 / WAV / AAC / FLAC / OGG, with bitrate control, trimming, and speed change (`atempo`).
- **PDF** — optimize with linearize or compress modes.
- Live file-size estimation before you convert, batch conversion with a progress log, and automatic filename collision avoidance (`_converted`, `_converted_converted`, …) so re-running a conversion never overwrites the previous output.
- Each file in the list gets a thumbnail preview (video: a mid-point frame; image: the image itself; audio: its embedded cover art, when present) plus its source resolution/duration and codec, so a batch is recognizable at a glance instead of just a row of filenames.

## How it works

The UI (React + Vite, in `src/`) runs inside a [Neutralino.js](https://neutralino.js.org/) shell, which gives it native filesystem access and the ability to spawn local command-line tools. Conversions are performed by:

- [`ffmpeg`](https://ffmpeg.org/) — video, image, and audio conversion.
- [`qpdf`](https://qpdf.readthedocs.io/) — PDF optimization. Bundled on Windows; on macOS/Linux it's a system-installed dependency (`brew`/`apt`/etc.).
- [`img2pdf`](https://gitlab.mister-muffin.de/josch/img2pdf) — image-to-PDF conversion. Bundled on Windows; on macOS/Linux it's a system-installed dependency (`pip`).

When composed into the hub, the hub itself provides these binaries and the runtime globals that call into them (`window.EstellaLib.*`, see `resources/js/lib/`) — this repo's own copy of that infrastructure only exists for its **standalone dev harness** (see below), and is not part of what ships to the hub.

## This repo's two build outputs

- **Library build** (`vite.lib.config.mjs` → `dist/index.js`) — a plain ESM bundle exporting `{ ConverterApp }` (`src/index.js`), with React as a peer dependency and no bundled CSS (the hub already loads the shared stylesheet itself). This is what the hub actually consumes; it's built automatically by the `prepare` npm lifecycle script whenever this repo is installed as a git dependency — the hub never needs a manual build step for it.
- **Standalone dev harness** (`vite.config.mjs` → `web-dist/`) — a self-contained build of this repo alone (own `neutralino.config.json`, own copies of the shared runtime globals), for developing/testing Converter in isolation without needing the hub at all. See [Development](#development) below.

## Requirements

Building from source needs:

- [Node.js](https://nodejs.org/) (for the Vite build and `setup.mjs`)
- The [Neutralino CLI](https://neutralino.js.org/docs/cli/neu-cli) — installed automatically by `npm run setup` (only needed for the standalone dev harness)
- Windows, macOS, or Linux
- **macOS/Linux only**: `qpdf` and `img2pdf` must be installed system-wide for PDF features (`brew install qpdf` / `sudo apt install qpdf`, and `pip install img2pdf`) — ffmpeg is bundled on every platform.

## Setup

```bash
npm install
npm run setup
```

`npm run setup` chains everything a fresh clone needs for the standalone dev harness:

```bash
npm install -g @neutralinojs/neu@11.7.1   # pinned -- see note below
neu update                                 # fetches the Neutralino client lib + runtime binaries (bin/, gitignored)
node scripts/copy-neutralino-client.mjs    # neu update writes the client lib to web-dist/js/ (per
                                            # neutralino.config.json's clientLibrary); vite.config.mjs
                                            # re-copies it from resources/js/ (its source of truth, also
                                            # gitignored) on every build, so this needs doing once
node setup.mjs                             # downloads ffmpeg (all platforms) into binaries/, plus qpdf/img2pdf
                                            # on Windows; on macOS/Linux it checks for system qpdf/img2pdf
                                            # and prints install hints if missing
```

The `@neutralinojs/neu` version is pinned rather than left at `latest`: as of this writing, the latest published version (`11.7.2`) declares a `uuid` dependency range that resolves to an ESM-only release, which crashes its own (CommonJS) code with `ERR_REQUIRE_ESM` on install. `11.7.1` is the last version that doesn't have this problem — worth re-checking occasionally in case upstream fixes it.

## Development

```bash
npm run dev         # start the Vite dev server (UI only, in a browser)
neu run             # build the web UI and launch the Neutralino desktop shell, standalone
```

`neu run` serves this repo's own standalone dev harness from `web-dist/`. Rebuild it with:

```bash
npm run build
```

To build the library output the hub actually consumes:

```bash
npm run build:lib   # -> dist/index.js (also runs automatically via "prepare" when this repo
                     #    is installed as a git dependency elsewhere)
```

## Project structure

```
src/                 React UI (components, hooks, settings state)
src/index.js          Library entry point — exports { ConverterApp } for the hub to consume
src/main.jsx          Standalone dev-harness entry point (wraps ConverterApp in its own .app-shell)
resources/           Static assets for the standalone dev harness (icons, styles, neutralino.js client,
                      platform/command-builder libs) — mirrors what the hub provides when composed
binaries/            Bundled conversion binaries for the standalone dev harness, per platform (fetched by setup.mjs)
bin/                 Neutralino runtime binaries for the standalone dev harness (per-platform)
tests/               Regression/E2E test scripts and their fixture files (tests/fixtures/)
scripts/             Dev-harness setup helper (neutralino.js client copy)
neutralino.config.json   Standalone dev harness's own Neutralino config (not used by the hub)
vite.config.mjs      Standalone dev harness build config
vite.lib.config.mjs  Library build config (what the hub actually consumes)
setup.mjs            Downloads third-party conversion binaries for the standalone dev harness
```

## Testing

```bash
node tests/test_conversion.js         # golden-master regression suite (all 4 conversion categories)
node tests/test_drop.js               # file drag-and-drop behavior
node tests/test_crop_ui.js            # image crop UI
node tests/test_image_crop_commands.js
```

All drive the real app end-to-end via Playwright and a `neu run` instance (this repo's standalone dev harness), so they must be run from the project root. Fixtures live in `tests/fixtures/`. The same suites are also run against the real composed hub — see the hub repo's own `tests/`.

## Versioning

This repo has no independent release pipeline — no semantic-release, no CHANGELOG, no GitHub Releases. Versioning and packaging both live in the [`sorai-toolkit`](https://github.com/chchee3300/sorai-toolkit) hub repo, which consumes this repo via a git ref. Commit messages here don't need Conventional Commits prefixes.

## License

[MIT](LICENSE) for this repo's own code. Bundled/invoked third-party tools (ffmpeg, qpdf, img2pdf) keep their own licenses — see the hub repo's [`THIRD-PARTY-LICENSES.md`](https://github.com/chchee3300/sorai-toolkit/blob/master/THIRD-PARTY-LICENSES.md) for details, since the hub is what actually bundles and ships them.
