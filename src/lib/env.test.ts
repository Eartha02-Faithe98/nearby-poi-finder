import { describe, expect, it } from "vitest";

import { loadServerEnv } from "@/lib/env";

const COMPLETE = {
  TDX_CLIENT_ID: "id",
  TDX_CLIENT_SECRET: "secret",
  GEMINI_API_KEY: "gemini",
};

describe("loadServerEnv", () => {
  it("returns typed config when every required variable is present", () => {
    expect(loadServerEnv(COMPLETE)).toEqual({
      tdxClientId: "id",
      tdxClientSecret: "secret",
      geminiApiKey: "gemini",
    });
  });

  // 缺三個變數時，分三次啟動才逐一發現是浪費；一次列出全部才有意義。
  it("names every missing variable in one error, not just the first", () => {
    const call = () => loadServerEnv({ TDX_CLIENT_ID: "id" });

    expect(call).toThrowError(/TDX_CLIENT_SECRET/);
    expect(call).toThrowError(/GEMINI_API_KEY/);
  });

  // 空字串與空白是設定漏填的常見形式，必須與「未設定」同等對待，
  // 否則會帶著空金鑰啟動，直到第一次呼叫 API 才以難解的 401 失敗。
  it("treats blank and whitespace-only values as missing", () => {
    expect(() => loadServerEnv({ ...COMPLETE, GEMINI_API_KEY: "" })).toThrowError(
      /GEMINI_API_KEY/,
    );
    expect(() => loadServerEnv({ ...COMPLETE, TDX_CLIENT_ID: "   " })).toThrowError(
      /TDX_CLIENT_ID/,
    );
  });

  it("trims surrounding whitespace from accepted values", () => {
    expect(loadServerEnv({ ...COMPLETE, TDX_CLIENT_ID: "  id  " }).tdxClientId).toBe("id");
  });

  it("points the reader at .env.example so the fix is obvious", () => {
    expect(() => loadServerEnv({})).toThrowError(/\.env\.example/);
  });
});
