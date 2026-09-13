import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * 把預抓快照納入部署產物。
   *
   * 快照以 `fs` 於執行期讀取（見 `src/lib/snapshot/load.ts`），而 Next.js 的
   * 檔案追蹤只會納入它從 import 推導得出的相依——以路徑字串讀取的檔案推導不到。
   * 少了這段設定，本機正常但正式環境會在第一次查詢時才失敗。
   *
   * **尚未於實際部署驗證**：目前還沒有任何 API route（tasks 4.1）。
   * 先寫在這裡是因為漏掉它會變成只在正式環境出現的錯誤，很難回頭聯想到原因。
   */
  outputFileTracingIncludes: {
    "/api/**": ["./data/snapshots/**"],
  },
};

export default nextConfig;
