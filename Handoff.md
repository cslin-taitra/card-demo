# CardLens 開發交接文件

> 更新日期：2026-07-30  
> 應用型態：純前端單頁應用（Single-page Application, SPA）
> 主要目的：直接開啟 `index.html`，快速演示 API Endpoint 與名片 Vision 辨識流程

## 1. 目前狀態

CardLens 可在瀏覽器中完成名片拍攝或匯入、邊界偵測、透視裁切、Vision LLM 辨識、本機保存、搜尋與 Excel 匯出。

目前的重要安全狀態：

- `app.js` 的 `DEFAULT_SETTINGS.apiBaseUrl` 與 `DEFAULT_SETTINGS.apiKey` 均為空字串。
- 原始碼不再提供預設 Endpoint 或 API Key。
- 使用者需在設定頁自行輸入 API Base URL、Model 與 API Key。
- 儲存後的 API 設定位於 Local Storage，並非加密的秘密儲存區。
- 先前若曾使用硬編碼 Key，該 Key 應在服務端撤銷並輪替；移除程式碼不會使舊 Key 自動失效。

## 2. 核心產品流程

### 自動模式

```text
Camera
  → 每 450ms 取樣
  → Scanic 偵測名片四角
  → 檢查 confidence / ratio / frame area / guide coverage
  → 收集最近 2 個有效候選
  → 選擇分數較佳的原始畫面
  → perspective crop，失敗則使用 bounding box
  → 建立 queue item 並先寫入 IndexedDB
  → 呼叫 Vision LLM
  → 更新同一筆 IndexedDB record
  → 等待使用者移開原名片後再偵測下一張
```

### 手動多張模式

```text
Manual shutter
  → 保存完整畫面
  → 掃描 full frame + 8 個重疊分區
  → 將區域座標映射回原圖
  → 合併重複 bounding boxes
  → 最多保留 12 張名片
  → 各自裁切並建立 queue / IndexedDB record
  → 使用者勾選項目
  → 逐張呼叫 Vision LLM
  → 各自更新辨識結果
```

若手動拍攝未偵測到邊界，程式會保留中央約 `84% × 80%` 的範圍作為單張候選。

### 圖片匯入

- 自動模式只取所選檔案的第一張，加入後立即辨識。
- 手動模式可一次匯入多個檔案，再由使用者勾選辨識。
- 每個匯入檔案目前只偵測一張最佳名片，不會將單一圖片拆成多張名片。
- 匯入圖片的最長寬會縮至 `2200px` 後再處理。

## 3. `index.html` 職責

`index.html` 只負責文件結構與可互動元件，不包含業務邏輯。主要區塊：

| 區塊 | 主要元素 |
|---|---|
| 頂部導覽 | `.nav-item`、`#libraryCount`、`#connectionPill` |
| 掃描頁 | `#scannerView`、`#cameraVideo`、`#overlayCanvas`、模式與快門按鈕 |
| 處理佇列 | `#queueList`、`#selectAllQueue`、`#recognizeSelectedButton` |
| 名片庫 | `#libraryView`、搜尋、篩選、排序、`#libraryGrid` |
| 設定頁 | `#settingsForm`、`#apiBaseUrl`、`#modelName`、`#apiKey` |
| 對話框 | `#detailDialog`、`#confirmDialog` |
| 全域回饋 | `#toastRegion`、隱藏的 `#captureCanvas` |

載入順序：

```html
<link rel="stylesheet" href="styles.css">
<script src="vendor/xlsx.full.min.js"></script>
<script src="app.js?v=20260729-4"></script>
```

`app.js` 透過 ID 查找 DOM；修改或移除上述元素時，必須同步更新 `els` mapping 與事件綁定。`app.js` 的 query string 目前是手動 cache busting，修改程式後應更新版本參數。

## 4. `app.js` 職責

`app.js` 是單一立即執行函式（Immediately Invoked Function Expression, IIFE），並使用 `"use strict"` 避免污染全域作用域。

主要邏輯分區：

