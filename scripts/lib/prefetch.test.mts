import { describe, expect, it, vi } from "vitest";

import { buildSnapshot } from "../../src/lib/snapshot/types.ts";
import { fetchJson, keepWithinTaiwan } from "./prefetch.mts";

/** 依序回應預先排定的結果。`Error` 代表 fetch 本身拋出（連線層失敗）。 */
function scriptedFetch(responses: (Response | Error)[]) {
  const calls: string[] = [];
  return {
    calls,
    install() {
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        calls.push(String(input));
        const next = responses.shift();
        if (next === undefined) throw new Error("unexpected extra fetch");
        if (next instanceof Error) throw next;
        return next;
      });
    },
  };
}

describe("buildSnapshot", () => {
  // rowCount 是載入端偵測檔案截斷的唯一依據，必須由資料本身導出，
  // 不能讓呼叫端自行填寫——手寫的數字遲早會與內容不一致。
  it("derives rowCount from the rows rather than trusting a caller", () => {
    const snapshot = buildSnapshot(
      { source: "tdx", dataset: "attraction", fetchedAt: "2026-09-13T00:00:00Z", attribution: "x" },
      [{ a: 1 }, { a: 2 }, { a: 3 }],
    );

    expect(snapshot.rowCount).toBe(3);
    expect(snapshot.rows).toHaveLength(3);
  });

  // 授權標示綁在資料旁邊，而非散在呈現層。nearby-search spec 的
  // 「資料出處標示」要求介面顯示它，來源一多就容易漏掉。
  it("carries the attribution alongside the data", () => {
    const snapshot = buildSnapshot(
      { source: "osm", dataset: "places", fetchedAt: "2026-09-13T00:00:00Z", attribution: "ODbL" },
      [],
    );

    expect(snapshot.attribution).toBe("ODbL");
  });
});

describe("keepWithinTaiwan", () => {
  // 環境部的公廁資料實測有一小部分座標是錯的（經緯度顛倒或離群值）。
  // 不濾掉會在地圖上出現離群點。
  it("drops rows outside Taiwan and reports how many", () => {
    const rows = [
      { name: "臺南車站", lat: 22.99681, lon: 120.21295 },
      { name: "經緯度顛倒", lat: 120.65, lon: 24.19 },
      { name: "東京", lat: 35.68, lon: 139.77 },
    ];

    const { kept, dropped } = keepWithinTaiwan(rows, (row) => ({ lat: row.lat, lon: row.lon }));

    expect(kept.map((r) => r.name)).toEqual(["臺南車站"]);
    expect(dropped).toBe(2);
  });

  // 離島是規格明列的支援範圍，不能被範圍過濾誤殺。
  it("keeps the offshore islands", () => {
    const rows = [
      { name: "馬公", lat: 23.5655, lon: 119.5794 },
      { name: "金城", lat: 24.4324, lon: 118.3171 },
      { name: "南竿", lat: 26.1608, lon: 119.9494 },
    ];

    const { kept, dropped } = keepWithinTaiwan(rows, (row) => ({ lat: row.lat, lon: row.lon }));

    expect(kept).toHaveLength(3);
    expect(dropped).toBe(0);
  });

  it("drops rows whose coordinate cannot be read at all", () => {
    const rows = [{ name: "無座標" }];

    const { kept, dropped } = keepWithinTaiwan(rows, () => undefined);

    expect(kept).toEqual([]);
    expect(dropped).toBe(1);
  });
});

describe("fetchJson", () => {
  // 連線層失敗與「回了非 200」是兩條不同的路徑。spike 階段的計數腳本
  // 只接住後者，一次連線逾時就讓整個分頁流程中斷。
  it("retries when fetch itself throws", async () => {
    const script = scriptedFetch([new Error("connect timeout"), Response.json({ ok: true })]);
    script.install();

    await expect(fetchJson("https://example.test/x", { backoffMs: 0 })).resolves.toEqual({
      ok: true,
    });
    expect(script.calls).toHaveLength(2);
  });

  // Overpass 過載時回的是 HTML 錯誤頁，但狀態碼仍是 200。
  // 只看狀態碼會把錯誤頁當成資料，然後在 JSON.parse 炸掉且無從得知原因。
  it("retries a 200 response whose body is not JSON", async () => {
    const script = scriptedFetch([
      new Response("<html>overload</html>", { status: 200 }),
      Response.json({ elements: [] }),
    ]);
    script.install();

    await expect(fetchJson("https://overpass.test/api", { backoffMs: 0 })).resolves.toEqual({
      elements: [],
    });
    expect(script.calls).toHaveLength(2);
  });

  it("retries 429 and 5xx", async () => {
    const script = scriptedFetch([
      new Response("", { status: 429 }),
      new Response("", { status: 503 }),
      Response.json({ ok: true }),
    ]);
    script.install();

    await expect(fetchJson("https://example.test/x", { backoffMs: 0 })).resolves.toEqual({
      ok: true,
    });
  });

  // 400 是請求本身有問題，重試只是把失敗拖慢。
  it("fails fast on a 4xx that is not 429", async () => {
    const script = scriptedFetch([new Response("bad request", { status: 400 })]);
    script.install();

    await expect(fetchJson("https://example.test/x", { backoffMs: 0 })).rejects.toThrowError(
      /400/,
    );
    expect(script.calls).toHaveLength(1);
  });

  // 錯誤訊息要能診斷。只記狀態碼時，TDX 的 400 完全看不出原因。
  it("puts the response body into the error", async () => {
    const script = scriptedFetch([
      new Response('{"error":{"msg":"\\"gc\\" is required"}}', { status: 400 }),
    ]);
    script.install();

    await expect(fetchJson("https://example.test/x", { backoffMs: 0 })).rejects.toThrowError(
      /gc.*required/,
    );
  });

  it("gives up after the attempt limit instead of retrying forever", async () => {
    const script = scriptedFetch([
      new Response("", { status: 429 }),
      new Response("", { status: 429 }),
      new Response("", { status: 429 }),
    ]);
    script.install();

    await expect(
      fetchJson("https://example.test/x", { backoffMs: 0, maxAttempts: 3 }),
    ).rejects.toThrowError(/429/);
    expect(script.calls).toHaveLength(3);
  });
});
