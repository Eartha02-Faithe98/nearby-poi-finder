import type { Poi, PoiCategory } from "@/lib/domain";
import { parseOpeningHours } from "@/lib/osm/opening-hours";

/**
 * 以 OSM 快照直接供應某些類別的 POI（tasks 3.10／3.11、design D11）。
 *
 * TDX 收錄的是「觀光餐飲」而非日常店家：手搖飲在 TDX 是 **0 筆**，
 * 而台灣最主要的飲料型態就是手搖飲。這些類別的資料只能來自 OSM。
 */

/** OSM 快照的資料列，與預抓指令稿共用。只留下用得到的標籤，原始 tags 不全量保存。 */
export type OsmPlaceRow = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** OSM 的 `opening_hours` 原始字串，尚未解析。 */
  openingHours?: string;
  amenity?: string;
  shop?: string;
  cuisine?: string;
};

/**
 * 含 OSM（ODbL）資料的地點。
 *
 * `usesOsmData` 不是裝飾：兩份 spec 都要求「結果或行程中含 ODbL 授權資料時，
 * 標示 OpenStreetMap 為出處並註明 ODbL」。標在單筆地點上，呈現層才知道該不該標，
 * 而不必假設「只要載入過 OSM 快照就全部標上」。
 * 整筆來自 OSM、或只有營業時間來自 OSM，都會標上。
 */
export type EnrichedPoi = Poi & { usesOsmData?: true };

/** 一個類別在 OSM 中的標籤定義。任一欄位命中即算。 */
type TagFilter = { amenity?: string[]; shop?: string[]; cuisine?: string[] };

/**
 * 類別與 OSM 標籤的對應（design D11）。
 *
 * **以測試固定住這份對應。** 標籤集合是 spike 期間逐一比對筆數與樣本店家得到的，
 * 散在程式各處硬編碼的話，改動不會有任何東西攔住。
 */
export const OSM_CATEGORY_TAGS: Partial<Record<PoiCategory, TagFilter>> = {
  // 手搖飲同時出現在 `shop=beverages`（迷客夏、茶的魔手）與 `amenity=cafe`
  // 加 `cuisine=bubble_tea`（可不可熟成紅茶），兩邊都要收才不會漏掉連鎖店的一半分店。
  drinks: {
    amenity: ["cafe"],
    shop: ["beverages", "tea", "coffee"],
    cuisine: ["bubble_tea", "coffee_shop"],
  },

  // 伴手禮是 **TDX 代碼集合 ∪ 這一組**（D11）。TDX 側語意精準但量少（1,041 筆），
  // 代碼由 `SOUVENIR_CUISINE_CODES`／`SOUVENIR_ATTRACTION_CODES` 定義並由測試固定。
  //
  // **刻意排除 `bakery`（1,390 筆）與 `deli`（36 筆）**：那是一般麵包店與熟食店。
  // 巷口的麵包店不是伴手禮——把它們收進來會讓這個類別失去意義。
  souvenir: {
    shop: ["gift", "confectionery", "pastry"],
  },

  // **只供附近搜尋，不供行程規劃**（design D12，見 NEARBY_SEARCH_ONLY_CATEGORIES）。
  // 咖啡館歸在飲料，不在這裡重複。
  food: {
    amenity: ["restaurant", "fast_food", "ice_cream"],
  },
};

/**
 * 只供附近搜尋、不供行程規劃候選召回的類別（design D12）。
 *
 * OSM 的 41,688 筆餐飲是一般店家，對「站在路口找吃的」正好，但沒有 TDX 的觀光策展——
 * 排進行程會出現巷口便當店。兩個 capability 對同一份資料的需求不同。
 *
 * ponytail: 以一個集合加呼叫端的一行過濾表達，不做兩套 provider。已知天花板：
 * 型別層攔不住誤用，靠的是 6.2 候選召回讀這個集合。升級路徑：若真的誤用過一次，
 * 再把 usage 變成 selectOsmPois 的必填參數。
 */
export const NEARBY_SEARCH_ONLY_CATEGORIES = new Set<PoiCategory>(["food"]);

/** OSM 的值可以是分號分隔的多值（`bakery;coffee_shop`），實測 2,942 筆 cuisine 如此。 */
function hasTag(value: string | undefined, wanted: string[] | undefined): boolean {
  if (!value || !wanted) return false;
  return value.split(";").some((tag) => wanted.includes(tag.trim()));
}

function matchesFilter(row: OsmPlaceRow, filter: TagFilter): boolean {
  return (
    hasTag(row.amenity, filter.amenity) ||
    hasTag(row.shop, filter.shop) ||
    hasTag(row.cuisine, filter.cuisine)
  );
}

export function toPoi(row: OsmPlaceRow, category: PoiCategory): EnrichedPoi {
  const openingHours = row.openingHours ? parseOpeningHours(row.openingHours) : undefined;
  return {
    id: row.id,
    name: row.name,
    category,
    coordinate: { lat: row.lat, lon: row.lon },
    // 解不出來的營業時間留為 undefined（未知），不猜——兩份 spec 都要求標註未知。
    ...(openingHours ? { openingHours } : {}),
    usesOsmData: true,
  };
}

/**
 * 從 OSM 快照取出某類別的地點。
 *
 * 類別沒有 OSM 定義時回傳空陣列——呼叫端應以 `OSM_CATEGORY_TAGS` 判斷該不該問，
 * 而不是把空陣列讀成「這個類別查無結果」。
 */
export function selectOsmPois(rows: OsmPlaceRow[], category: PoiCategory): EnrichedPoi[] {
  const filter = OSM_CATEGORY_TAGS[category];
  if (!filter) return [];
  return rows.filter((row) => matchesFilter(row, filter)).map((row) => toPoi(row, category));
}
