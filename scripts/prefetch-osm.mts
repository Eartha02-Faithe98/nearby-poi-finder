/**
 * tasks 3.8 / 3.10 — 預抓 OSM 資料為快照（design D9、D11）。
 *
 * 兩個用途共用一次取回：
 * - **營業時間**（D9）：TDX 的結構化營業時間全台僅 77 個景點與 90 家餐廳，
 *   覆蓋率 1.24%／2.48%，驗證形同虛設。OSM 有 8,776 筆帶 `opening_hours`。
 * - **飲料類別**（D11）：TDX 收的是觀光餐飲，手搖飲 0 筆。OSM 有 9,527 筆。
 *
 * 執行：`node scripts/prefetch-osm.ts`
 *
 * **Overpass 必須一次查回全部候選再本地分群。** 每 IP 的並行額度極少，
 * 「一個標籤查一次」會從第二次開始全部被擋（實測主站與 kumi 鏡像皆然）。
 * 這也是它不得放在使用者請求路徑上的理由。
 */

import { ATTRIBUTIONS, buildSnapshot } from "../src/lib/snapshot/types.ts";
import { fetchJson, keepWithinTaiwan, log, writeSnapshot } from "./lib/prefetch.mts";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/**
 * Overpass 明確要求可辨識的 User-Agent。
 *
 * 不帶的話 kumi 鏡像直接回 429，訊息是
 * "Please include a meaningful User-Agent string with your requests to avoid rate-limiting."
 * 這是共享免費服務的基本禮節，也是它們區分正常使用與濫用的依據。
 */
const USER_AGENT =
  "nearby-poi-finder/0.1 (Taiwan trip planner; https://github.com/nearby-poi-finder)";

/**
 * 一次取回餐飲與飲料的所有候選。
 *
 * `nwr` 涵蓋 node／way／relation；`out tags center` 讓 way 與 relation
 * 也帶有代表座標，否則只有 node 有座標。
 */
const QUERY = `[out:json][timeout:600];
area["ISO3166-1"="TW"][admin_level=2]->.tw;
(
  nwr["amenity"~"^(restaurant|cafe|fast_food|ice_cream)$"](area.tw);
  nwr["shop"~"^(beverages|tea|coffee|bakery|confectionery|pastry|gift)$"](area.tw);
);
out tags center;`;

type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

/** 快照的資料列。只留下用得到的標籤，原始 tags 不全量保存。 */
export type OsmPlaceRow = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  openingHours?: string;
  amenity?: string;
  shop?: string;
  cuisine?: string;
};

function coordinateOf(row: OsmPlaceRow) {
  return { lat: row.lat, lon: row.lon };
}

function toRow(element: OverpassElement): OsmPlaceRow | undefined {
  const tags = element.tags ?? {};
  const name = tags.name;
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  // 無名稱的地點無法呈現給使用者，也無法與 TDX 的 POI 比對（tasks 3.9）。
  if (!name || typeof lat !== "number" || typeof lon !== "number") return undefined;

  return {
    id: `${element.type}/${element.id}`,
    name,
    lat,
    lon,
    ...(tags.opening_hours ? { openingHours: tags.opening_hours } : {}),
    ...(tags.amenity ? { amenity: tags.amenity } : {}),
    ...(tags.shop ? { shop: tags.shop } : {}),
    ...(tags.cuisine ? { cuisine: tags.cuisine } : {}),
  };
}

async function queryOverpass(): Promise<OverpassElement[]> {
  let lastError: Error | undefined;
  for (const endpoint of ENDPOINTS) {
    try {
      log(`  查詢 ${new URL(endpoint).host} …`);
      const body = await fetchJson<{ elements: OverpassElement[] }>(endpoint, {
        maxAttempts: 3,
        backoffMs: 20_000,
        init: {
          method: "POST",
          headers: {
            // 純字串 body 會讓 Content-Type 變成 text/plain，overpass-api.de 回 406。
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": USER_AGENT,
          },
          body: new URLSearchParams({ data: QUERY }),
        },
      });
      return body.elements;
    } catch (error) {
      lastError = error as Error;
      log(`  ${new URL(endpoint).host} 失敗：${lastError.message.slice(0, 120)}`);
    }
  }
  throw lastError ?? new Error("Overpass 查詢失敗");
}

async function main(): Promise<void> {
  const elements = await queryOverpass();
  log(`  取回 ${elements.length} 個 element`);

  const rows = elements
    .map(toRow)
    .filter((row): row is OsmPlaceRow => row !== undefined);
  log(`  具名且有座標：${rows.length} 筆`);

  const { kept, dropped } = keepWithinTaiwan(rows, coordinateOf);
  if (dropped > 0) log(`  座標落在台灣範圍外，已濾除 ${dropped} 筆`);

  const withHours = kept.filter((row) => row.openingHours).length;
  log(`  其中帶 opening_hours：${withHours} 筆`);

  await writeSnapshot(
    "osm-places",
    buildSnapshot(
      {
        source: "osm",
        dataset: "places",
        fetchedAt: new Date().toISOString(),
        attribution: ATTRIBUTIONS.osm,
      },
      kept,
    ),
  );

  log("完成。");
}

await main();
