import { describe, expect, it } from "vitest";

import { createSnapshotLoader, SNAPSHOT_NAMES, type SnapshotName } from "@/lib/snapshot/load";
import { buildSnapshot } from "@/lib/snapshot/types";

const FETCHED_AT = "2026-09-14T00:00:00.000Z";
const NOW = Date.parse(FETCHED_AT);
const DAY_MS = 86_400_000;

function validSnapshot(rows: unknown[] = [{ id: "a" }]) {
  return JSON.stringify(
    buildSnapshot(
      {
        source: "tdx",
        dataset: "attraction",
        fetchedAt: FETCHED_AT,
        attribution: "資料來源：交通部 TDX",
      },
      rows,
    ),
  );
}

/** 以假的讀檔與時鐘建立載入器，並記錄讀了幾次、警告了什麼。 */
function harness(
  files: Partial<Record<SnapshotName, string | Error>>,
  overrides: { now?: number; maxAgeMs?: number } = {},
) {
  const reads: string[] = [];
  const warnings: string[] = [];

  const loader = createSnapshotLoader({
    dir: "/snapshots",
    now: () => overrides.now ?? NOW,
    ...(overrides.maxAgeMs !== undefined ? { maxAgeMs: overrides.maxAgeMs } : {}),
    warn: (message) => warnings.push(message),
    readFile: async (filePath) => {
      reads.push(filePath);
      const name = filePath.split(/[/\\]/).pop()?.replace(".json", "") as SnapshotName;
      const entry = files[name];
      if (entry === undefined) throw new Error("ENOENT");
      if (entry instanceof Error) throw entry;
      return entry;
    },
  });

  return { loader, reads, warnings };
}

describe("createSnapshotLoader", () => {
  it("loads a snapshot and reports its age", async () => {
    const h = harness({ "tdx-attraction": validSnapshot() }, { now: NOW + 3 * DAY_MS });

    const snapshot = await h.loader.load("tdx-attraction");

    expect(snapshot.rows).toEqual([{ id: "a" }]);
    expect(snapshot.rowCount).toBe(1);
    expect(snapshot.ageMs).toBe(3 * DAY_MS);
    expect(snapshot.stale).toBe(false);
  });

  // 授權標示必須隨資料一起到達呼叫端。nearby-search spec 的「資料出處標示」
  // 要求介面顯示它，散在呈現層硬編碼遲早會在新增來源時漏掉。
  it("carries the attribution through to the caller", async () => {
    const h = harness({ "tdx-attraction": validSnapshot() });

    expect((await h.loader.load("tdx-attraction")).attribution).toContain("TDX");
  });

  // 這是本模組存在的核心理由：缺快照若回空陣列，
  // 使用者看到的會是「這個範圍查無廁所」，而事實是「資料根本還沒抓」。
  it("throws a runnable instruction when the snapshot is missing, never an empty result", async () => {
    const h = harness({});

    await expect(h.loader.load("moenv-toilets")).rejects.toThrowError(
      /找不到快照 moenv-toilets.*npm run prefetch:toilets/,
    );
  });

  it("names the right prefetch command for each snapshot", async () => {
    const h = harness({});

    await expect(h.loader.load("osm-places")).rejects.toThrowError(/npm run prefetch:osm/);
    await expect(h.loader.load("tdx-hotel")).rejects.toThrowError(/npm run prefetch:tdx/);
  });

  it("rejects a corrupt file instead of treating it as no data", async () => {
    const h = harness({ "tdx-food": "{ not json" });

    await expect(h.loader.load("tdx-food")).rejects.toThrowError(/不是有效的 JSON/);
  });

  it("rejects a file that is not a snapshot at all", async () => {
    const h = harness({ "tdx-food": JSON.stringify([{ id: "a" }]) });

    await expect(h.loader.load("tdx-food")).rejects.toThrowError(/不是物件/);
  });

  it("names the missing metadata fields so the cause is obvious", async () => {
    const h = harness({
      "tdx-food": JSON.stringify({ source: "tdx", rows: [] }),
    });

    await expect(h.loader.load("tdx-food")).rejects.toThrowError(/dataset.*fetchedAt/);
  });

  // rowCount 的唯一用途。截斷後的快照看起來完全正常，
  // 只是悄悄少了一部分台灣——沒有這個檢查就無從察覺。
  it("detects a truncated file by comparing rowCount against the actual rows", async () => {
    const truncated = JSON.stringify({
      source: "moenv",
      dataset: "toilets",
      fetchedAt: FETCHED_AT,
      attribution: "x",
      rowCount: 45787,
      rows: [{ id: "a" }, { id: "b" }],
    });
    const h = harness({ "moenv-toilets": truncated });

    await expect(h.loader.load("moenv-toilets")).rejects.toThrowError(
      /rowCount 為 45787，實際 2 筆/,
    );
  });
});

