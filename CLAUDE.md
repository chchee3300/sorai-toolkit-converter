# Claude 自動化測試指引 (sorai-toolkit-converter)

這是 SORAI Toolkit 的 **Converter 子 repo**——被 `sorai-toolkit` 主 repo 當成 npm git dependency 消費（`vite.lib.config.mjs` 產生 `dist/index.js`，`src/index.js` barrel export `{ ConverterApp }`，`prepare` script 在 `npm install` 時自動建置）。這裡的 `neutralino.config.json`/`vite.config.mjs`/`web-dist/` 只是**獨立開發測試用的殼層**，不是實際出貨的東西——真正的安裝檔/CI/release 全部在 `sorai-toolkit` repo（完整多 repo 重構計畫見 `~/.claude/plans/mac-linux-reactive-metcalfe.md`）。

## 核心規則：修改核心邏輯後強制全類別回歸測試
修改轉檔相關程式碼後，必須確認以下 4 大類別都沒有被破壞：

1. **Video**：格式切換 (MP4/WebM/GIF)、編碼器自動隱藏、FPS 計算、畫質壓縮、變速。
2. **Image**：格式切換 (JPG/PNG/WebP/AVIF)、Quality（注意 PNG `palettegen` 是否正確觸發）、Scale 計算。
3. **Audio**：格式切換 (MP3/WAV/AAC/FLAC/OGG)、Bitrate、變速 (`atempo`)。
4. **PDF**：Compress/Linearize 模式與 `qpdf` 指令。
5. **共用功能**：即時預估算法、進度條解析、檔名防覆蓋機制 (`_converted_converted`)。

執行 `node tests/test_conversion.js`、`test_drop.js`、`test_crop_ui.js`、`test_image_crop_commands.js` 四個完整套件（不是只挑幾個 case）——這幾個套件曾經因為「看似無關的修改」意外出現過真實 regression，回覆使用者時也要附上這份 checklist。改完這裡的邏輯後，`sorai-toolkit` hub repo 那邊要重新 `npm install` 才會抓到新版（它吃的是 `dist/`，不是原始碼）。

## Commit 規範
這個 repo **沒有自己的 semantic-release/CHANGELOG/GitHub Release**——版本號、打包、發版全部由 `sorai-toolkit` 主 repo 負責（它透過 git dependency 抓這裡的某個 commit/ref）。不需要 Conventional Commits 前綴，plain commit message 即可。

## UI 視覺風格
新增/修改 UI 前先看 `design-system/UI_STYLE_REFERENCE.md`（已對照 `resources/styles.css` 現況標註哪些原則已符合、哪些落差不必回頭改）。不要憑感覺發明新圓角值，也不要替非玻璃元件加陰影。

## 獨立開發殼層（`neu run`/`vite dev`）的注意事項
以下只影響**這個 repo 自己的獨立測試殼層**，不影響套件輸出（`dist/index.js`）本身：

- **`src/main.jsx`** 自己包了一層 `.app-shell` div——因為 `App.jsx`（套件匯出的內容）不再自帶這層包裝，那是 hub 組合時的責任。改動 `App.jsx` 的最外層結構時留意這點。
- **`tests/test_drop.js` 的「Test B」** 需要手動把 `window.NL_MODE` 設回 `'browser'` 才測得到——因為 hub（真正的組合環境）的 `defaultMode` 是 `"window"`，這時 `useFileManager.js` 的 `onDrop`（瀏覽器模式 DOM drop fallback）會直接 return。這個 repo 自己的獨立殼層 `neutralino.config.json` 沒有改這個值，但測試邏輯是共用的，改 drop 邏輯時留意。
- **`resources/js/lib/platform.js` 等 `window.EstellaLib.*` 全域**——這裡的複製只是給獨立殼層用；套件真正被 hub 消費時，這些全域是 hub 自己提供的（見 hub 的 `CLAUDE.md`）。不要把套件程式碼寫成依賴這裡本地複製的特定版本。

Neutralino 打包/CI 相關的完整踩坑清單（`resourcesPath`/`documentRoot`、`defaultMode`、`enableInspector`、`windowClose`、CORS+curl 更新下載、installer.iss `skipifsilent`、Linux gtk3/webkit2gtk 依賴、`@neutralinojs/neu` 版本鎖定等）都在 **`sorai-toolkit` hub repo 的 `CLAUDE.md`**——那些現在都是 hub 層級的關注點，這裡不重複維護。