| 區域 | 代表函式 |
|---|---|
| 初始化與路由 | `init()`、`bindEvents()`、`route()` |
| API 設定 | `getSettings()`、`saveSettings()`、`testConnection()` |
| IndexedDB | `openDatabase()`、`dbRequest()`、`refreshCards()` |
| 相機 | `startCamera()`、`stopCamera()`、`switchCamera()` |
| 自動偵測 | `analyzeFrame()`、`evaluateDetection()`、`scoreDetectionCandidate()` |
| Scanic | `initializeVisionEngine()`、`detectCardWithScanic()` |
| 多卡拆分 | `detectMultipleCardsWithScanic()`、`detectionBoxesOverlap()` |
| 拍攝與裁切 | `captureFromVideo()`、`makeCapturedImages()` |
| 佇列 | `addToQueue()`、`renderQueue()`、`recognizeSelected()` |
| LLM 辨識 | `recognizeCard()`、`callChatCompletions()`、`parseJsonResponse()` |
| 名片庫 | `renderLibrary()`、`showCardDetail()`、刪除流程 |
| 匯出與工具 | `exportExcel()`、日期格式、ID、HTML escaping |

### 全域狀態

`state` 保存：

- IndexedDB connection 與 promise
- 工作模式、camera stream、前後鏡頭方向
- queue 與 cards
- 自動偵測 timer、候選畫面與掃描階段
- Scanic 載入狀態及 scanner instance
- Object URL cache
- 確認對話框待執行 action

切換頁面不會重建應用；所有 view 透過 `.active` class 與 URL hash 控制。

## 5. 設定與 API

### 預設設定

```js
const DEFAULT_SETTINGS = {
  apiBaseUrl: "",
  model: "taitra-mini",
  apiKey: "",
};
```

### Local Storage

- Key：`cardlens-settings`
- Value：JSON object

```json
{
  "apiBaseUrl": "https://example.com/v1",
  "model": "vision-model",
  "apiKey": "<user-provided>"
}
```

儲存前會移除 API Base URL 結尾的 `/`。若使用者瀏覽器中已有舊設定，更新程式碼不會自動清除該 Local Storage。

### API contract

測試連線：

```http
GET {apiBaseUrl}/models
Authorization: Bearer {apiKey}
```

辨識：

```http
POST {apiBaseUrl}/chat/completions
Content-Type: application/json
Authorization: Bearer {apiKey}
```

Request 使用 OpenAI-compatible multimodal `messages`，圖片以 JPEG Data URL 傳送。辨識 timeout 為 60 秒；連線測試 timeout 為 15 秒。

期望模型回傳 JSON：

```json
{
  "name": "",
  "company": "",
  "title": "",
  "phone": "",
  "mobile": "",
  "email": "",
  "address": "",
  "notes": ""
}
```

程式會先使用 `response_format: { "type": "json_object" }`。若 API 回傳 `400`、`404` 或 `422`，會移除 `response_format` 後重試一次。

## 6. IndexedDB

- Database：`cardlens-db`
- Version：`1`
- Object store：`cards`
- Key path：`id`
- Index：`capturedAt`、`mode`

主要 record 欄位：

| 類型 | 欄位 |
|---|---|
| 識別與狀態 | `id`、`capturedAt`、`mode`、`status`、`error` |
| 影像 | `originalImage`、`croppedImage`、`annotatedImage` |
| 偵測 | `boundingBox`、`corners`、`cropMethod`、`detectionMetrics` |
| 多卡關聯 | `captureGroupId`、`cardIndex`、`cardCount` |
| 尺寸 | `imageWidth`、`imageHeight` |
| 辨識 | `contact`、`rawResponse`、`model` |

狀態值：

- `pending`
- `processing`
- `success`
- `error`

`addToQueue()` 會立即呼叫 `persistQueueItem()`，因此 API 失敗不會丟失已拍攝影像。重新整理後，名片庫資料仍存在；記憶體中的 queue UI 則不會完整重建。

「刪除所有資料」會清空 `cards` store 與目前 queue，但刻意保留 Local Storage 中的 API 設定。

## 7. 本機視覺與第三方元件

### Scanic

- 檔案：`vendor/scanic.js`
- 由 `initializeVisionEngine()` 在閒置時動態載入
- 使用 classical detector、Canny、contour 與 quadrilateral detection
- 提供四角偵測及 perspective extraction
- 自動模式若 Scanic 無法載入，會停用自動擷取並提示使用手動快門

