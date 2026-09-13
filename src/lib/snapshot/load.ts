import "server-only";

import { readFile as readFileFromDisk } from "node:fs/promises";
import path from "node:path";

import type { Snapshot } from "@/lib/snapshot/types";

/**
 * 快照載入器。
 *
 * 取代 design D6 原本的「請求層 TTL 快取」：POI 全部來自預抓快照後，
 * 已不存在可省的重複外部請求，需要管理的變成「快照在不在、新不新」。
 *
 * **按需載入，不做切分。** 實測全部六份快照載入需 1,140 ms、heap 25 MB，
 * 而單次查詢通常只碰 1–2 份（查廁所只需 9.3 MB 那份，查景點＋美食只需 1.8 MB）。
 * 依縣市切分在這個量級下是過早最佳化——真正的效益來自只載入需要的資料集。
 * 若日後量測顯示冷啟動成本過高，再考慮切分。
 */

export const SNAPSHOT_NAMES = [
  "tdx-attraction",
  "tdx-food",
  "tdx-hotel",
  "tdx-souvenir",
  "moenv-toilets",
  "osm-places",
] as const;

export type SnapshotName = (typeof SNAPSHOT_NAMES)[number];

/** 產生該快照的指令，出現在缺漏時的錯誤訊息裡。 */
const PREFETCH_COMMANDS: Record<SnapshotName, string> = {
  "tdx-attraction": "npm run prefetch:tdx",
  "tdx-food": "npm run prefetch:tdx",
  "tdx-hotel": "npm run prefetch:tdx",
  "tdx-souvenir": "npm run prefetch:tdx",
  "moenv-toilets": "npm run prefetch:toilets",
  "osm-places": "npm run prefetch:osm",
};

/**
 * 預設 30 天。
 *
 * 觀光 POI、公廁與 OSM 都是低頻變動資料，過期的後果是「某家店已歇業卻仍列出」，
 * 而規格對這類情況已有規定（標註營業時間未知、由使用者自行確認）。
 */
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type LoadedSnapshot<TRow> = Snapshot<TRow> & {
  ageMs: number;
  /** 超過 maxAge。不是錯誤，但呼叫端必須能知道，且應呈現給使用者。 */
  stale: boolean;
};

export type SnapshotLoaderOptions = {
  dir?: string;
  readFile?: (filePath: string) => Promise<string>;
  now?: () => number;
  maxAgeMs?: number;
  /** 過期警告的輸出。測試以此斷言警告確實發出。 */
  warn?: (message: string) => void;
};

export type SnapshotLoader = {
  load<TRow>(name: SnapshotName): Promise<LoadedSnapshot<TRow>>;
  clear(): void;
};

/** 快照必備的中繼欄位。缺任何一個都代表檔案不是本專案產生的快照。 */
function assertShape(name: SnapshotName, parsed: unknown): asserts parsed is Snapshot<unknown> {
  const command = PREFETCH_COMMANDS[name];
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`快照 ${name} 的內容不是物件。請重新產生：${command}`);
  }

  const record = parsed as Record<string, unknown>;
  const missing: string[] = (["source", "dataset", "fetchedAt", "attribution"] as const).filter(
    (key) => typeof record[key] !== "string",
  );
  if (typeof record.rowCount !== "number") missing.push("rowCount");
  if (!Array.isArray(record.rows)) missing.push("rows");

  if (missing.length > 0) {
    throw new Error(
      `快照 ${name} 缺少必要欄位（${missing.join("、")}）。請重新產生：${command}`,
    );
  }
}

export function createSnapshotLoader(options: SnapshotLoaderOptions = {}): SnapshotLoader {
  const {
    // Vercel 的函式以專案根為工作目錄。`data/` 需由 next.config 的
    // outputFileTracingIncludes 納入部署產物，否則正式環境會找不到檔案。
    dir = path.join(process.cwd(), "data", "snapshots"),
    readFile = (filePath: string) => readFileFromDisk(filePath, "utf8"),
    now = Date.now,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    warn = (message: string) => console.warn(message),
  } = options;

  /**
   * 快取 Promise 而非結果，讓並發的載入共用同一次讀檔。
   * 這在冷啟動時有意義——多個請求可能同時打到同一個尚未暖機的實例。
   */
  const inFlight = new Map<SnapshotName, Promise<Snapshot<unknown>>>();

  async function read(name: SnapshotName): Promise<Snapshot<unknown>> {
    const command = PREFETCH_COMMANDS[name];
    const filePath = path.join(dir, `${name}.json`);

    let raw: string;
    try {
      raw = await readFile(filePath);
    } catch (cause) {
      // 靜默回空會讓「還沒預抓」看起來像「這個範圍查無結果」，
      // 而 nearby-search spec 要求查無結果必須是可信的告知。
      throw new Error(`找不到快照 ${name}（${filePath}）。請先執行：${command}`, { cause });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error(
        `快照 ${name} 不是有效的 JSON，可能已損毀。請重新產生：${command}`,
        { cause },
      );
    }

    assertShape(name, parsed);

    // rowCount 存在的唯一理由就是這個檢查：檔案被截斷時 rows 會比宣告的短，
    // 而截斷後的快照看起來完全正常——只是悄悄少了一部分台灣。
    if (parsed.rows.length !== parsed.rowCount) {
      throw new Error(
        `快照 ${name} 的內容與宣告不符：rowCount 為 ${parsed.rowCount}，實際 ${parsed.rows.length} 筆。` +
          `檔案可能在寫入或傳輸中被截斷。請重新產生：${command}`,
      );
    }

    return parsed;
  }

  async function load<TRow>(name: SnapshotName): Promise<LoadedSnapshot<TRow>> {
    let pending = inFlight.get(name);
    if (!pending) {
      pending = read(name);
      inFlight.set(name, pending);
      // 失敗不留在快取裡——否則補跑預抓之後仍需重啟行程才會生效。
      pending.catch(() => inFlight.delete(name));
    }

    const snapshot = (await pending) as Snapshot<TRow>;
    const ageMs = Math.max(0, now() - Date.parse(snapshot.fetchedAt));
    const stale = ageMs > maxAgeMs;

    if (stale) {
      // 過期不拋錯：資料舊的後果是「某家店已歇業卻仍列出」，規格對此已有規定，
      // 為此讓整個服務不可用並不合理。但它必須被說出來，且隨回傳值傳給呼叫端。
      warn(
        `快照 ${name} 已過期（取回於 ${snapshot.fetchedAt}，已經過 ${Math.floor(ageMs / 86_400_000)} 天）。` +
          `建議重新產生：${PREFETCH_COMMANDS[name]}`,
      );
    }

    return { ...snapshot, ageMs, stale };
  }

  return { load, clear: () => inFlight.clear() };
}

let shared: SnapshotLoader | undefined;

/** 應用程式共用的載入器。模組層級的快取讓同一個實例只讀一次檔。 */
export function snapshots(): SnapshotLoader {
  shared ??= createSnapshotLoader();
  return shared;
}
