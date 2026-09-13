/**
 * 離線預抓指令稿的共用工具。
 *
 * 三個來源（TDX、環境部公廁、OSM 營業時間）的取回方式各不相同，但都需要
 * 同一件事：可重試的請求、範圍過濾、以及寫出同一種形狀的快照。
 *
 * 以 `node scripts/prefetch-*.ts` 執行（Node 原生支援 TypeScript）。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Coordinate } from "../../src/lib/domain.ts";
import { isWithinTaiwan } from "../../src/lib/geo/taiwan-bounds.ts";
import type { Snapshot } from "../../src/lib/snapshot/types.ts";

export const SNAPSHOT_DIR = path.join(process.cwd(), "data", "snapshots");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 指令稿的進度輸出一律走 stderr，讓 stdout 保持乾淨可導向。 */
export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

export type FetchJsonOptions = {
  /** 含首次嘗試在內的總次數上限。 */
  maxAttempts?: number;
  /** 退避基數，實際等待為 base × 2^(attempt-1)。 */
  backoffMs?: number;
  init?: RequestInit;
};

/**
 * 取回 JSON，對連線層失敗與可重試的狀態碼退避重試。
 *
 * 連線層失敗與「回了非 200」是兩條不同的路徑，兩者都必須接住——
 * spike 階段的計數腳本只處理後者，一次連線逾時就讓整個分頁流程中斷。
 * 伺服器若指定了 `retry-after`，以它為準，不自行猜測。
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { maxAttempts = 5, backoffMs = 3_000, init } = options;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (cause) {
      lastError = new Error(`請求失敗：${url}`, { cause });
      if (attempt === maxAttempts) break;
      await sleep(backoffMs * 2 ** (attempt - 1));
      continue;
    }

    if (res.ok) {
      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        // Overpass 過載時會回傳 HTML 錯誤頁而非 JSON，狀態碼仍是 200。
        lastError = new Error(`回應不是 JSON：${text.slice(0, 200)}`);
        if (attempt === maxAttempts) break;
        await sleep(backoffMs * 2 ** (attempt - 1));
        continue;
      }
    }

    lastError = new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
    if (res.status < 429 || attempt === maxAttempts) break;

    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : backoffMs * 2 ** (attempt - 1),
    );
  }

  throw lastError ?? new Error(`請求失敗：${url}`);
}

/**
 * 濾掉座標落在台灣範圍外的資料列。
 *
 * 不是防禦性檢查——環境部的公廁資料實測有 0.32% 的座標是錯的
 * （經緯度顛倒或根本是別的數字），直接用會在地圖上出現離群點。
 * 回傳被濾掉的筆數，讓指令稿能把它印出來而非默默丟棄。
 */
export function keepWithinTaiwan<T>(
  rows: T[],
  coordinateOf: (row: T) => Coordinate | undefined,
): { kept: T[]; dropped: number } {
  const kept = rows.filter((row) => {
    const coordinate = coordinateOf(row);
    return coordinate !== undefined && isWithinTaiwan(coordinate);
  });
  return { kept, dropped: rows.length - kept.length };
}

/** 寫出快照。檔名不含副檔名。 */
export async function writeSnapshot<T>(name: string, snapshot: Snapshot<T>): Promise<void> {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  const file = path.join(SNAPSHOT_DIR, `${name}.json`);
  await writeFile(file, JSON.stringify(snapshot), "utf8");
  log(`  → ${file}（${snapshot.rowCount} 筆）`);
}
