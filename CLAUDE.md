# Claude 自動化測試指引 (FileConverterApp)

## 核心規則：修改核心邏輯後強制全類別回歸測試
修改轉檔相關程式碼後，必須確認以下 4 大類別都沒有被破壞：

1. **Video**：格式切換 (MP4/WebM/GIF)、編碼器自動隱藏、FPS 計算、畫質壓縮、變速。
2. **Image**：格式切換 (JPG/PNG/WebP/AVIF)、Quality（注意 PNG `palettegen` 是否正確觸發）、Scale 計算。
3. **Audio**：格式切換 (MP3/WAV/AAC/FLAC/OGG)、Bitrate、變速 (`atempo`)。
4. **PDF**：Compress/Linearize 模式與 `qpdf` 指令。
5. **共用功能**：即時預估算法、進度條解析、檔名防覆蓋機制 (`_converted_converted`)。

執行 `node tests/test_conversion.js`、`test_drop.js`、`test_crop_ui.js` 三個完整套件（不是只挑幾個 case）—— 這次 session 有兩次「看似無關的修改」（`defaultMode` 切換、update-toast 新增）意外讓其他套件出現真實 regression，回覆使用者時也要附上這份 checklist。

## Commit 規範：一定要用 Conventional Commits
版本號/CHANGELOG/GitHub Release 全靠 `semantic-release`（`.releaserc.json` + `.github/workflows/release.yml`）自動判斷，**完全依賴 commit 訊息格式**：
- `fix:` → patch，`feat:` → minor，`feat!:`/body 含 `BREAKING CHANGE:` → major
- `chore:`/`docs:`/`refactor:`/`test:`/`style:` 或沒有前綴 → 不觸發發版（安全但代表這次修改不會被計入版本）

## UI 視覺風格
新增/修改 UI 前先看 `design-system/UI_STYLE_REFERENCE.md`（已對照 `resources/styles.css` 現況標註哪些原則已符合、哪些落差不必回頭改）。不要憑感覺發明新圓角值，也不要替非玻璃元件加陰影。

## Neutralino / 打包 / CI 常見誤區
以下都是**在 `neu run` 開發模式測不出來、只有真正打包執行才會炸的坑**：

