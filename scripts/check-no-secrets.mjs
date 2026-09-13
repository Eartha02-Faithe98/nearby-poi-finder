// 以可辨識的哨兵值建置，再掃描送到瀏覽器的檔案。
// 若哨兵出現在其中，代表某個伺服器端機密被送到了瀏覽器。
//
// 要確認本檢查仍具偵測能力，建立一個 server component 讀取 serverEnv() 並將值
// 當成 prop 傳給 client component，然後執行本腳本——應以 exit 1 失敗。
// 注意：單純在 client component 中引用 process.env.TDX_CLIENT_ID 不會觸發，
// 因為 Next.js 只內嵌 NEXT_PUBLIC_ 前綴的變數，其餘會被替換為 undefined。
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SENTINELS = {
  TDX_CLIENT_ID: "SENTINEL_TDX_ID_5f3a91",
  TDX_CLIENT_SECRET: "SENTINEL_TDX_SECRET_5f3a91",
  GEMINI_API_KEY: "SENTINEL_GEMINI_KEY_5f3a91",
};

// 會送到瀏覽器的產物：
//  - .next/static  → client JS/CSS bundle
//  - .next/server/app 底下的 .html 與 .rsc → 預渲染 HTML 與 RSC payload，兩者皆直接送給瀏覽器
// .next/server 的 .js 伺服器端 chunk 含有機密是正常的，不掃描。
const CLIENT_DIRS = [".next/static", ".next/server/app"];
const BROWSER_FACING = /\.(html|rsc|js|css|json|txt)$/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

console.log("Building with sentinel secrets...");
execFileSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
  stdio: "inherit",
  env: { ...process.env, ...SENTINELS },
});

const leaks = [];
for (const dir of CLIENT_DIRS) {
  for (const file of walk(dir)) {
    if (file.startsWith(".next\server") || file.startsWith(".next/server")) {
      if (!/\.(html|rsc)$/.test(file)) continue;
    } else if (!BROWSER_FACING.test(file)) {
      continue;
    }
    const content = readFileSync(file, "utf8");
    for (const [name, sentinel] of Object.entries(SENTINELS)) {
      if (content.includes(sentinel)) leaks.push({ name, file });
    }
  }
}

if (leaks.length > 0) {
  console.error("\n✗ 伺服器端機密洩漏至 client bundle：");
  for (const { name, file } of leaks) console.error(`  ${name} -> ${file}`);
  process.exit(1);
}

console.log(`\n✓ client bundle 中未發現任何伺服器端機密（掃描 ${CLIENT_DIRS.join(", ")}）`);
