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

This repo is a [Tauri v2](https://tauri.app/) plugin in two halves, shipped together in one npm git dependency:

- **Rust crate** (`plugin/`, `tauri-plugin-sorai-converter`) — builds the ffmpeg/qpdf/img2pdf arguments, parses progress and source info, estimates output sizes, avoids filename collisions, and runs/cancels the conversion processes.
- **React UI** (`src/`, library build `vite.lib.config.mjs` → `dist/index.js`) — exports `{ ConverterApp }` plus the plugin's `invoke` wrappers (`src/plugin.js`). React and `@tauri-apps/api` are peer dependencies; no CSS is bundled (the hub loads the shared stylesheet). `dist/` is built by the `prepare` script whenever this repo is installed as a git dependency.

The host app (the hub) registers the plugin, grants `sorai-converter:default`, and provides:

- sidecars named [`ffmpeg`](https://ffmpeg.org/), [`qpdf`](https://qpdf.readthedocs.io/) and [`img2pdf`](https://gitlab.mister-muffin.de/josch/img2pdf) in its resource dir or next to its exe (otherwise they're run from `PATH` — on macOS/Linux qpdf/img2pdf are system installs: `brew`/`apt`/`pip`), and `tauri-plugin-shell` registered;
- `app.security.assetProtocol` enabled with `$TEMP/sorai-toolkit/thumbnails/*` in scope;
- the UI runtime globals `window.LiquidSelect`, `window.EstellaLib.{i18n,rangeFill}` and `window.SoraiDialogs`.

There is no standalone app in this repo — the UI needs the hub's Tauri runtime. Develop it through the hub's `npm run tauri:dev`, which picks up a sibling checkout of this repo (`src/` hot-reloads, `plugin/` edits rebuild the app).

## Testing

```bash
cd plugin && cargo test          # command building, parsing, estimates, sidecar lookup
```

End-to-end conversions run from the hub: `npm run test:e2e -- converter` there.

## Versioning

This repo has no independent release pipeline — no semantic-release, no CHANGELOG, no GitHub Releases. Versioning and packaging both live in the [`sorai-toolkit`](https://github.com/chchee3300/sorai-toolkit) hub repo, which consumes this repo via a git ref. Commit messages here don't need Conventional Commits prefixes.

## License

[MIT](LICENSE) for this repo's own code. Bundled/invoked third-party tools (ffmpeg, qpdf, img2pdf) keep their own licenses — see the hub repo's [`THIRD-PARTY-LICENSES.md`](https://github.com/chchee3300/sorai-toolkit/blob/master/THIRD-PARTY-LICENSES.md) for details, since the hub is what actually bundles and ships them.