- **`neutralino.config.json` 的 `cli.resourcesPath` 必須等於 `documentRoot`**（現在都是 `/web-dist/`）。`neu build` 只打包 `resourcesPath` 指到的資料夾，但真正 serve 內容的是 `documentRoot`——不一致會讓每個打包版本開啟後都是 404。改動後必須真的 `neu build --release` 執行、curl 內部 server 確認 200，不能只跑 `neu run`。
- **`defaultMode` 必須是 `"window"`**，不是 Neutralino 樣板預設的 `"browser"`，否則開啟安裝好的 App 會跳系統瀏覽器而不是原生視窗。
- **`modes.window.enableInspector` 必須是 `false`**（正式版不該讓使用者開得了 DevTools；不影響 Playwright，那是走獨立 Chromium 連 localhost）。
- **`main.jsx` 必須監聽 `windowClose` 並呼叫 `Neutralino.app.exit()`**。`exitProcessOnClose: false` 讓 Neutralino 攔截視窗關閉鈕、改觸發 `windowClose` 事件——沒監聽的話點 X 完全沒反應、process 留在背景。（此問題整個 session 沒被發現，因為開發測試都用 `taskkill` 強制關閉，從沒測過真的點 X。）
- **`useUpdateChecker.js` 下載 release asset 不能用瀏覽器 `fetch()`**——`api.github.com` 有開 CORS，但 asset 實際下載會 redirect 到 GitHub CDN，那邊沒有 `Access-Control-Allow-Origin`，`fetch()` 會被擋掉（點 Update now 沒反應）。改用 `Neutralino.os.execCommand` 呼叫 `curl`。副作用：拿不到即時下載百分比，UI 用不確定進度條（`.progress-bar--indeterminate`），不是 bug。
- **`installer.iss` 的 `[Run]` postinstall 項目不能有 `skipifsilent`**。應用內更新是用 `/VERYSILENT` 跑安裝檔，`skipifsilent` 會讓這個「安裝完自動開啟」的項目完全不執行——實測過：拿掉 `skipifsilent` 前，`/CLOSEAPPLICATIONS` 有正確關掉舊的 process，但裝完後**完全沒有自動重開**；拿掉之後才會自動重開（用真的裝著、真的在跑的 app 測試 `/CLOSEAPPLICATIONS /RESTARTAPPLICATIONS` 兩個旗標確認過）。命令列的 `/RESTARTAPPLICATIONS` 旗標本身沒有實際作用，重開是靠這個 `[Run]` 項目。
- **全新 checkout 後必須跑 `node scripts/copy-neutralino-client.mjs`**（`npm run setup`/CI 已接好）。`neu update` 把 client library 寫到 `web-dist/js/neutralino.js`，但 `vite.config.mjs` 的複製 plugin 是從 `resources/js/neutralino.js`（gitignored）讀取——兩個路徑不同，且 vite build 會清空 `web-dist/`，不跑這步 `npm run build` 會直接失敗。
- **`.update-toast` 的 z-index 必須小於 `.modal-overlay`**（100；目前 90）。曾設成 200 導致更新通知蓋住 Trim/Crop/MixedType modal 並吃掉點擊——開著的 modal 應該蓋住 toast，不是反過來。
- **`defaultMode` 換成 `"window"` 後**，`useFileManager.js` 的 `onDrop`（瀏覽器模式 DOM drop fallback）在 `NL_MODE === 'window'` 時會直接 return（原生拖放走 `filesDropped`）。`tests/test_drop.js` 的「Test B」因此需要手動把 `window.NL_MODE` 設回 `'browser'` 才測得到——修改 drop 邏輯時留意這個測試的特殊處理。
- **`src/version.json`** 是 `StatusBar.jsx`（畫面版本號）與 `useUpdateChecker.js` 的版本來源。CI 的 `release` job 會在跑 `semantic-release` 前呼叫 `write-version.mjs`，讓 `@semantic-release/git` 把正確版本一起 commit 回 `chore(release): X.Y.Z`——這步不能拿掉，否則版本號會卡死。本地開發勿手動改值。
- **`useUpdateChecker.js` 的 `currentAssetPattern`/`pickAsset`** 要跟 `.releaserc.json` 的 assets 檔名規則同步，改一邊沒改另一邊，應用內更新會抓不到安裝檔。
- **`@neutralinojs/neu` 鎖死在 `11.7.1`**（`package.json` setup script + 3 個 release build job）。`latest`（11.7.2）的 `uuid` 依賴會解析到 ESM-only 版本，但它自己用 CommonJS `require`，全新安裝直接 `ERR_REQUIRE_ESM` 崩潰。不要升級，除非確認上游修好。
- **Linux `.deb`/`.rpm`（`packaging/linux/build.sh`）宣告 `gtk3`/`webkit2gtk` 依賴**（deb: `libgtk-3-0`/`libwebkit2gtk-4.1-0`；rpm: `gtk3`/`webkit2gtk4.1`）——Neutralino 開視窗需要，`ldd` 只看得到 gtk3（webkit2gtk 是動態載入）。別拿掉。
- **`playwright` 必須是 `devDependencies`**，且 CI 全域設 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'`——沒有的話每個 job 的 `npm ci` 都會下載瀏覽器（數百 MB），曾在 macOS runner 上因此炸硬碟（`hdiutil: No space left on device`）。
- **解壓縮 zip 不能假設裸指令 `tar` 支援**（踩過兩次：Git Bash 的 `/usr/bin/tar` 蓋過真正支援 zip 的 `System32\tar.exe`；Ubuntu CI runner 的預設 tar 也不支援 zip）。Windows 用完整路徑 `System32\tar.exe`，macOS/Linux 一律用 `unzip`。
- **修改 `binaries/` 佈局、`neu build` 輸出結構、或 `NL_PATH` 路徑解析邏輯時**，同步檢查 `packaging/{linux,windows,macos}/` 建置腳本與 `platform.js` 的 `ffmpegPath`/`qpdfCommand` 是否還一致。
