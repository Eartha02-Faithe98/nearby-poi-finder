/**
 * TDX 的 HTTP 客戶端：認證、token 換發、重試與節流。
 *
 * **本模組刻意不標 `server-only`。** 它不持有任何機密——憑證由呼叫端以參數注入，
 * 而機密的守門在 `@/lib/env`（該模組標了 `server-only`）。拿掉這個 marker 是為了
 * 讓離線預抓指令稿能直接重用這裡的認證、節流與重試，而不是另外抄一份：
 * spike 階段抄出來的那份就漏接了 fetch 例外，導致整個分頁流程中斷。
 *
 * 此處的每一項行為都對應 spike 實測到的事實，而非防禦性編程：
 * 速率限制遠比文件嚴格、連線會逾時、`$top` 上限依端點而異。
 * 端點的正確值只信 spike-notes.md 的 1.1 節，網路上的教學一律是舊的。
 */

const AUTH_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

/** TDX 的三個 base。分開命名是因為它們的路徑前綴完全不同，拼錯會得到 404 而非錯誤訊息。 */
export const TDX_BASES = {
  tourism: "https://tdx.transportdata.tw/api/tourism/service/odata/V2/Tourism",
  basic: "https://tdx.transportdata.tw/api/basic",
  maas: "https://tdx.transportdata.tw/api/maas",
} as const;

export type TdxBase = keyof typeof TDX_BASES;

export type TdxCredentials = { clientId: string; clientSecret: string };

export type TdxClientOptions = {
  credentials: TdxCredentials;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 含首次嘗試在內的總次數上限。 */
  maxAttempts?: number;
  /** 連續兩個請求之間的最小間隔。 */
  minIntervalMs?: number;
};

export type TdxClient = {
  /** 取回原始 JSON。maas 的轉乘規劃等非列表端點用這支。 */
  get<T>(path: string, base: TdxBase): Promise<T>;

  /**
   * 取回列表端點的資料列。
   *
   * TDX 實測有三種回傳形狀，解包收在這裡，不讓每個 provider 各自重複一次
   * ——spike 的三支腳本就各寫了一遍：
   *
   * - 裸陣列（部分 `api/basic` v2 端點）
   * - OData 信封 `{ value: [...] }`（觀光 API，即使帶 `$format=JSON` 亦然）
   * - 具名集合信封 `{ UpdateTime, ..., CarParks: [...] }`
   *   （`api/basic` 的 v1／v3 端點，集合欄位名稱因端點而異）
   *
   * 第三種需以 `collectionKey` 指名集合欄位。
   */
  getList<T>(path: string, base: TdxBase, collectionKey?: string): Promise<T[]>;
};

/** 讀取錯誤回應的內容。讀取本身失敗不得蓋掉原本的錯誤。 */
async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch {
    return "";
  }
}

/** 錯誤內容可能很長（HTML 錯誤頁），截斷後才適合進日誌。 */
function detail(text: string): string {
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ");
  return `：${oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine}`;
}

/** 見 `TdxClient.getList` 的註解：TDX 實測有三種列表形狀。 */
function unwrapList<T>(body: unknown, collectionKey?: string): T[] {
  if (Array.isArray(body)) return body as T[];

  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    // 指名了集合欄位卻不存在，代表端點的回應形狀與預期不同。
    // 此時回空陣列會被誤讀為「查無結果」，而 nearby-search spec 要求兩者可分辨。
    if (collectionKey !== undefined) {
      if (Array.isArray(record[collectionKey])) return record[collectionKey] as T[];
      throw new Error(
        `TDX 回應缺少集合欄位 ${collectionKey}：實際欄位為 ${Object.keys(record).join(",")}`,
      );
    }
    if (Array.isArray(record.value)) return record.value as T[];
  }

  throw new Error(`TDX 回應不是列表：收到 ${body === null ? "null" : typeof body}`);
}

/**
 * 預設 12.5 秒。
 *
 * 文件宣稱 50 req/s，但 429 回應的標頭寫的是 `x-ratelimit-limit-minute: 5`
 * ——實際上是**每分鐘 5 次**，相差約 600 倍。12.5 秒的間隔對應每分鐘 4.8 次，
 * 留一點餘裕。
 *
 * 這個值讓單次規劃的呼叫預算變得極為稀缺（見 design D6 的修正），
 * 快取（tasks 3.4）因此不是最佳化，而是可行性的前提。
 */
const DEFAULT_MIN_INTERVAL_MS = 12_500;
const DEFAULT_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1_000;

/** token 的剩餘效期低於此值即提前換發，避免請求正好卡在到期瞬間。 */
const EXPIRY_MARGIN_MS = 60_000;

type CachedToken = { value: string; expiresAtMs: number };

