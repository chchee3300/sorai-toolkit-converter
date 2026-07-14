# FileConverterApp

A desktop file converter for video, image, audio, and PDF files, built with [Neutralino.js](https://neutralino.js.org/) and React. Drag files in, tweak per-format settings, and convert locally — no upload, no cloud processing.

## Features

- **Video** — convert between MP4 / MKV / WebM / AVI / GIF, with codec selection, quality control, FPS adjustment, upscaling, trimming, and speed change.
- **Image** — convert between JPG / PNG / WebP / AVIF / ICO / PDF, with quality and resolution scaling (PNG uses a two-pass `palettegen`/`paletteuse` pipeline for better color quality).
- **Audio** — convert between MP3 / WAV / AAC / FLAC / OGG, with bitrate control, trimming, and speed change (`atempo`).
- **PDF** — optimize with linearize or compress modes.
- Live file-size estimation before you convert, batch conversion with a progress log, and automatic filename collision avoidance (`_converted`, `_converted_converted`, …) so re-running a conversion never overwrites the previous output.

## How it works

The UI (React + Vite, in `src/`) runs inside a [Neutralino.js](https://neutralino.js.org/) shell, which gives it native filesystem access and the ability to spawn local command-line tools. Conversions are performed by bundled binaries — no ffmpeg/qpdf install or internet connection required at runtime:

- [`ffmpeg`](https://ffmpeg.org/) — video, image, and audio conversion
- [`qpdf`](https://qpdf.readthedocs.io/) — PDF optimization
- [`img2pdf`](https://gitlab.mister-muffin.de/josch/img2pdf) — image-to-PDF conversion

These live in `binaries/` and are fetched by `setup.ps1` (see [Setup](#setup)).

## Requirements

- [Node.js](https://nodejs.org/) (for the Vite build)
- The [Neutralino CLI](https://neutralino.js.org/docs/cli/neu-cli): `npm install -g @neutralinojs/neu`
- Windows (the bundled binaries and `setup.ps1` currently target `win64`)

## Setup

```powershell
npm install
./setup.ps1        # downloads ffmpeg, qpdf, and img2pdf into binaries/
```

## Development

```powershell
npm run dev         # start the Vite dev server (UI only, in a browser)
neu run             # build the web UI and launch the Neutralino desktop shell
```

`neu run` serves the app from `web-dist/`, which is built from `src/` via Vite (`vite.config.mjs` also copies the Neutralino client library into place). Rebuild the UI with:

```powershell
npm run build
```

## Project structure

```
src/                 React UI (components, hooks, settings state)
resources/           Static assets served by Neutralino (icons, styles, neutralino.js client)
binaries/            Bundled ffmpeg / qpdf / img2pdf executables (fetched by setup.ps1)
bin/                 Neutralino runtime binaries (per-platform)
tests/               Regression/E2E test scripts and their fixture files (tests/fixtures/)
neutralino.config.json   Neutralino app configuration (window size, allowed native APIs, etc.)
setup.ps1            Downloads the third-party conversion binaries
```

## Testing

```powershell
node tests/test_conversion.js   # golden-master regression suite (all 4 conversion categories)
node tests/test_drop.js         # file drag-and-drop behavior
```

Both drive the real app end-to-end via Playwright and a `neu run` instance, so they must be run from the project root (they resolve `binaries/`, `.tmp/`, and `neutralino.config.json` relative to it). Fixtures live in `tests/fixtures/`.

## License

[MIT](LICENSE)
