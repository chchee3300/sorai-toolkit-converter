# Claude 自動化測試指引 (FileConverterApp)

## 核心規則：強制大範圍全類別測試 (Automatic Wide-Range Testing)
在每次修改程式碼（尤其是 `main.js` 或 `index.html` 的核心邏輯）之後，Claude 必須確保「所有檔案類別」的轉換邏輯沒有因為程式碼的變動而被意外破壞（Regression）。

### 必須涵蓋的四個主要類別與核心參數：
1. **Video (影片)**：格式切換 (MP4/WebM/GIF)、編碼器自動隱藏邏輯、FPS 計算、畫質壓縮、影片變速。
2. **Image (圖片)**：格式切換 (JPG/PNG/WebP/AVIF)、Quality 品質控制 (需特別注意 PNG 的 `palettegen` 演算法是否正確觸發)、Scale 解析度縮放計算。
3. **Audio (音訊)**：格式切換 (MP3/WAV/AAC/FLAC/OGG)、Bitrate 控制、音訊變速 (`atempo`)。
4. **PDF (文件)**：最佳化模式 (Compress/Linearize) 與 `qpdf` 指令。
5. **共用功能**：檔案大小的「即時預估算法」、轉檔進度條 (Progress Bar) 解析、以及「重複轉檔時的檔名防覆蓋機制 (`_converted_converted`)」。

### Claude 執行動作：
- **靜態分析**：在完成程式碼修改後，Claude 必須在輸出的思考過程中，主動追蹤上述 4 大類別的 `command` 生成邏輯是否依舊正確。
- **測試清單 (Checklist)**：在回覆使用者時，主動列出上述 4 種格式的測試清單，請使用者確認是否正常運作，或者若情況允許，透過 CLI 輔助驗證底層的 `ffmpeg` 與 `qpdf` 參數是否合法。

## Commit 訊息規範 (Conventional Commits)
本專案的版本號、CHANGELOG、GitHub Release 由 `semantic-release` 自動產生（見 `.releaserc.json` 與 `.github/workflows/release.yml`），**完全依賴 `master` 分支上的 commit 訊息格式**來判斷是否要發版、以及發版的類型。Claude 建立 commit 時必須使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

- `fix: ...` → patch 版號
- `feat: ...` → minor 版號
- `feat!: ...` 或 commit body 含 `BREAKING CHANGE:` → major 版號
- `chore:` / `docs:` / `refactor:` / `test:` / `style:` 等不會觸發發版

沒有這個前綴的 commit（例如單純描述性的訊息）不會被 semantic-release 辨識，不會觸發任何版本異動 —— 這本身是安全的，但代表 Claude 若忘記加前綴，該次修改就不會被計入下一個版本。

## 打包與應用內更新
- `packaging/{linux,windows,macos}/` 是各平台安裝檔的建置腳本（fpm 產生 .deb/.rpm、Inno Setup 產生 Windows 安裝精靈、hdiutil 產生 macOS .dmg）。修改 `binaries/` 的檔案佈局、`neu build` 的輸出結構、或 `NL_PATH` 相關的路徑解析邏輯時，必須同步檢查這些打包腳本是否還正確（尤其是 `platform.js` 的 `ffmpegPath`/`qpdfCommand` 系列函式與 packaging 腳本裡的路徑假設是否一致）。
- `src/version.json` 是 `StatusBar.jsx`（畫面右下角版本號）與 `useUpdateChecker.js` 共用的版本來源。`scripts/write-version.mjs` 在 CI 建置時（每個 build-* job）覆寫它，**`release` job 現在也會在跑 `semantic-release` 之前呼叫一次**，讓 `@semantic-release/git`（`.releaserc.json` 的 `assets` 含 `src/version.json`）把正確版本號一起 commit 回 `chore(release): X.Y.Z` —— 這樣每次真的發版後，repo 裡的 `src/version.json` 才會跟著更新，而不是永遠停在建立當下的佔位符。修改 release pipeline 時，這個「release job 也要 write-version」的步驟不能拿掉，不然畫面上的版本號會一直卡在上一次手動設定的值。本地開發時請勿手動更動其值。
- `src/hooks/useUpdateChecker.js` 會在啟動時打 GitHub API 檢查新版本 —— 修改 release assets 的檔名規則（`.releaserc.json` 的 assets glob）時，必須同步更新這裡的 `currentAssetPattern`/`pickAsset` 邏輯，否則應用內更新會抓不到正確的安裝檔。
- `@neutralinojs/neu` **刻意鎖在 `11.7.1`**（`package.json` 的 `setup` script、`.github/workflows/release.yml` 三個 build job 都是）——`latest`（`11.7.2`）宣告的 `uuid` 依賴範圍會解析到一個 ESM-only 的版本，但它自己的程式碼還是用 CommonJS `require('uuid')`，導致全新安裝時直接 `ERR_REQUIRE_ESM` 崩潰。不要把這個版本號「升級」回 `latest`，除非先確認上游已修好。
- Linux 的 `.deb`/`.rpm`（`packaging/linux/build.sh`）宣告了 `libgtk-3-0`/`libwebkit2gtk-4.1-0`（deb）與 `gtk3`/`webkit2gtk4.1`（rpm）作為套件依賴 —— Neutralino 在 Linux 上要靠這些函式庫才能開視窗，`ldd` 只會顯示 gtk3 是直接依賴（webkit2gtk 是透過 GTK widget factory 動態載入，`ldd` 看不到，但實際會用到）。修改打包腳本時別把這些依賴拿掉。
- `playwright` 是 `devDependencies`（只有 `tests/*.js` 用得到），且 `.github/workflows/release.yml` 設了全域 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'`——沒有這個，每個 job 的 `npm ci` 都會下載瀏覽器執行檔（數百 MB），曾經因此在 macOS runner 上把硬碟空間耗盡，導致 `hdiutil create` 失敗（`No space left on device`）。不要把 `playwright` 移回 `dependencies`，也不要把這個 env var 拿掉。
- `setup.mjs`/CI 解壓縮 zip 時**不要假設裸指令 `tar` 支援 zip**——這個坑踩過兩次：Windows 上 Git Bash 的 `/usr/bin/tar`（GNU tar，不支援 zip）會蓋過真正支援 zip 的 `System32\tar.exe`（bsdtar），必須用完整路徑指定；Linux（包含 ubuntu-latest CI runner）預設的 `tar` 也是不支援 zip 的 GNU tar。現在的作法是 Windows 用完整路徑的 `System32\tar.exe`，macOS/Linux 一律用 `unzip`（標準、幾乎必定預裝的工具）。不要「簡化」回單純呼叫 `tar`。