主要自動偵測門檻集中於 `AUTO_DETECTION` 與 `initializeVisionEngine()`。調整門檻時要同時測試名片大小、旋轉、透視、背景對比及誤拍率。

### SheetJS

- 檔案：`vendor/xlsx.full.min.js`
- 在 `index.html` 直接載入
- `exportExcel()` 以目前所有 `state.cards` 產生 `CardLens_YYYY-MM-DD.xlsx`

授權資訊位於：

- `vendor/LICENSE.scanic.txt`
- `vendor/LICENSE.sheetjs.txt`

## 8. 安全與隱私

### 現況

- 原始碼中沒有預設 Endpoint 或 API Key。
- API Key 儲存於 Local Storage，任何可執行同來源 JavaScript 的程式與可操作 DevTools 的人都可能讀取。
- 名片影像會以 Data URL 傳送至使用者指定的 Vision API。
- 名片圖片及結果保存在 IndexedDB，除非使用者刪除網站資料或執行「刪除所有資料」。

### 正式環境建議

1. 不要重新把真實 API Key commit 到前端。
2. 使用短效 token、受限權限與用量限制。
3. 較正式的部署應透過受控 backend / proxy 代送 API request。
4. 加入明確的影像外送、資料保存與刪除告知。
5. 確認舊 Key 已在 API 供應端撤銷，不只從檔案刪除。

## 9. 已知限制與技術債

### P0：缺少自動化測試

- 沒有 `package.json`、test runner 或 CI。
- 目前只能以 `node --check app.js` 做靜態語法檢查。
- 相機、Canvas、IndexedDB、CORS 與真實 Vision API 需人工端到端測試。

### P1：多卡偵測為啟發式

- Scanic 一次只回傳一個最佳文件。
- 九區掃描可能漏掉跨區域、互相遮擋或尺寸差異過大的名片。
- 去重只依相交面積占較小框面積 `60%` 判斷。
- 上限 12 張不代表所有情境都能穩定辨識 12 張。

### P1：效能與儲存

- 多卡模式順序執行九次 Scanic scan。
- 同次拍攝的每個子項目都保存一份完整原圖，可能快速增加 IndexedDB 容量。
- 偵測、裁切與 perspective transform 均在主執行緒。
- `app.js` 超過 2,000 行，功能仍集中在單一 IIFE。

### P1：Queue 持久化語意

- queue item 會寫入 IndexedDB，但重新整理後不會依 `pending` 狀態重建 queue 操作介面。
- 「清空處理佇列」只清除記憶體 queue，已寫入名片庫的 record 仍保留。
- 若產品預期 queue 與 library 完全分離，需要重新定義資料模型與刪除語意。

### P2：功能缺口

- 匯入單張含多張名片的圖片不會拆卡。
- 沒有人工調整 corners / bounding box 的裁切編輯器。
- 沒有聯絡人去重、合併、CSV、vCard 或 CRM integration。
- Cache busting 仍需手動更新 query string。

## 10. 後續開發擴充指引

### 新增聯絡資料欄位

例如新增 `website` 或 `department`：

1. 在 `CONTACT_FIELDS` 加入欄位名稱。
2. 更新 `recognizeCard()` 的 prompt 與固定 JSON 欄位說明。
3. 確認 `normalizeContact()` 能輸出新欄位。
4. 更新 `showCardDetail()` 的欄位清單。
5. 視需求更新 `renderLibrary()` 的搜尋或摘要內容。
6. 在 `exportExcel()` 加入欄位與 column width。
7. 使用缺值、單值與多值回應各測試一次。

既有 IndexedDB record 不需立即 migration；`normalizeContact()` 會將不存在的欄位轉為空字串。

### 更換或擴充 API Provider

目前實作假設 OpenAI-compatible `/models` 與 `/chat/completions`：

1. 在 `testConnection()` 修改健康檢查 endpoint 與驗證方式。
2. 在 `recognizeCard()` 建立 provider 所需的 request body。
3. 在 `callChatCompletions()` 調整 URL、headers、timeout 與認證方式。
4. 在 `extractTextContent()` / `parseJsonResponse()` 處理回應格式。
5. 將 provider-specific 邏輯封裝為 adapter，避免條件判斷散落於 UI flow。

