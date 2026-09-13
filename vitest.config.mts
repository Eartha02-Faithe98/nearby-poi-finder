import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// ponytail: 釘在 vitest 4。vitest 5 的執行管線需要 rolldown 的 win32 原生 binding，
// 而該 binding 走 npm optional dependency，在本機只有整個砍掉 node_modules 重裝才會
// 出現——單純 npm install 或任何 npm uninstall 之後就會消失，等於每次變更依賴都要
// 重裝一次。vitest 4 不需要該 binding。
// 升級路徑：待 npm optional dependency 安裝穩定後再評估 vitest 5。
export default defineConfig({
  resolve: {
    // Vite 原生解析 tsconfig 的 paths，不需 vite-tsconfig-paths 外掛。
    tsconfigPaths: true,
    alias: {
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mts"],
  },
});
