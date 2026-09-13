/**
 * tasks 3.4a — 預抓 TDX 觀光 POI 為快照。
 *
 * 為什麼是離線預抓而非即時查詢：TDX 的實測額度是**每分鐘 5 次**
 * （文件宣稱 50 req/s，差約 600 倍，見 spike-notes 3.3）。
 * 即時查詢下連一次地點名稱解析都要 8 分鐘，遠超過 Vercel 的 300 秒函式上限。
 *
 * 執行：`node --env-file=.env.local scripts/prefetch-tdx.ts`
 * 全量約 25,500 筆、59 次請求，在 12.5 秒節流下約需 12 分鐘。
 */

import type { Poi, PoiCategory } from "../src/lib/domain.ts";
import { ATTRIBUTIONS, buildSnapshot } from "../src/lib/snapshot/types.ts";
import {
  SOUVENIR_ATTRACTION_CODES,
  SOUVENIR_CUISINE_CODES,
} from "../src/lib/tdx/catalog.ts";
import { createTdxClient, type TdxClient } from "../src/lib/tdx/client.ts";
import { keepWithinTaiwan, log, writeSnapshot } from "./lib/prefetch.mts";

/** 每頁筆數。實測 500 安全，1000 在部分端點回 400。 */
const PAGE_SIZE = 500;

type TdxAddress = { City?: string; Town?: string; StreetAddress?: string };
type TourismRow = {
  PositionLat?: number;
  PositionLon?: number;
  PostalAddress?: TdxAddress;
} & Record<string, unknown>;

function formatAddress(address: TdxAddress | undefined): string | undefined {
  if (!address) return undefined;
  const joined = [address.City, address.Town, address.StreetAddress].filter(Boolean).join("");
  return joined || undefined;
}

function toPoi(
  row: TourismRow,
  idField: string,
  nameField: string,
  category: PoiCategory,
): Poi | undefined {
  const id = row[idField];
  const name = row[nameField];
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof row.PositionLat !== "number" ||
    typeof row.PositionLon !== "number"
  ) {
    return undefined;
  }
  const address = formatAddress(row.PostalAddress);
  return {
    id,
    name,
    category,
    coordinate: { lat: row.PositionLat, lon: row.PositionLon },
    ...(address ? { address } : {}),
  };
}

/** 分頁取回。指令稿不設頁數上限——離線執行，取完為止。 */
async function fetchAll(
  client: TdxClient,
  resource: string,
  filter?: string,
): Promise<TourismRow[]> {
  const all: TourismRow[] = [];
  for (let skip = 0; ; skip += PAGE_SIZE) {
    const params = new URLSearchParams({
      $top: String(PAGE_SIZE),
      $skip: String(skip),
      $format: "JSON",
    });
    if (filter) params.set("$filter", filter);

    const rows = await client.getList<TourismRow>(`/${resource}?${params}`, "tourism");
    all.push(...rows);
    log(`  ${resource}${filter ? ` [${filter}]` : ""} skip=${skip} → ${rows.length}（累計 ${all.length}）`);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

async function main(): Promise<void> {
  const client = createTdxClient({
    credentials: {
      clientId: process.env.TDX_CLIENT_ID ?? "",
      clientSecret: process.env.TDX_CLIENT_SECRET ?? "",
    },
  });

  const plain: [string, string, string, PoiCategory][] = [
    ["Attraction", "AttractionID", "AttractionName", "attraction"],
    ["Restaurant", "RestaurantID", "RestaurantName", "food"],
    ["Hotel", "HotelID", "HotelName", "hotel"],
  ];

  for (const [resource, idField, nameField, category] of plain) {
    log(`\n=== ${resource} → ${category}`);
    const rows = await fetchAll(client, resource);
    const pois = rows
      .map((row) => toPoi(row, idField, nameField, category))
      .filter((poi): poi is Poi => poi !== undefined);
    const { kept, dropped } = keepWithinTaiwan(pois, (poi) => poi.coordinate);
    if (dropped > 0) log(`  範圍外或座標缺漏，已濾除 ${dropped} 筆`);

    await writeSnapshot(
      `tdx-${category}`,
      buildSnapshot(
        {
          source: "tdx",
          dataset: category,
          fetchedAt: new Date().toISOString(),
          attribution: ATTRIBUTIONS.tdx,
        },
        kept,
      ),
    );
  }

  // 伴手禮由類別代碼界定，且必須一碼一次查詢——多個條件以 or 包在 any() 裡
  // TDX 回 500（實測）。代碼語意見 catalog.ts。
  log(`\n=== 伴手禮（類別代碼）`);
  const souvenirs = new Map<string, Poi>();

  for (const code of SOUVENIR_CUISINE_CODES) {
    const rows = await fetchAll(client, "Restaurant", `CuisineClasses/any(c: c eq ${code})`);
    for (const row of rows) {
      const poi = toPoi(row, "RestaurantID", "RestaurantName", "souvenir");
      if (poi) souvenirs.set(poi.id, poi);
    }
  }
  for (const code of SOUVENIR_ATTRACTION_CODES) {
    const rows = await fetchAll(client, "Attraction", `AttractionClasses/any(c: c eq ${code})`);
    for (const row of rows) {
      const poi = toPoi(row, "AttractionID", "AttractionName", "souvenir");
      if (poi) souvenirs.set(poi.id, poi);
    }
  }

  const { kept, dropped } = keepWithinTaiwan([...souvenirs.values()], (poi) => poi.coordinate);
  if (dropped > 0) log(`  範圍外或座標缺漏，已濾除 ${dropped} 筆`);

  await writeSnapshot(
    "tdx-souvenir",
    buildSnapshot(
      {
        source: "tdx",
        dataset: "souvenir",
        fetchedAt: new Date().toISOString(),
        attribution: ATTRIBUTIONS.tdx,
      },
      kept,
    ),
  );

  log("\n完成。");
}

await main();
