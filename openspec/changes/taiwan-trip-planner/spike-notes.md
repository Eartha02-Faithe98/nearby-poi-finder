# Spike 記錄 — taiwan-trip-planner

本檔為 tasks.md 第 1 組任務的產出。每一節對應一個任務。

---

## 1.5 Vercel free tier 函式執行時間上限

**日期**：2026-09-13
**來源**：Vercel 官方文件 `/docs/functions/configuring-functions/duration`（last_updated 2026-08-24）

Vercel Functions 在 fluid compute（預設啟用）下的時長限制：

| 方案 | 預設 | 最大 | 延長上限 |
|---|---|---|---|
| **Hobby（免費）** | **300s** | **300s** | — |
| Pro | 300s | 800s | 1800s（Beta） |
| Enterprise | 300s | 800s | 1800s（Beta） |

**結論**：Hobby 方案有 300 秒可用，且為預設值，無需額外設定。

**對 design.md 的影響**：原先列為風險的「單次規劃超出 Vercel free tier 函式執行時間上限」在
300 秒的額度下不再是實質限制——一次規劃的 TDX 呼叫加 LLM 呼叫遠低於此。已下修該風險條目。

**保留的事項**：
- tasks 7.5 的串流進度回報仍保留。理由已非避免逾時，而是使用者體驗——數十秒的等待需要
  回饋。此外文件指出 HTTP/1.1 的長連線可能被中介層關閉，建議在工作進行時串流進度或
  心跳資料，這也支持保留串流。
- Next.js App Router 設定方式為在 route 檔案匯出 `export const maxDuration = <秒>`。

---

## 1.1 TDX 帳號與 API 金鑰 — 完成

**日期**：2026-09-13。金鑰由專案擁有者申請並填入 `.env.local`。

- 認證端點：`POST https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token`
  （`grant_type=client_credentials`）。token 效期 **86400 秒（24 小時）**。
- 驗證呼叫：`GET /Attraction?$top=3` → **HTTP 200，3 筆非空資料**。

### 重要：網路上流傳的端點全部是舊的

各教學文章與部落格寫的 `https://tdx.transportdata.tw/api/basic/v2/Tourism/ScenicSpot/{City}`
**一律回 404**。實際情況：

| 項目 | 正確值 |
|---|---|
| 觀光 API base | `https://tdx.transportdata.tw/api/tourism/service/odata/V2/Tourism` |
| 景點資源名 | `Attraction`（`ScenicSpot` 已retire） |
| 轉乘規劃 base | `https://tdx.transportdata.tw/api/maas` |
| 公共運輸 base | `https://tdx.transportdata.tw/api/basic`（此 base 仍有效，公車等） |

OpenAPI 定義檔的真實位置是 `https://tdx.transportdata.tw/webapi/File/Swagger/V3/{swaggerId}`
（swagger UI 頁面本身是 SPA，直接抓會得到 HTML 外殼）。已知 id：
觀光 `0aed433a-9e95-404d-974c-4e70e29ae460`、旅運規劃 `4513f9d6-caae-4cf7-a50c-e7887bec804e`。

### 觀光 API 實際提供的資源（共 26 條路徑）

`Nearby`、`Attraction`、`AttractionFee`、`Restaurant`、`Hotel`、`TourismServiceSite`、
`Trail`、`TrailFacility`、`CyclingRoute`、`CyclingRouteFacility`、`Event`，
以及各自的 `/{ID}` 與部分的 `/ServiceTime`。

`Nearby` 端點參數：`X`(經度)、`Y`(緯度)、`Distance`(公尺，**上限 1000**)。

`Attraction` 的欄位包含 `VisitDuration`（建議停留時間）與 `ParkingInfo`、`Facilities`，
對行程規劃有直接價值。

### 速率限制的實測

文件宣稱 50 req/s，但實測在**數秒內連續 6 個請求**即回 429。
`$top` 上限低於 20000（回 400）。實作時必須遠比 50 req/s 保守，並處理 429 重試。

---

## 1.2 TDX 旅運規劃模組涵蓋率 — 完成

**端點**：`GET https://tdx.transportdata.tw/api/maas/routing`

參數重點：`origin`/`destination` 為 `lat,lng`；`transit` 為**無中括號**的逗號整數列
（swagger 描述寫 `[3,4,5,6,7,8,9]` 是錯的，`example` 的 `3,4,5,6,7,8,9` 才對）；
運具代碼 `3`高鐵 `4`台鐵 `5`公車 `6`捷運 `7`輕軌 `8`渡輪 `9`纜車 `20`航空；
`depart` 與 `arrival` 二擇一，台北時區。

