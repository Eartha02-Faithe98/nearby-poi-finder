/**
 * 快照：離線預抓的資料集。
 *
 * design D6 修正後，靜態資料一律移出請求路徑——TDX 的實測額度是每分鐘 5 次，
 * 即時查詢連一次地點名稱解析都要 8 分鐘（spike-notes 3.3）。三個來源
 * （TDX、環境部公廁、OSM 營業時間）因此共用同一套快照機制。
 *
 * 本模組刻意不標 `server-only`：離線預抓指令稿要寫入這個形狀，
 * 執行期的載入器要讀取它，兩邊必須共用同一份定義。
 */

export type SnapshotMeta = {
  /** 資料來源識別，例如 "tdx"、"moenv"、"osm"。 */
  source: string;
  /** 資料集名稱，同一來源可有多個。 */
  dataset: string;
  /** 取回時間（ISO 8601）。新鮮度判斷的依據。 */
  fetchedAt: string;
  /** 資料列數。載入時可用以偵測檔案截斷。 */
  rowCount: number;
  /**
   * 授權標示。
   *
   * 不是裝飾——OSM 的 ODbL 要求標示出處，而 `nearby-search` spec 的
   * 「資料出處標示」需求要求介面顯示它。把它綁在資料旁邊，
   * 而不是散在呈現層的某處硬編碼，才不會在新增來源時漏掉。
   */
  attribution: string;
};

export type Snapshot<TRow> = SnapshotMeta & { rows: TRow[] };

/** 各資料集的授權標示文字。 */
export const ATTRIBUTIONS = {
  tdx: "資料來源：交通部 TDX 運輸資料流通服務平臺",
  moenv: "資料來源：環境部環境資料開放平臺「全國公廁建檔資料」（政府資料開放授權條款第 1 版）",
  osm: "資料來源：OpenStreetMap contributors（ODbL）",
} as const;

export function buildSnapshot<TRow>(
  meta: Omit<SnapshotMeta, "rowCount">,
  rows: TRow[],
): Snapshot<TRow> {
  return { ...meta, rowCount: rows.length, rows };
}
