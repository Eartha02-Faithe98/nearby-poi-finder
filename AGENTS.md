<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# nearby-poi-finder

台灣旅遊行程規劃工具。使用者以自然語言描述需求，系統產出**逐時段、交通實際可行**的多日行程；
另提供八大類（美食／飲料／停車場／廁所／景點／飯店／交通／伴手禮）附近搜尋。
核心差異化：行程表由程式驗證過可行，不由 LLM 生成；交通銜接是 TDX 的真實班次，不是估算車程。

## 先讀這些，不要憑對話記憶

本專案以 **OpenSpec** 管理。所有決策與現況都在檔案裡，沒有只存在對話中的狀態。

| 檔案 | 內容 |
|---|---|
| `openspec/changes/taiwan-trip-planner/proposal.md` | 為什麼做、範圍與 Non-goals |
| `openspec/changes/taiwan-trip-planner/specs/*/spec.md` | 四個 capability 的行為契約（需求 + scenario） |
| `openspec/changes/taiwan-trip-planner/design.md` | 技術決策 D1–D7、風險、Open Questions |
| `openspec/changes/taiwan-trip-planner/tasks.md` | 實作任務與進度勾選 |
| `openspec/changes/taiwan-trip-planner/spike-notes.md` | **API 實測結果。TDX 的正確端點只有這裡是對的。** |
| `openspec/config.yaml` 的 `context` | 專案約束，openspec 產生 artifact 時會讀 |

進度以 `openspec status --change taiwan-trip-planner` 為準。

## 已知陷阱

- **網路上所有 TDX 教學的端點都是舊的。** `ScenicSpot` 已改名 `Attraction`，base 也換了。
  正確值只信 `spike-notes.md` 的 1.1 節。
- **TDX 速率限制遠比文件嚴格**：文件說 50 req/s，實測數秒內 6 個請求就 429。探測時要加延遲。
- **port 3000 被本機另一個專案長期佔用**，開發請用其他 port（例：`npx next dev -p 3100`）。
- **Skill 工具被 ASUS 的 skill vetter 擋住**（allowlist 只放行一個）。需要用 openspec 的
  workflow 時，直接用 Bash 讀 `.claude/skills/openspec-*/SKILL.md` 再照做。

## 指令

```bash
npm test                  # vitest
npm run lint              # eslint src scripts
npm run check:no-secrets  # 以哨兵值建置，掃描送到瀏覽器的產物是否含伺服器端機密
node --env-file=.env.local scripts/tdx-spike.mjs   # TDX 連線煙霧測試
```

`.env.local` 需要 `TDX_CLIENT_ID`、`TDX_CLIENT_SECRET`（已設定）與 `GEMINI_API_KEY`（尚未設定，
任務 6.4 才需要）。
