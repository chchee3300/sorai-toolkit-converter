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
- `src/version.json` 由 `scripts/write-version.mjs` 在 CI 建置時覆寫，本地開發請勿手動更動其值（`0.1.0` 只是佔位符）。
- `src/hooks/useUpdateChecker.js` 會在啟動時打 GitHub API 檢查新版本 —— 修改 release assets 的檔名規則（`.releaserc.json` 的 assets glob）時，必須同步更新這裡的 `currentAssetPattern`/`pickAsset` 邏輯，否則應用內更新會抓不到正確的安裝檔。