若同時支援多個 provider，建議在設定資料加入 `provider`，並以明確 adapter interface 實作：

```js
{
  testConnection(settings),
  recognize(settings, imageDataUrl),
}
```

不要將真實 Key 或私有 Endpoint 寫入 `DEFAULT_SETTINGS`。

### 新增頁面或功能區

1. 在 `index.html` 新增具有 `data-view` 的 `.view`。
2. 新增對應的 `.nav-item` 與 `data-route`。
3. 在 `els` mapping 註冊必要 DOM elements。
4. 在 `bindEvents()` 綁定事件。
5. 將 route 名稱加入 `route()` 的 allowlist。
6. 在 `styles.css` 補齊 desktop、tablet 與 mobile layout。

若新增較大型功能，應從 `app.js` 拆成獨立 module，而不是繼續擴大單一 IIFE。

### 變更 IndexedDB schema

1. 提高 `DB_VERSION`。
2. 在 `openDatabase().onupgradeneeded` 依舊版 version 執行 migration。
3. 保留舊 record 缺少新欄位時的相容處理。
4. 測試全新資料庫與既有資料庫升級兩條路徑。
5. 不要只修改 record shape 而忽略 index、刪除語意與匯出流程。

### 強化偵測與裁切

- 調整門檻：修改 `AUTO_DETECTION` 與 Scanic scanner options。
- 支援正式多卡輸出：以可回傳多個 quadrilateral 的 detector 取代九區掃描。
- 加入人工校正：拍攝後提供新增框、刪除框與拖曳 corners 的確認畫面。
- 改善效能：將偵測與 perspective transform 移至 Web Worker / OffscreenCanvas。
- 降低容量：同一個 `captureGroupId` 只保存一份原圖，子 record 保存裁切圖與參照。

每次調整應使用固定測試圖片集，至少涵蓋正放、旋轉、透視、模糊、兩張並排、四張矩陣、重疊與深淺背景。

### 新增匯出或整合

以 `state.cards` 與 `normalizeContact()` 作為統一資料來源：

- CSV：新增 UTF-8 BOM 與欄位 escaping。
- vCard：處理多電話、Email、公司與地址 mapping。
- CRM：先加入人工確認與重複聯絡人處理，再進行同步。
- 批次同步：為 record 增加同步狀態、遠端 ID、錯誤與重試資訊。

### 建議的開發優先順序

1. 建立最小 browser smoke test 與測試圖片集。
2. 將 storage、API adapter、camera、detection 與 rendering 拆成模組。
3. 補上 API 設定清除功能與安全部署策略。
4. 正式化多卡 detector 與人工裁切確認。
5. 加入 CSV、vCard、CRM 或其他產品整合。

## 11. 本機執行與驗證

此專案以直接開啟 `index.html` 為主要演示方式，不需要啟動 server。

macOS：

```bash
open ./index.html
```

Windows：

```bat
start .\index.html
```

JavaScript 語法檢查：

```bash
node --check app.js
```

## 12. 接手驗收清單

- [ ] 首次開啟時顯示「尚未設定 API」，Endpoint 與 API Key 欄位為空。
- [ ] 儲存設定後重新整理，設定可由 Local Storage 還原。
- [ ] `GET /models` 測試連線可正確顯示成功、timeout 與 CORS 錯誤。
- [ ] 自動模式可偵測名片、選擇兩個候選中較佳畫面並完成辨識。
- [ ] 自動拍攝後必須移開原名片，才會開始偵測下一張。
- [ ] 四角存在時 `cropMethod` 為 `perspective`；失敗時退回 `bounding-box`。
- [ ] 手動模式可將兩張並排名片拆成兩個獨立項目。
- [ ] 測試四張矩陣、重疊名片、深淺背景與模糊畫面。
- [ ] API 失敗後，原圖、裁切圖與錯誤狀態仍存在 IndexedDB。
- [ ] 重新整理後名片庫資料仍存在。
- [ ] 搜尋、模式篩選、排序、詳細資料與單筆刪除正常。
- [ ] Excel 匯出欄位、筆數、日期與檔名正確。
- [ ] 「刪除所有資料」清除名片但保留 API 設定。
- [ ] 原始碼搜尋不到真實 API Key 或固定私有 Endpoint。
