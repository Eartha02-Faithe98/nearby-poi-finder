import type { Coordinate, Poi } from "@/lib/domain";
import { distanceMeters } from "@/lib/geo/distance";
import { parseOpeningHours } from "@/lib/osm/opening-hours";
import type { EnrichedPoi, OsmPlaceRow } from "@/lib/osm/pois";

/**
 * 以名稱加座標鄰近度比對兩份資料中的同一個地點（tasks 3.9／3.12、design D9）。
 *
 * 兩個用途共用同一個比對器：
 * - **補營業時間**（3.9）：TDX 的結構化營業時間全台只有 77 個景點與 90 家餐廳
 *   （1.24%／2.48%），OSM 有 9,558 筆。兩邊沒有共同識別碼，只能靠名稱與座標。
 * - **去重**（3.12）：同一家店同時出現在 TDX 與 OSM 時只能呈現一次。
 */

/**
 * 比對半徑。
 *
 * 實測（tdx-food + tdx-attraction 共 9,828 筆對 osm-places 52,910 筆，名稱完全相同）：
 * 50 m 命中 337、200 m 命中 376、500 m 命中 437 但多候選情形翻倍。
 * 取 200 m——再放寬換來的多是同名不同店（連鎖店）的風險。
 */
export const MATCH_RADIUS_METERS = 200;

/** 名稱長度低於此值不做包含比對。「城」「站」這種一兩個字的片段會亂配。 */
const MIN_CONTAINS_LENGTH = 3;

/**
 * 名稱正規化。
 *
 * 台／臺一律折成「臺」（與 `normalizeCityName` 同向）：這裡是**我們自己在本地比對**
 * 兩份資料，不像 TDX 的名稱搜尋是把字面交給對方比對，因此可以放心折。
 */
export function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, "")
    .replace(/台/g, "臺")
    .toLowerCase()
    .replace(/[()（）[\]【】・·．.,、－\-_]/g, "");
}

type Placed = { name: string; coordinate: Coordinate };

export type PlaceIndex<T extends Placed> = {
  /** 找出與該名稱、該座標對應的地點。找不到回傳 undefined。 */
  findMatch(name: string, coordinate: Coordinate): T | undefined;
};

/**
 * 建立可依名稱與座標查詢的索引。
 *
 * ponytail: 用網格分桶，不用 R-tree 或空間資料庫。9,828 × 52,910 全比是 5.2 億次
 * 距離計算，分桶後每次只比鄰近 9 格（實測建索引 89 ms、全量比對 670 ms）。
 * 格邊長由半徑推出，永遠不小於半徑（以每度 90 公里保守換算，台灣的經度一度
 * 約 102 公里、緯度約 111 公里），所以 3×3 必然涵蓋。
 */
export function createPlaceIndex<T extends Placed>(
  items: T[],
  radiusMeters: number = MATCH_RADIUS_METERS,
): PlaceIndex<T> {
  const cellDegrees = radiusMeters / 90_000;
  const cellKey = (lat: number, lon: number): string =>
    `${Math.round(lat / cellDegrees)},${Math.round(lon / cellDegrees)}`;

  const grid = new Map<string, T[]>();
  for (const item of items) {
    const key = cellKey(item.coordinate.lat, item.coordinate.lon);
    const bucket = grid.get(key);
    if (bucket) bucket.push(item);
    else grid.set(key, [item]);
  }

  function nearby(coordinate: Coordinate): { item: T; metres: number }[] {
    const gi = Math.round(coordinate.lat / cellDegrees);
    const gj = Math.round(coordinate.lon / cellDegrees);
    const found: { item: T; metres: number }[] = [];

    for (let i = gi - 1; i <= gi + 1; i++) {
      for (let j = gj - 1; j <= gj + 1; j++) {
        for (const item of grid.get(`${i},${j}`) ?? []) {
          const metres = distanceMeters(coordinate, item.coordinate);
          if (metres <= radiusMeters) found.push({ item, metres });
        }
      }
    }
    return found;
  }

  function findMatch(name: string, coordinate: Coordinate): T | undefined {
    const target = normalizeName(name);
    if (!target) return undefined;

    const candidates = nearby(coordinate).sort((a, b) => a.metres - b.metres);

    // 先要完全相同的。同名多筆時取最近的一筆。
    const exact = candidates.find(({ item }) => normalizeName(item.name) === target);
    if (exact) return exact.item;

    // 再放寬到互相包含：「龍情花生軟糖(龍潭總店)」對「龍情花生」、
    // 「甘泉魚麵」對「甘泉魚麵埔心店」。實測在 200 公尺內多命中 299 筆，
    // 抽樣檢視皆為同一家店——分店名與副標題是兩邊命名習慣的主要差異。
    const contained = candidates.find(({ item }) => {
      const other = normalizeName(item.name);
      if (other.length < MIN_CONTAINS_LENGTH || target.length < MIN_CONTAINS_LENGTH) return false;
      return other.includes(target) || target.includes(other);
    });
    return contained?.item;
  }

  return { findMatch };
}

export type OsmIndex = PlaceIndex<OsmPlaceRow & Placed>;

/** OSM 快照的資料列是扁平的 lat／lon，補上 `coordinate` 才能進索引。 */
export function createOsmIndex(
  rows: OsmPlaceRow[],
  radiusMeters: number = MATCH_RADIUS_METERS,
): OsmIndex {
  return createPlaceIndex(
    rows.map((row) => ({ ...row, coordinate: { lat: row.lat, lon: row.lon } })),
    radiusMeters,
  );
}

/**
 * 以 OSM 的營業時間補上 TDX 地點缺少的資訊。
 *
 * 比對不到、或對到的 OSM 地點沒有營業時間、或營業時間解不出來時，
 * 該筆地點**照原樣回傳且 `openingHours` 維持 undefined**——兩份 spec 都要求
 * 缺營業時間的地點仍要出現在結果中並標註未知，不得被略過。
 */
export function applyOpeningHours(pois: Poi[], index: OsmIndex): EnrichedPoi[] {
  return pois.map((poi) => {
    if (poi.openingHours) return poi;

    const match = index.findMatch(poi.name, poi.coordinate);
    if (!match?.openingHours) return poi;

    const openingHours = parseOpeningHours(match.openingHours);
    if (!openingHours) return poi;

    return { ...poi, openingHours, usesOsmData: true };
  });
}

/**
 * 去重：濾掉已經以另一個資料源出現過的地點（tasks 3.12）。
 *
 * 保留 `existing`（TDX 側）而捨棄候選，因為 TDX 的名稱與地址是策展過的，
 * 而營業時間已由 `applyOpeningHours` 從 OSM 那一筆搬過去——捨棄的只有重複，
 * 不是資訊。呼叫端的順序因此是：先補營業時間，再去重。
 */
export function excludeDuplicates(
  candidates: EnrichedPoi[],
  existing: Poi[],
  radiusMeters: number = MATCH_RADIUS_METERS,
): EnrichedPoi[] {
  const index = createPlaceIndex(existing, radiusMeters);
  return candidates.filter((poi) => !index.findMatch(poi.name, poi.coordinate));
}
