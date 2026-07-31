請幫我建立一個純前端 SPA（單頁應用），完全本機執行，不需任何 client-server 架構。直接開啟 index.html 即可使用，所有邏輯都以 HTML + Vanilla JS（或輕量函式庫）實作，可引用外部 CDN 的 JS 函式庫。

功能規格如下：

### 核心功能
利用瀏覽器鏡頭（getUserMedia）即時拍攝名片，提供兩種模式：

1. **自動模式（Auto Mode）**
   - 持續偵測畫面中是否出現名片（可用簡單的邊緣偵測、面積變化、或定期截圖後交給 LLM 判斷）。
   - 當偵測到有一張清晰名片出現時，自動截取該幀，並呼叫 LLM 辨識名片上的聯絡資料。
   - 辨識完成後自動儲存結果。

2. **手動多張模式（Manual Multi Mode）**
   - 可切換為此模式。
   - 使用者可連續拍攝多張名片。
   - 每張名片都需手動按下「辨識」按鈕才呼叫 LLM。
   - 支援一次處理多張名片。

### 資料與查詢
- 所有辨識結果必須儲存在 **IndexedDB**。
- 每筆資料需保留：
  - 原始拍攝照片（含 bounding box 標示的裁切圖）
  - LLM 回傳的結構化聯絡資料（姓名、公司、職稱、電話、手機、Email、地址、其他備註等）
  - 拍攝時間、模式（auto/manual）等 metadata
- 提供查詢頁面，可瀏覽所有已儲存的名片，並清楚顯示「帶有 bounding box 的照片」。
- 支援將所有資料匯出為 Excel（.xlsx），建議使用 SheetJS (xlsx) 函式庫。

### LLM 呼叫方式
- 使用前端 JavaScript 直接呼叫 LLM API（例如 OpenAI 相容格式、或使用者可設定的 endpoint）。
- 請提供設定頁面，讓使用者可自行填入：
  - API Base URL
  - API Key
  - Model 名稱
- 辨識時請把名片圖片以 base64 或適合的方式傳給支援 vision 的模型，並要求 LLM 回傳嚴格 JSON 格式的聯絡資料。

### 技術要求
- 純 SPA，單一入口為 index.html。
- 不依賴任何後端伺服器。
- 使用現代瀏覽器 API：getUserMedia、Canvas、IndexedDB、File API。
- 介面簡潔實用，需有模式切換、即時預覽、結果列表、查詢與匯出功能。
- 程式碼結構清楚，可維護，註解適當。
- 請直接產出完整可運行的專案檔案（index.html + 必要的 JS/CSS），並說明如何使用。

請依照以上規格完整實作，並確保在本機直接開啟 HTML 就能運作。
