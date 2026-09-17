/**
 * tasks 3.6 — 預抓環境部「全國公廁建檔資料」為快照（design D8）。
 *
 * 資料集：data.gov.tw dataset 30794 → `data.moenv.gov.tw/api/v2/fac_p_07`。
 * API 金鑰不需自行註冊，data.gov.tw 的 metadata 即附政府發布的可用 key。
 *
 * 執行：`node scripts/prefetch-toilets.ts`
 * 全量 45,843 筆、46 次分頁請求，約 2 分鐘。
 *
 * 聚合（同一座標的男廁／女廁／無障礙合併為單一地點）不在此處，見 tasks 3.7。
 */

import type { ToiletRow } from "../src/lib/moenv/toilets.ts";
import { ATTRIBUTIONS, buildSnapshot } from "../src/lib/snapshot/types.ts";
import { fetchJson, keepWithinTaiwan, log, writeSnapshot } from "./lib/prefetch.mts";

/**
 * 環境部平台的 API 金鑰。
 *
 * 預設值是 **data.gov.tw 在 dataset 30794 的公開 metadata 中所發布的金鑰**，
 * 任何人都能取得，非本專案申請，公開於原始碼不構成外洩。
 * 但它是共用金鑰，若被限流可於 data.moenv.gov.tw 註冊後以 `MOENV_API_KEY` 覆寫。
 */
const API_KEY = process.env.MOENV_API_KEY ?? "REDACTED";

/** 伺服器端硬上限。指定更大的值只會回 1000 筆，且看起來像「離島沒資料」。 */
const PAGE_SIZE = 1_000;

/** 環境部回傳的公廁資料列（原始形狀，欄位名稱與大小寫照原樣）。 */
type MoenvApiRow = {
  county: string;
  village: string;
  number: string;
  name: string;
  address: string;
  administration: string;
  latitude: string;
  longitude: string;
  grade: string;
  type2: string;
  type: string;
  exec: string;
  diaper: string;
};

/** 座標是字串，且有一小部分是錯的（經緯度顛倒或離群），交由範圍過濾處理。 */
function toRow(row: MoenvApiRow): ToiletRow | undefined {
  const lat = Number(row.latitude);
  const lon = Number(row.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;

  return {
    id: row.number,
    name: row.name,
    address: row.address,
    lat,
    lon,
    type: row.type,
    grade: row.grade,
    diaper: row.diaper === "1",
  };
}

async function main(): Promise<void> {
  const all: ToiletRow[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const params = new URLSearchParams({
      api_key: API_KEY,
      limit: String(PAGE_SIZE),
      offset: String(offset),
      // 未指定 sort 時回傳順序不穩定，分頁會重複或漏掉資料列。
      sort: "number asc",
      format: "JSON",
    });
    const page = await fetchJson<MoenvApiRow[]>(
      `https://data.moenv.gov.tw/api/v2/fac_p_07?${params}`,
    );
    all.push(...page.map(toRow).filter((row): row is ToiletRow => row !== undefined));
    log(`  offset=${offset} → ${page.length}（累計 ${all.length}）`);
    if (page.length < PAGE_SIZE) break;
  }

  const { kept, dropped } = keepWithinTaiwan(all, (row) => ({ lat: row.lat, lon: row.lon }));
  log(`  座標落在台灣範圍外或無法解析，已濾除 ${dropped} 筆（${((100 * dropped) / all.length).toFixed(2)}%）`);

  await writeSnapshot(
    "moenv-toilets",
    buildSnapshot(
      {
        source: "moenv",
        dataset: "toilets",
        fetchedAt: new Date().toISOString(),
        attribution: ATTRIBUTIONS.moenv,
      },
      kept,
    ),
  );

  log("完成。");
}

await main();