describe("過期處理", () => {
  // 過期不拋錯：資料舊的後果是「某家店已歇業卻仍列出」，規格對此已有規定
  // （標註營業時間未知）。為此讓整個服務不可用並不合理。
  it("still returns the data when stale, because stale data beats no service", async () => {
    const h = harness({ "tdx-attraction": validSnapshot() }, { now: NOW + 60 * DAY_MS });

    const snapshot = await h.loader.load("tdx-attraction");

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.stale).toBe(true);
  });

  // 但過期絕不能是靜默的——呼叫端要拿得到，維運者要看得到。
  it("flags staleness on the result and warns with the command to fix it", async () => {
    const h = harness({ "tdx-attraction": validSnapshot() }, { now: NOW + 60 * DAY_MS });

    await h.loader.load("tdx-attraction");

    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/已過期/);
    expect(h.warnings[0]).toMatch(/60 天/);
    expect(h.warnings[0]).toMatch(/npm run prefetch:tdx/);
  });

  it("does not warn about a snapshot within the age limit", async () => {
    const h = harness({ "tdx-attraction": validSnapshot() }, { now: NOW + 29 * DAY_MS });

    expect((await h.loader.load("tdx-attraction")).stale).toBe(false);
    expect(h.warnings).toEqual([]);
  });

  // 時鐘偏移或快照剛寫完時，fetchedAt 可能微幅晚於 now。
  // 負數的年齡會讓呈現層顯示「-0 天前」這種東西。
  it("clamps a future fetchedAt to zero age rather than going negative", async () => {
    const h = harness({ "tdx-attraction": validSnapshot() }, { now: NOW - 5_000 });

    expect((await h.loader.load("tdx-attraction")).ageMs).toBe(0);
  });
});

describe("載入快取", () => {
  // 每次查詢都重新讀 9.3 MB 的公廁快照並 JSON.parse，等於把預抓省下的成本又賠回去。
  it("reads each snapshot from disk only once", async () => {
    const h = harness({ "moenv-toilets": validSnapshot() });

    await h.loader.load("moenv-toilets");
    await h.loader.load("moenv-toilets");
    await h.loader.load("moenv-toilets");

    expect(h.reads).toHaveLength(1);
  });

  // 冷啟動時多個請求可能同時打到同一個尚未暖機的實例。
  it("shares one read between concurrent loads", async () => {
    const h = harness({ "osm-places": validSnapshot() });

    await Promise.all([
      h.loader.load("osm-places"),
      h.loader.load("osm-places"),
      h.loader.load("osm-places"),
    ]);

    expect(h.reads).toHaveLength(1);
  });

  it("keeps each snapshot separate", async () => {
    const h = harness({
      "tdx-attraction": validSnapshot([{ id: "a" }]),
      "tdx-food": validSnapshot([{ id: "f" }, { id: "g" }]),
    });

    expect((await h.loader.load("tdx-attraction")).rows).toEqual([{ id: "a" }]);
    expect((await h.loader.load("tdx-food")).rows).toHaveLength(2);
    expect(h.reads).toHaveLength(2);
  });

  // 失敗若留在快取裡，補跑預抓之後仍需重啟行程才會生效——
  // 而在 serverless 上「重啟」不是操作者能主動做的事。
  it("does not cache a failure, so a later prefetch takes effect without a restart", async () => {
    const files: Record<string, string | Error> = {};
    const reads: string[] = [];
    const loader = createSnapshotLoader({
      dir: "/snapshots",
      now: () => NOW,
      warn: () => {},
      readFile: async (filePath) => {
        reads.push(filePath);
        const name = filePath.split(/[/\\]/).pop()!.replace(".json", "");
        const entry = files[name];
        if (entry === undefined) throw new Error("ENOENT");
        return entry as string;
      },
    });

    await expect(loader.load("tdx-souvenir")).rejects.toThrowError(/找不到快照/);

    files["tdx-souvenir"] = validSnapshot();
    await expect(loader.load("tdx-souvenir")).resolves.toMatchObject({ rowCount: 1 });
    expect(reads).toHaveLength(2);
  });

  it("clear() forces the next load to read again", async () => {
    const h = harness({ "tdx-food": validSnapshot() });

    await h.loader.load("tdx-food");
    h.loader.clear();
    await h.loader.load("tdx-food");

    expect(h.reads).toHaveLength(2);
  });
});

describe("每份快照都有對應的產生指令", () => {
  // 新增快照卻忘了註冊產生指令，會讓缺漏時的錯誤訊息變成 "undefined"，
  // 而那正是最需要它可讀的時刻。
  it("every snapshot name resolves to a prefetch command in its missing-file error", async () => {
    const h = harness({});

    for (const name of SNAPSHOT_NAMES) {
      await expect(h.loader.load(name)).rejects.toThrowError(/npm run prefetch:(tdx|toilets|osm)/);
    }
  });
});
