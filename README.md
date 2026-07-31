# CardLens

CardLens 是一個用來快速演示 API Endpoint 串接的純前端單頁應用（Single-page Application, SPA）。直接開啟 `index.html`，即可設定 OpenAI-compatible API、拍攝或匯入名片，並展示從影像辨識到結構化聯絡資料的完整流程。

## 主要功能

- 自動模式：偵測鏡頭中的名片，選擇近期較佳畫面、裁切並自動辨識。
- 手動多張模式：從單次拍攝中找出多張名片，拆成獨立佇列項目後批次辨識。
- 圖片匯入：從裝置選取一張或多張圖片加入處理佇列。
- 名片庫：搜尋、依模式篩選、排序、查看詳細資料及刪除紀錄。
- Excel 匯出：將名片聯絡資料輸出為 `.xlsx`。
- Local-first：名片圖片與辨識資料存放於 IndexedDB。

## 快速開始

不需安裝套件、不需 build，也不需啟動 backend。

macOS：

```bash
open ./index.html
```

Windows：

```bat
start .\index.html
```

請在專案目錄執行指令。若瀏覽器對 `file://` 頁面限制相機權限，仍可使用「匯入照片」演示 API 辨識流程。

## API 設定

第一次使用時，前往「設定」並填入：

- API Base URL：OpenAI-compatible API 的基底網址，不含結尾 `/`。
- Model：支援圖片輸入的模型名稱。
- API Key：使用者自行提供的存取金鑰。

程式會使用以下端點：

```text
GET  {API Base URL}/models
POST {API Base URL}/chat/completions
```

API 服務必須允許瀏覽器跨來源資源共享（Cross-Origin Resource Sharing, CORS），並接受 `Authorization: Bearer <API Key>`。

`app.js` 不包含預設 Endpoint 或 API Key。使用者儲存設定後，資料會以 `cardlens-settings` 為鍵寫入目前網站來源（origin）的 Local Storage。這不是安全的秘密儲存區；正式環境不應使用長效或高權限 Key，建議改用短效 token 或受控 proxy。

## 使用流程

1. 在「設定」完成 API 設定並測試連線。
2. 在「掃描」選擇自動模式或手動多張模式。
3. 開啟鏡頭拍攝，或匯入現有圖片。
4. 手動模式下勾選佇列項目，按「開始辨識」。
5. 前往「名片庫」搜尋、檢視或匯出資料。

影像加入佇列時會先寫入 IndexedDB，再呼叫 API。即使 API 逾時或辨識失敗，影像與錯誤狀態仍會保留，方便後續重試或查核。

## 本機資料

| 資料 | 儲存位置 | 識別名稱 |
|---|---|---|
| API Base URL、Model、API Key | Local Storage | `cardlens-settings` |
| 名片照片、裁切結果、聯絡資料、處理狀態 | IndexedDB | Database `cardlens-db` / Store `cards` |

「刪除所有資料」會清除名片資料與佇列，但會保留 API 設定。若要移除 API 設定，請透過瀏覽器 DevTools 清除該網站的 Local Storage。

## 專案結構

| 檔案 | 用途 |
|---|---|
| `index.html` | 頁面結構、導覽、相機、佇列、名片庫、設定與 Dialog |
| `app.js` | 路由、狀態、相機、偵測、裁切、API、IndexedDB 與 Excel 匯出 |
| `styles.css` | 介面樣式與響應式版面 |
| `vendor/scanic.js` | 本機名片邊界偵測與透視校正 |
| `vendor/xlsx.full.min.js` | SheetJS Excel 匯出 |
| `Handoff.md` | 架構、資料流、已知限制與接手驗收清單 |

第三方授權資訊位於 `vendor/LICENSE.scanic.txt` 與 `vendor/LICENSE.sheetjs.txt`。

## 技術與瀏覽器需求

- HTML5、CSS、Vanilla JavaScript
- MediaDevices / `getUserMedia`
- Canvas 2D API、Blob、Object URL
- IndexedDB、Local Storage
- 支援 `<dialog>` 的現代瀏覽器

專案目前沒有 build step、套件管理器或自動化測試。修改 JavaScript 後至少執行：

```bash
node --check app.js
```

相機、Canvas、IndexedDB、API CORS 與不同裝置鏡頭仍需在真實瀏覽器中人工驗證。

## 後續開發擴充

常見擴充方向：

- 新增辨識欄位：同步調整 `CONTACT_FIELDS`、辨識 prompt、名片詳細資料與 Excel 欄位。
- 更換 API 規格：從 `testConnection()`、`recognizeCard()` 與 `callChatCompletions()` 調整 endpoint、request 與 response parsing。
- 新增匯出格式：以 `state.cards` 與 `normalizeContact()` 為資料來源，加入 CSV、vCard 或 CRM connector。
- 強化多卡辨識：修改 `detectMultipleCardsWithScanic()`，或替換為可一次回傳多個 quadrilateral 的引擎。
- 調整本機資料結構：變更 IndexedDB schema 時必須提高 `DB_VERSION`，並在 `onupgradeneeded` 加入 migration。
- 正式部署：將長效 API Key 改為短效 token，或透過受控 backend / proxy 呼叫 API。

完整的擴充位置、修改順序與驗證重點請參考 `Handoff.md`。

## 已知限制

- 純前端直接呼叫 API 無法真正保護使用者輸入的 API Key。
- Scanic 一次回傳一個最佳文件；手動多張模式透過重疊分區掃描合併結果，仍可能漏框或重複。
- 單一匯入圖片目前只產生一個佇列項目，不會拆成多張名片。
- 大圖片、多卡掃描與透視裁切在主執行緒執行，低階裝置可能短暫停頓。
- `app.js` 透過手動 query string 進行 cache busting；修改後應同步更新 `index.html` 的版本參數。
