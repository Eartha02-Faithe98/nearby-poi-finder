import "server-only";

/**
 * 伺服器端機密設定。這些值絕不可出現在 client bundle 中，
 * 由頂端的 `server-only` import 在建置時強制。
 */
export type ServerEnv = {
  tdxClientId: string;
  tdxClientSecret: string;
  geminiApiKey: string;
};

const REQUIRED: Record<keyof ServerEnv, string> = {
  tdxClientId: "TDX_CLIENT_ID",
  tdxClientSecret: "TDX_CLIENT_SECRET",
  geminiApiKey: "GEMINI_API_KEY",
};

/**
 * 由給定的來源讀取並驗證伺服器端環境變數。
 * 一次回報所有缺漏的變數名稱，而非遇到第一個就中止——缺三個時分三次才發現很浪費。
 */
export function loadServerEnv(
  source: Record<string, string | undefined> = process.env,
): ServerEnv {
  const missing: string[] = [];
  const result = {} as ServerEnv;

  for (const [key, name] of Object.entries(REQUIRED) as [keyof ServerEnv, string][]) {
    const value = source[name]?.trim();
    if (!value) {
      missing.push(name);
      continue;
    }
    result[key] = value;
  }

  if (missing.length > 0) {
    throw new Error(
      `缺少必要的環境變數：${missing.join("、")}。` +
        `請複製 .env.example 為 .env.local 並填入這些值。`,
    );
  }

  return result;
}

let cached: ServerEnv | undefined;

/** 取得已驗證的伺服器端設定。首次呼叫時驗證，之後回傳快取結果。 */
export function serverEnv(): ServerEnv {
  cached ??= loadServerEnv();
  return cached;
}
