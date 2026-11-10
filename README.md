# downco-co

The Converter in [downco](https://github.com/chchee3300/downco), a desktop app that downloads and converts media on your own computer. To use the Converter, [install downco](https://github.com/chchee3300/downco#install). This repository holds its source and isn't an app by itself.

## What it converts

| Input | Output |
|---|---|
| Video | MP4, MKV, WebM, AVI, MOV, M4V, TS, WMV, MPG, GIF, APNG, a single frame as PNG, or only the sound as M4A or MP3 |
| Audio | MP3, WAV, AAC, M4A (AAC or ALAC), FLAC, OGG, Opus, AIFF, WMA, AC3 |
| Image | JPG, PNG, WebP, AVIF, ICO, PDF |
| PDF | Compress, linearize, extract pages, split into single pages, rotate, add a password |
| Document (`.docx`, `.doc`, `.odt`, `.rtf`) | PDF, DOCX, ODT, RTF, HTML, Markdown, plain text |

Other features:

- Trim and crop with a preview, change speed, choose the codec, quality and frame rate, or aim for a target file size.
- "Keep original encoding" copies the streams without re-encoding when the new container can hold them.
- Merge several videos, audio files or PDFs into one file, in the order of the queue.
- Preview a PDF before converting it.
- See an estimate of the output size before converting, and a thumbnail, resolution, length and codec for each file.
- Never overwrite earlier output: the result is saved as `name_converted.ext`, then `name_converted_converted.ext`, and so on.

## Engines

ffmpeg does the video, audio and image work. qpdf handles most PDF operations and img2pdf turns images into PDFs. PDF compression uses a built-in compressor written in Rust. If Ghostscript is installed, the Converter also runs it and keeps the smaller file. Document conversion needs [WordCraft](https://github.com/storytold/wordcraft), and [oxipng](https://github.com/shssoichiro/oxipng) shrinks PNG output when it's installed.

downco bundles ffmpeg on every system, plus qpdf and img2pdf on Windows (macOS and Linux use the system packages). Ghostscript, WordCraft and oxipng are optional downloads in downco's Settings → Third-party software. That download code also lives in this repository (`plugin/src/engines.rs`, `plugin/src/tools.rs`).

## How it's built

The repository is a [Tauri v2](https://tauri.app/) plugin in two parts, installed together as one npm package (`sorai-toolkit-converter`):

- `plugin/` is the Rust crate `tauri-plugin-sorai-converter`. It builds the command lines, reads source information and progress, estimates sizes, runs and cancels jobs, compresses PDFs, and manages the optional engines.
- `src/` is the React UI. Its library build (`vite.lib.config.mjs`) writes `dist/index.js`, which exports `ConverterApp` and the plugin's command wrappers. npm runs the build through the `prepare` script when downco installs the package. React and `@tauri-apps/api` are peer dependencies, and the stylesheet lives in downco's `resources/styles.css`.

The UI only works inside downco's Tauri runtime. To work on it, check this repository out next to downco as `sorai-toolkit-converter` and run `npm run tauri:dev` in downco. Changes to `src/` reload in place, and changes to `plugin/` rebuild and restart the app.

## Tests

```bash
cd plugin && cargo test
```

These cover command building, output parsing, estimates, PDF compression, the engine and tool downloads, and the preview file server. End-to-end tests with real conversions run in downco: `npm run test:e2e -- converter`.

## Versions

This repository has no releases of its own. downco pins a commit of it in `package-lock.json` and ships it as part of each downco release, so commit messages here don't need Conventional Commits prefixes.

## License

[MIT](LICENSE). The programs the Converter runs keep their own licenses: see downco's [`THIRD-PARTY-LICENSES.md`](https://github.com/chchee3300/downco/blob/master/THIRD-PARTY-LICENSES.md).
