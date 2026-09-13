import { describe, expect, it } from "vitest";

import { createTdxClient, type TdxClientOptions } from "@/lib/tdx/client";

const CREDENTIALS = { clientId: "the-id", clientSecret: "the-secret" };

type Scripted = Response | Error;

/**
 * 依序回應預先排定的結果的假 fetch。`Error` 代表連線層失敗（fetch 直接拋出），
 * 這是 spike 期間實際遇過的情形，與「回了非 200」是兩條不同的路徑。
 */
function scriptedFetch(responses: Scripted[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected extra fetch: ${String(input)}`);
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof globalThis.fetch;

  return { fetchImpl, calls, remaining: () => responses.length };
}

function tokenResponse(accessToken: string, expiresIn = 86400) {
  return Response.json({ access_token: accessToken, expires_in: expiresIn });
}

function authCallCount(calls: { url: string }[]) {
  return calls.filter((c) => c.url.includes("/token")).length;
}

/** 假時鐘與立即回傳的 sleep，讓重試與過期測試不需真的等待。 */
function harness(responses: Scripted[], overrides: Partial<TdxClientOptions> = {}) {
  const script = scriptedFetch(responses);
  let nowMs = 1_000_000;
  const slept: number[] = [];

  const client = createTdxClient({
    credentials: CREDENTIALS,
    fetch: script.fetchImpl,
    now: () => nowMs,
    sleep: async (ms) => {
      slept.push(ms);
      nowMs += ms;
    },
    minIntervalMs: 0,
    ...overrides,
  });

  return {
    client,
    calls: script.calls,
    slept,
    advance: (ms: number) => {
      nowMs += ms;
    },
    remaining: script.remaining,
  };
}

describe("createTdxClient", () => {
  // tasks 3.2 的驗收條件。token 效期 24 小時，長跑的規劃流程必然跨越它。
  it("re-authenticates after the cached token expires", async () => {
    const h = harness([
      tokenResponse("first", 3600),
      Response.json([{ id: 1 }]),
      tokenResponse("second", 3600),
      Response.json([{ id: 2 }]),
    ]);

    await h.client.get("/Attraction", "tourism");
    h.advance(3600 * 1000);
    await h.client.get("/Attraction", "tourism");

    expect(authCallCount(h.calls)).toBe(2);
    expect(h.calls.at(-1)?.init?.headers).toMatchObject({
      authorization: "Bearer second",
    });
  });

  // 每次呼叫都重新認證會讓 TDX 的請求數直接翻倍，而速率限制是本專案的硬約束。
  it("reuses a valid token instead of authenticating per request", async () => {
    const h = harness([
      tokenResponse("only"),
      Response.json([]),
      Response.json([]),
      Response.json([]),
    ]);

    await h.client.get("/Attraction", "tourism");
    await h.client.get("/Restaurant", "tourism");
    await h.client.get("/Hotel", "tourism");

    expect(authCallCount(h.calls)).toBe(1);
  });

  // 並發呼叫若各自去換 token，第一次規劃就會送出一批重複的認證請求。
  it("authenticates once when several requests start concurrently", async () => {
    const h = harness([
      tokenResponse("shared"),
      Response.json([]),
      Response.json([]),
      Response.json([]),
    ]);

    await Promise.all([
      h.client.get("/Attraction", "tourism"),
      h.client.get("/Restaurant", "tourism"),
      h.client.get("/Hotel", "tourism"),
    ]);

    expect(authCallCount(h.calls)).toBe(1);
  });

  // token 可能在宣告的效期之前就被伺服器端作廢，此時本地的過期判斷不會觸發。
  it("refreshes the token and retries once when the API answers 401", async () => {
    const h = harness([
      tokenResponse("stale"),
      new Response("unauthorized", { status: 401 }),
      tokenResponse("fresh"),
      Response.json([{ ok: true }]),
    ]);

    await expect(h.client.get("/Attraction", "tourism")).resolves.toEqual([{ ok: true }]);
    expect(authCallCount(h.calls)).toBe(2);
  });

  // spike 實測：文件寫 50 req/s，實際數秒內 6 個請求就 429。429 是常態，不是例外。
  it("backs off and retries on 429", async () => {
    const h = harness([
      tokenResponse("t"),
      new Response("rate limited", { status: 429 }),
      new Response("rate limited", { status: 429 }),
      Response.json([{ ok: true }]),
    ]);

    await expect(h.client.get("/Attraction", "tourism")).resolves.toEqual([{ ok: true }]);
    expect(h.slept.length).toBe(2);
    expect(h.slept[1]).toBeGreaterThan(h.slept[0]);
  });

  // spike 期間 TDX 出現過連線逾時，fetch 直接拋出而非回傳非 200。
  // 只接住後者會讓整個分頁流程中斷——這正是第一版計數腳本掛掉的原因。
  it("retries when fetch itself throws, not only on non-200 responses", async () => {
    const h = harness([
      tokenResponse("t"),
      new Error("connect timeout"),
      Response.json([{ ok: true }]),
    ]);

    await expect(h.client.get("/Attraction", "tourism")).resolves.toEqual([{ ok: true }]);
    expect(h.slept.length).toBe(1);
  });

  // 400 代表請求本身有問題（例：$top 超過該端點上限），重試只是白白消耗速率額度。
  it("fails fast on 400 without retrying", async () => {
    const h = harness([
      tokenResponse("t"),
      new Response("bad request", { status: 400 }),
    ]);

    await expect(h.client.get("/Attraction?$top=99999", "tourism")).rejects.toThrowError(
      /400/,
    );
    expect(h.slept).toEqual([]);
  });

  // TDX 的 4xx 會在 body 裡說明原因（例：$top 超過該端點上限）。
  // 只記狀態碼等於把唯一的線索丟掉。
  it("includes the response body in the error so the cause is diagnosable", async () => {
    const h = harness([
      tokenResponse("t"),
      new Response("$top exceeds the maximum for this endpoint", { status: 400 }),
    ]);

    await expect(h.client.get("/Attraction/ServiceTime?$top=1000", "tourism")).rejects
      .toThrowError(/\$top exceeds the maximum/);
  });

  it("truncates an oversized error body rather than dumping it into the log", async () => {
    const h = harness([tokenResponse("t"), new Response("x".repeat(5000), { status: 400 })]);

    await expect(h.client.get("/Attraction", "tourism")).rejects.toThrowError(
      expect.objectContaining({ message: expect.stringContaining("…") }),
    );
    await expect(
      h.client.get("/Attraction", "tourism").catch((e: Error) => e.message.length),
    ).resolves.toBeLessThan(400);
  });

  it("gives up after the attempt limit rather than retrying forever", async () => {
    const h = harness(
      [
        tokenResponse("t"),
        new Response("", { status: 429 }),
        new Response("", { status: 429 }),
        new Response("", { status: 429 }),
      ],
      { maxAttempts: 3 },
    );

    await expect(h.client.get("/Attraction", "tourism")).rejects.toThrowError(/429/);
    expect(h.remaining()).toBe(0);
  });

  // 錯誤訊息會進日誌。金鑰若隨之外流，等於把 .env.local 寫進日誌檔。
  it("never puts credentials into the error it throws", async () => {
    const h = harness([new Response("no", { status: 400 })]);

    await expect(h.client.get("/Attraction", "tourism")).rejects.toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining(CREDENTIALS.clientSecret),
      }),
    );
  });

  // design D6：呼叫端必須自己節流，不能只依賴 50 req/s 這個數字。
  it("spaces consecutive requests by the configured minimum interval", async () => {
    const h = harness(
      [tokenResponse("t"), Response.json([]), Response.json([])],
      { minIntervalMs: 800 },
    );

    await h.client.get("/Attraction", "tourism");
    await h.client.get("/Restaurant", "tourism");

    expect(h.slept).toContain(800);
  });

  // Next 16 預設不快取 fetch，但未指定 cache 的請求可能在 prerender 時被凍結成
  // 建置期的一次結果。token 與班次查詢都不能被這樣對待。
  it("opts every request out of Next's fetch cache", async () => {
    const h = harness([tokenResponse("t"), Response.json([])]);

    await h.client.get("/Attraction", "tourism");

    for (const call of h.calls) {
      expect(call.init?.cache).toBe("no-store");
    }
  });

  // 實機驗證發現：TDX 的觀光 API 即使帶 $format=JSON，/Attraction 仍回
  // { value: [...] } 信封。單元測試看不到這件事，只有打真 API 才會現形。
  it("unwraps the OData envelope that TDX list endpoints actually return", async () => {
    const h = harness([tokenResponse("t"), Response.json({ value: [{ id: 1 }, { id: 2 }] })]);

    await expect(h.client.getList("/Attraction", "tourism")).resolves.toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });

  // 並非所有 TDX 端點都包信封，兩種形狀都得能接。
  it("accepts a bare array from endpoints that do not use the envelope", async () => {
    const h = harness([tokenResponse("t"), Response.json([{ id: 1 }])]);

    await expect(h.client.getList("/Bus/Route/City/PenghuCounty", "basic")).resolves.toEqual([
      { id: 1 },
    ]);
  });

  // 悄悄回空陣列會讓「查無結果」與「回應形狀不對」看起來一樣，
  // 而 nearby-search spec 要求這兩者必須可分辨。
  it("rejects a non-list response instead of silently returning nothing", async () => {
    const h = harness([tokenResponse("t"), Response.json({ message: "Resouce Not Found" })]);

    await expect(h.client.getList("/Nope", "tourism")).rejects.toThrowError(/不是列表/);
  });

  it("builds request URLs from the named TDX base", async () => {
    const h = harness([tokenResponse("t"), Response.json([])]);

    await h.client.get("/Bus/Route/City/PenghuCounty", "basic");

    expect(h.calls.at(-1)?.url).toBe(
      "https://tdx.transportdata.tw/api/basic/Bus/Route/City/PenghuCounty",
    );
  });

  it("surfaces a failed authentication instead of retrying it as an API error", async () => {
    const h = harness([new Response("bad credentials", { status: 401 })]);

    await expect(h.client.get("/Attraction", "tourism")).rejects.toThrowError(/401/);
  });

  // 認證與資料查詢走同一台主機，spike 期間該主機出現過連線逾時。
  // 若認證不重試，一次逾時就會讓整趟規劃失敗，而重試一次就能救回來。
  it("retries authentication when the auth request itself fails transiently", async () => {
    const h = harness([
      new Error("connect timeout"),
      new Response("", { status: 503 }),
      tokenResponse("recovered"),
      Response.json([{ ok: true }]),
    ]);

    await expect(h.client.get("/Attraction", "tourism")).resolves.toEqual([{ ok: true }]);
    expect(h.calls.at(-1)?.init?.headers).toMatchObject({
      authorization: "Bearer recovered",
    });
  });

  // 金鑰錯誤重試幾次都是錯的，只是把啟動失敗拖慢並多打幾次 TDX。
  it("does not retry authentication when the credentials are rejected", async () => {
    const h = harness([
      new Response("bad credentials", { status: 401 }),
      tokenResponse("never-used"),
    ]);

    await expect(h.client.get("/Attraction", "tourism")).rejects.toThrowError(/401/);
    expect(authCallCount(h.calls)).toBe(1);
  });
});