## Neutralino 設定檔 (`neutralino.config.json`) 關鍵注意事項
這幾個設定值有非常隱蔽的失敗模式（改壞了在 `neu run` 開發模式下完全测不出來，只有實際打包後的版本才會出問題）：

- **`cli.resourcesPath` 必須等於 `documentRoot`**（目前都是 `/web-dist/`）。`neu build` 只會把 `resourcesPath` 指到的資料夾打包進 `resources.neu`/`--embed-resources`，但實際提供網頁內容的是 `documentRoot`。這兩個值曾經不一致過（`resourcesPath` 錯指到 `/resources/`），造成**每一個打包版本開啟後都是 404** —— `neu run` 因為用 `--load-dir-res` 直接讀硬碟所以完全不會發現這個問題，只有透過 `neu build --release` 實際包出來執行才測得到。改動這兩個設定任何一個時，必須真的建置一份 release 版本並實際執行、curl 內部 server 確認回 200，不能只跑 `neu run`/Playwright 測試。
- **`defaultMode` 必須是 `"window"`**，不能是 `"browser"`（Neutralino 專案樣板的預設值，之前不小心留著沒改）。設成 `"browser"` 的話，使用者點開安裝好的 App 會跳出系統瀏覽器分頁，而不是獨立的原生視窗。
- `neu update` 會把 client library 直接寫到 `web-dist/js/neutralino.js`（照 `clientLibrary` 設定），但 `vite.config.mjs` 的複製 plugin 是從 `resources/js/neutralino.js`（gitignored）讀「唯一正確來源」再複製回 `web-dist/`——這兩個路徑不一樣，且 vite build 的 `emptyOutDir` 會把 `web-dist/` 清空。全新 checkout 後必須先跑 `node scripts/copy-neutralino-client.mjs`（`npm run setup`/CI 都已經接好這步），否則 `npm run build` 會因為找不到 `resources/js/neutralino.js` 直接失敗。

## 測試與 UI 補充注意事項
- `defaultMode` 從 `"browser"` 換成 `"window"` 後，`useFileManager.js` 的 `onDrop`（DOM drop fallback）在 `NL_MODE === 'window'` 時會直接 return（真正的原生拖放走 `filesDropped` event）。`tests/test_drop.js` 的「Test B: browser-mode DOM drop fallback」因此需要在觸發 drop 事件前手動把 `window.NL_MODE` 設回 `'browser'` 才測得到那條路徑——修改 `onDrop`/drop 相關邏輯時要留意這個測試的特殊處理，不要以為它測的是目前預設模式的行為。
- `.update-toast`（`src/components/UpdateBanner.jsx`）的 z-index **必須小於** `.modal-overlay`（100）——目前是 90。曾經設成 200（比 modal 高）導致有更新通知時，toast 會蓋在 Trim/Crop/MixedType 等 modal 上面並吃掉點擊事件。開著的 modal 應該要蓋住/擋住 toast，反過來就是 bug。
- 每次修改核心轉檔邏輯或共用 UI 元件後，除了跑本節開頭的 4 大類別 checklist，也要重新跑一次 `node tests/test_conversion.js`、`test_drop.js`、`test_crop_ui.js` 三個完整套件（不是只挑幾個 case），因為這次 session 有兩次是「看似無關的修改」（`defaultMode` 切換、update-toast 新增）意外讓其他測試套件出現真實的 regression。
