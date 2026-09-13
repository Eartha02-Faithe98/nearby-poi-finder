import type { PoiCategory } from "@/lib/domain";

/**
 * TDX 能供應的類別。
 *
 * 八大類中缺兩類，這不是疏漏而是資料現實（spike-notes A-1／A-2）：
 * - `drinks`：TDX 收的是觀光餐飲，手搖飲 0 筆。改由 OSM 供應，見 design D11。
 * - `restroom`：TDX 完全沒有廁所資料。改由環境部開放資料供應，見 design D8。
 *
 * 匯出這份清單是為了讓組合多個來源的那一層能斷言八類全數有著落，
 * 而不是讓未支援的類別悄悄回空陣列——那會與「查無結果」混淆。
 */
export const TDX_SERVED_CATEGORIES = [
  "attraction",
  "food",
  "hotel",
  "transport",
  "parking",
  "souvenir",
] as const satisfies readonly PoiCategory[];

export type TdxServedCategory = (typeof TDX_SERVED_CATEGORIES)[number];

export function isTdxServed(category: PoiCategory): category is TdxServedCategory {
  return (TDX_SERVED_CATEGORIES as readonly PoiCategory[]).includes(category);
}

/**
 * `/Nearby` 回傳的 24 個 `Related*` 集合中，本專案用得到的那些。
 *
 * 每筆只有 ID、名稱、座標——**沒有地址、沒有類別代碼**（實測，見 spike-notes 3.3）。
 * 因此 `souvenir` 無法由此取得，它需要類別代碼，走另一條路。
 */
export const NEARBY_COLLECTIONS: readonly {
  collection: string;
  category: TdxServedCategory;
  idField: string;
  nameField: string;
}[] = [
  { collection: "RelatedAttractions", category: "attraction", idField: "AttractionID", nameField: "AttractionName" },
  { collection: "RelatedRestaurants", category: "food", idField: "RestaurantID", nameField: "RestaurantName" },
  { collection: "RelatedHotels", category: "hotel", idField: "HotelID", nameField: "HotelName" },

  { collection: "RelatedBusStations", category: "transport", idField: "StationUID", nameField: "StationName" },
  { collection: "RelatedBusStops", category: "transport", idField: "StopUID", nameField: "StopName" },
  { collection: "RelatedInterCityBusStations", category: "transport", idField: "StationUID", nameField: "StationName" },
  { collection: "RelatedInterCityBusStops", category: "transport", idField: "StopUID", nameField: "StopName" },
  { collection: "RelatedMetroStations", category: "transport", idField: "StationUID", nameField: "StationName" },
  { collection: "RelatedThsrRailStations", category: "transport", idField: "StationUID", nameField: "StationName" },
  { collection: "RelatedTraRailStations", category: "transport", idField: "StationUID", nameField: "StationName" },
  { collection: "RelatedAirports", category: "transport", idField: "StationUID", nameField: "StationName" },
  { collection: "RelatedPorts", category: "transport", idField: "StationUID", nameField: "StationName" },
  { collection: "RelatedBikeStations", category: "transport", idField: "StationUID", nameField: "StationName" },

  { collection: "RelatedCityCarParks", category: "parking", idField: "CarParkID", nameField: "CarParkName" },
  { collection: "RelatedTourismCarParks", category: "parking", idField: "CarParkID", nameField: "CarParkName" },
  { collection: "RelatedPortCarParks", category: "parking", idField: "CarParkID", nameField: "CarParkName" },
  { collection: "RelatedRailStationCarParks", category: "parking", idField: "CarParkID", nameField: "CarParkName" },
  { collection: "RelatedFreewayCarParks", category: "parking", idField: "CarParkID", nameField: "CarParkName" },
  { collection: "RelatedAirportCarParks", category: "parking", idField: "CarParkID", nameField: "CarParkName" },
];

/**
 * 伴手禮的 TDX 類別代碼（design D11）。
 *
 * **TDX 不提供代碼表**——`/CuisineClass` 等皆 404，swagger 亦無 enum。
 * 以下語意是以 2,000 筆樣本實證反推的，每個代碼的實際筆數列於註解。
 * 這份對應由測試固定住：代碼語意若變動，測試要能抓到。
 *
 * 實測限制：多個條件以 `or` 包在 `any()` 裡會讓 TDX 回 **HTTP 500**，
 * 因此必須一碼一次查詢，不能合併。
 */
export const SOUVENIR_CUISINE_CODES = [
  116, // 糕餅名產：佳樂蛋糕、郭記名點（313 筆）
  115, // 地方特產加工：阿源伯柿餅、野薑花粽（183 筆）
  204, // 農特產：尚好堅果、葉記炒花生（6 筆）
] as const;

export const SOUVENIR_ATTRACTION_CODES = [
  14, // 觀光工廠：金門酒廠、宜蘭餅發明館（280 筆）
  6, //  購物：橘之鄉蜜餞形象館、夜市（280 筆）
  21, // 農特產產銷與市集（29 筆）
] as const;

/**
 * 縣市中文名對應 TDX `api/basic` 路徑所用的英文代碼。
 *
 * 觀光 API 以 `$filter` 比對中文市名，但停車場與公車站牌的端點是
 * `/City/{英文名}` 的路徑參數，兩者不通用。
 */
export const CITY_PATH_NAMES: Readonly<Record<string, string>> = {
  臺北市: "Taipei",
  新北市: "NewTaipei",
  桃園市: "Taoyuan",
  臺中市: "Taichung",
  臺南市: "Tainan",
  高雄市: "Kaohsiung",
  基隆市: "Keelung",
  新竹市: "Hsinchu",
  新竹縣: "HsinchuCounty",
  苗栗縣: "MiaoliCounty",
  彰化縣: "ChanghuaCounty",
  南投縣: "NantouCounty",
  雲林縣: "YunlinCounty",
  嘉義市: "Chiayi",
  嘉義縣: "ChiayiCounty",
  屏東縣: "PingtungCounty",
  宜蘭縣: "YilanCounty",
  花蓮縣: "HualienCounty",
  臺東縣: "TaitungCounty",
  澎湖縣: "PenghuCounty",
  金門縣: "KinmenCounty",
  連江縣: "LienchiangCounty",
};

/**
 * 將使用者輸入的**縣市名**正規化。
 *
 * 「台」與「臺」在真實輸入中兩者都常見，而 TDX 的縣市欄位一律用「臺」。
 * 不處理的話「台南市」查無結果而「臺南市」正常——這種差異對使用者毫無道理可言。
 *
 * **只適用於縣市名。** POI 名稱不可套用：實測 TDX 的景點名稱含「台」252 筆、
 * 含「臺」225 筆，兩種寫法都大量存在，正規化會讓其中一半永遠查不到。
 * POI 名稱的處理見 `swapTaiwanCharacter`。
 */
export function normalizeCityName(city: string): string {
  return city.trim().replace(/台/g, "臺");
}

/**
 * 互換字串中的「台」與「臺」。
 *
 * 用於 POI 名稱搜尋：以使用者輸入的字面查不到時，再試另一種寫法。
 * 不是正規化——兩種寫法在 TDX 的資料中都是有效的，沒有哪一種比較正確。
 */
export function swapTaiwanCharacter(text: string): string {
  return text.replace(/[台臺]/g, (char) => (char === "台" ? "臺" : "台"));
}

export function cityPathName(city: string): string | undefined {
  return CITY_PATH_NAMES[normalizeCityName(city)];
}