### 涵蓋率實測（2026-09-19 09:00 出發）

| 情境 | 路線 | 結果 |
|---|---|---|
| 本島市區 | 台南車站→安平古堡 | ✓ 3 案，Bus 2 臺南火車站(北站)→安平古堡(安北路) |
| 本島偏鄉 | 瑞穗車站→瑞穗牧場 | ✓ 3 案，HighwayBus 1137／1142 瑞穗→掃叭頂 |
| 離島 金門 | 金城→金湖 | ✓ 3 案，Bus 5往沙美 金城站→瓊林圓環 |
| 離島 綠島 | 台東富岡漁港→綠島 | ✓ 3 案，Ferry 臺東（富岡）─綠島 09:30→10:20 |
| **離島 澎湖** | **馬公市區→跨海大橋** | **✗ 0 案** |

回傳含實際班次時間、路線名稱、上下車站名——`transit-routing` spec 要求的欄位皆齊備。

### 三個必須處理的缺陷

**（a）澎湖完全無涵蓋。** 初測用的目的地座標落在望安島（需船班），可能構成偽陰性，
故以澎湖本島內的「馬公市區→澎湖跨海大橋」重測，**仍為 0 案**。確認為真實缺口。

**（b）預設會回傳開車與腳踏車接駁。** 未指定時 `first_mile_mode`／`last_mile_mode`
會產生 `drive`、`cycle` 區段，等於叫沒有車的使用者開車 900 公尺。
**必須明確指定 `first_mile_mode=0&last_mile_mode=0`。**
額外收穫：強制步行後路線品質反而提升——台南案從 Bus 14→文平路 變成 Bus 2→安平古堡(安北路)，
且三個方案不再是同一班次的三種接駁，而是真正不同的班次。

**（c）TDX 回傳的路線名稱存在錯誤資料。** 綠島案的方案 #2／#3 路線名為
「東港—小琉球」，但起訖站是「台東富岡漁港 → 綠島南寮漁港」。名稱與實際航線不符。
若直接顯示，會叫使用者去搭一艘不存在的船——這對「真實班次」這個核心賣點是直接打擊。
實作時路線名稱不可全然信任，應以上下車站名為主要顯示依據。

---

## 1.3 觀光 POI 營業時間缺漏比例 — 部分完成

**已確認**：營業時間**不在**主列表端點內。`/Attraction`、`/Restaurant`、`/Hotel`
的 `ServiceTimeInfo` 欄位在 500 筆抽樣中 **100% 為空**。
營業時間另有獨立端點 `/Attraction/ServiceTime` 與 `/Restaurant/ServiceTime`，
資料結構良好（`ServiceDays` 星期陣列 + `StartTime`/`EndTime`），可直接解析。

**關鍵數字**：以 `$top=500` 查詢兩支 ServiceTime 端點，分別只回
**77 筆（景點）**與 **90 筆（餐廳）**。因回傳筆數遠低於 `$top`，這應即為全台灣的完整筆數。

**未完成**：`/Attraction` 的總筆數尚未取得（`$top=20000` 回 400、`$top=1000` 撞上 429）。
因此「77 筆 ÷ 總數」的確切比例未定案。但無論總數為何，全台灣僅有 77 個景點與 90 家餐廳
具備結構化營業時間，這個絕對數字本身已足以判斷：**營業時間驗證在絕大多數站點上無法生效。**

**待辦**：等速率限制恢復後，以 `$top=1000` 加 `$skip` 分頁取得總筆數，補上確切百分比。

---

## 1.4 D3 決策 — 完成

**決策：採用 TDX 旅運規劃模組。**

理由：本島市區、本島偏鄉、金門、綠島四種情境皆回傳含實際班次時間、路線識別與上下車
站名的方案，完全滿足 `transit-routing` spec 的欄位要求。自行以原始時刻表實作銜接判定
（方案 B）在這四種情境下不會更好，只會更貴。

**但決策附帶三項強制條件**，皆源自 1.2 的缺陷：

1. 所有查詢一律帶 `first_mile_mode=0&last_mile_mode=0`，不得使用預設值。
2. 澎湖需要獨立處理。MVP 的處理方式尚未決定，須與專案擁有者確認——見下方「待決事項」。
3. 路線名稱不可全然信任，顯示時以上下車站名為主。