/** 5xx 與 429 是伺服器端的暫時狀態；其餘 4xx 是請求本身的問題，重試只會浪費額度。 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** 自行猜測的退避上限。超過此值即視為該次規劃無望，不如早點失敗。 */
const MAX_BACKOFF_MS = 90_000;

/**
 * 伺服器指定的等待秒數。
 *
 * TDX 的 429 回應帶有 `retry-after`（實測為 40 秒）與 `ratelimit-reset`。
 * 自行猜測的指數退避在這個量級上完全不夠——1+2+4+8 秒共 15 秒就放棄，
 * 而伺服器要求等 40 秒。既然它說了，就照它說的等。
 */
function retryAfterMs(res: Response): number | undefined {
  for (const header of ["retry-after", "ratelimit-reset"]) {
    const raw = res.headers.get(header);
    if (!raw) continue;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
  }
  return undefined;
}

export function createTdxClient(options: TdxClientOptions): TdxClient {
  const {
    credentials,
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  } = options;

  let token: CachedToken | undefined;
  let inFlightAuth: Promise<CachedToken> | undefined;
  let nextAllowedAtMs = 0;

  /** 讓所有外送請求共用一條時間線，避免並發時一起衝出去。 */
  async function throttle(): Promise<void> {
    const wait = nextAllowedAtMs - now();
    if (wait > 0) await sleep(wait);
    nextAllowedAtMs = now() + minIntervalMs;
  }

  /**
   * 換發 token。認證與資料查詢走同一台主機，spike 期間該主機出現過連線逾時，
   * 因此連線層失敗與 5xx 同樣要重試；但金鑰被拒（4xx）重試幾次都是錯的。
   */
  async function requestToken(): Promise<CachedToken> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await throttle();

      let res: Response;
      try {
        res = await fetchImpl(AUTH_URL, {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
          }),
        });
      } catch (cause) {
        lastError = new Error("TDX 認證失敗：無法連線", { cause });
        if (attempt === maxAttempts) break;
        await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }

      if (res.ok) {
        const body = (await res.json()) as { access_token: string; expires_in: number };
        return { value: body.access_token, expiresAtMs: now() + body.expires_in * 1000 };
      }

      // 訊息中絕不帶入金鑰內容——它會進日誌。
      lastError = new Error(
        `TDX 認證失敗：HTTP ${res.status}。請確認 TDX_CLIENT_ID 與 TDX_CLIENT_SECRET。`,
      );
      if (!isRetryableStatus(res.status) || attempt === maxAttempts) break;
      await sleep(retryAfterMs(res) ?? BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }

    throw lastError ?? new Error("TDX 認證失敗");
  }

  /**
   * 取得可用的 token。並發呼叫共用同一個換發請求——各自去換會在規劃開始時
   * 送出一批重複的認證請求，白白吃掉速率額度。
   */
  async function getToken(forceRefresh = false): Promise<string> {
    if (forceRefresh) token = undefined;
    if (token && now() < token.expiresAtMs - EXPIRY_MARGIN_MS) return token.value;

    inFlightAuth ??= requestToken().finally(() => {
      inFlightAuth = undefined;
    });

    token = await inFlightAuth;
    return token.value;
  }

  async function get<T>(path: string, base: TdxBase): Promise<T> {
    const url = `${TDX_BASES[base]}${path}`;
    let refreshedOn401 = false;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const bearer = await getToken();
      await throttle();

      let res: Response;
      try {
        res = await fetchImpl(url, {
          cache: "no-store",
          headers: { authorization: `Bearer ${bearer}`, "accept-encoding": "gzip" },
        });
      } catch (cause) {
        // 連線層失敗（逾時、DNS）。這條路徑與「回了非 200」不同，兩者都必須接住。
        lastError = new Error(`TDX 請求失敗：${path}`, { cause });
        if (attempt === maxAttempts) break;
        await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }

      if (res.ok) return (await res.json()) as T;

      // token 可能在宣告的效期之前就被伺服器端作廢，本地的過期判斷不會觸發。
      // 只換發一次；若換了新 token 仍是 401，那是權限問題而非過期。
      if (res.status === 401 && !refreshedOn401) {
        refreshedOn401 = true;
        await getToken(true);
        continue;
      }

      // TDX 的 4xx 會在 body 裡說明原因（例：$top 超過該端點上限）。
      // 丟掉它等於把唯一的線索丟掉——spike 期間就為此多繞了一次路。
      lastError = new Error(
        `TDX 請求失敗：${path} 回傳 HTTP ${res.status}${detail(await safeText(res))}`,
      );
      if (!isRetryableStatus(res.status) || attempt === maxAttempts) break;
      await sleep(retryAfterMs(res) ?? BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }

    throw lastError ?? new Error(`TDX 請求失敗：${path}`);
  }

  async function getList<T>(path: string, base: TdxBase, collectionKey?: string): Promise<T[]> {
    return unwrapList<T>(await get<unknown>(path, base), collectionKey);
  }

  return { get, getList };
}
