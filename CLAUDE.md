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