**方案 B 未被完全放棄**：它從「全面回退」降級為「澎湖專用的補洞方案」。

---

## 待決事項（需專案擁有者裁示）

本次 spike 發現四件會改動 spec 的事實，列於此處等待決策。

### A. 八大類別中有四類在 TDX 觀光 API 中沒有對應資源

`nearby-search` spec 的「類別涵蓋範圍」需求要求八類同等支援，但實際資料來源是：

| 類別 | 資料來源 | 狀態 |
|---|---|---|
| 景點 | `/Attraction` | ✓ |
| 美食 | `/Restaurant` | ✓ |
| 飯店 | `/Hotel` | ✓ |
| 交通運輸 | `api/basic` 各運具端點 | ✓ |
| 停車場 | `api/basic/v1/Parking/OffStreet/CarPark/City/{City}` | ✓ 回 200，回應結構待確認 |
| 飲料 | 疑為 `Restaurant.CuisineClasses` 之一種代碼 | ✗ 未確認 |
| 伴手禮 | 疑為 `Restaurant.CuisineClasses` 或 `AttractionClasses` 之一種代碼 | ✗ 未確認 |
| **廁所** | **在 TDX 中找不到任何資源** | **✗ 缺** |

類別代碼皆為數字（如 `AttractionClasses: [3, 2, 16]`、`CuisineClasses: [2, 254, 116]`），
swagger 未附代碼表，需另尋 TDX 代碼查詢服務才能對應到中文名稱。

廁所是先前討論中明確列為差異化重點的類別之一，TDX 無此資料。

### B. 營業時間驗證在絕大多數站點上無法生效

見 1.3。`trip-planning` spec 的「行程可行性保證」要求驗證站點在抵達時間是否營業，
並允許資料缺漏時標註為未知。實測顯示「未知」會是常態而非例外。

### C. 澎湖無轉乘規劃

見 1.2（a）。`trip-planning` spec 的「地理範圍限制」明列離島為支援範圍，
且「請求離島行程」scenario 以澎湖為例。

### D. TDX 路線名稱存在錯誤資料

見 1.2（c）。影響 `transit-routing` spec 的「班次資訊真實性」需求。

---

## 決策後的資料源驗證（2026-09-13）

專案擁有者針對「待決事項」A／B／C 做出決策後，於實作前先驗證各決策所依賴的資料源
是否真的存在且可用。輕信過時文件已在 1.1 造成一次繞路，此處不重蹈覆轍。

### 決策 C（澎湖走方案 B）— 前提成立 ✓

TDX 的澎湖公車原始資料完整存在，MaaS 模組只是沒把澎湖納入索引：

| 端點 | 結果 |
|---|---|
| `/v2/Bus/Route/City/PenghuCounty` | HTTP 200，範例路線 `001` |
| `/v2/Bus/Stop/City/PenghuCounty` | HTTP 200，範例站牌「馬公總站」 |
| `/v2/Bus/Schedule/City/PenghuCounty` | HTTP 200，含 RouteName／SubRoute／Direction |

方案 B 只需判定「這段在時間窗內是否搭得到」，上述三支端點已足夠。

### 決策 B（另找資料源補營業時間）— OSM 驗證通過 ✓

以 Overpass API 查詢台灣範圍（`ISO3166-1=TW`）：

| 指標 | 數量 |
|---|---|
| 餐飲 POI（restaurant／cafe／fast_food）node 總數 | 46,855 |
| 其中帶 `opening_hours` 標籤 | **8,776**（node 8,249 + way 527） |

對照 TDX 的 90 家，OSM 多出約 **97 倍**。涵蓋率約 18%，遠非完美，但已從
「形同虛設」變成「多數熱門店家可用」。授權為 ODbL，需標示出處。

### 決策 A（政府開放資料公廁）— 尚未驗證，且出現更省的替代方案

**未驗證**：`data.gov.tw` 的 REST API 路徑嘗試失敗（回 Method not allowed），
環境部平台的資料集代碼與 API 金鑰需求尚未確認。

**新發現**：OSM 同時也有廁所資料——台灣範圍內 `amenity=toilets` 共 **5,833 筆**
（node 4,036 + way 1,797）。

這使 A 與 B 可由**同一個資料源**解決。決策 A 作成時尚不知道這件事，
故將此事實回報給專案擁有者重新裁示，而非逕自更動。
