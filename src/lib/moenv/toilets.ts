import type { Poi } from "@/lib/domain";

/**
 * 環境部公廁快照的資料列與其座標聚合（tasks 3.7、design D8）。
 *
 * 不標 `server-only`：預抓指令稿要寫出這個形狀，執行期要讀它，兩邊共用同一份定義。
 */

/**
 * 快照的資料列，與預抓指令稿共用。
 *
 * **只留用得到的欄位。** 保存全部 14 個原始欄位的快照是 18.7 MB，
 * 而 county／village／administration／exec／areacode／type2 在本專案沒有任何用途。
 * 快照會隨程式碼部署進 Vercel 的函式打包，每一 MB 都是冷啟動成本。
 */
export type ToiletRow = {
  /** 環境部的建檔編號，全域唯一。 */
  id: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
  /** 男廁所／女廁所／無障礙廁所／混合廁所／親子廁所／性別友善廁所。 */
  type: string;
  /** 清潔等級：特優級／優等級／普通級／不合格。 */
  grade: string;
  /** 是否有尿布台。 */
  diaper: boolean;
};

/**
 * 聚合後的單一地點。
 *
 * 設施型別由「每列一種」收斂為「一個地點的屬性集合」——這是 design D8 的強制條件：
 * 45,787 列實為 24,965 個地點，不聚合的話附近搜尋會回傳整棟大樓每層樓的男女廁。
 */
export type ToiletPoi = Poi & {
  category: "restroom";
  /** 該座標所有列的設施型別聯集，依原始列的順序，不重複。 */
  facilityTypes: string[];
  /** 任一列標示有尿布台。 */
  diaper: boolean;
  /** 該座標各列中**最差**的清潔等級。 */
  grade: string;
  /** 合併前的列數。170 代表那個座標上有 170 間廁所（新北市政府）。 */
  mergedRowCount: number;
};

/** 由差到好。不在表上的值（含空字串）視為最差，寧可低報也不高報。 */
const GRADE_ORDER = ["不合格", "普通級", "優等級", "特優級"];

function worseGrade(a: string, b: string): string {
  return GRADE_ORDER.indexOf(a) <= GRADE_ORDER.indexOf(b) ? a : b;
}

/** 共同前綴，用來把「◯◯站男」「◯◯站女」「◯◯站無障礙」還原成「◯◯站」。 */
function commonPrefix(names: string[]): string {
  let prefix = names[0];
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.replace(/[\s\-_(（[【,、/]+$/, "").trim();
}

/**
 * 依座標聚合公廁資料列。
 *
 * ponytail: 以**完全相同的座標**分群，不做空間分群。已知天花板：同一處但座標差幾公尺的
 * 兩列不會合併。實測 45,787 列可聚成 24,965 群，與環境部的不重複座標數一致，
 * 表示建檔時同一地點確實共用同一組座標。升級路徑：真的出現鄰近重複再改為網格分群。
 *
 * 亦不快取結果：全量聚合實測 171 ms。若附近搜尋每次請求都重跑會太慢，
 * 屆時以快照物件為鍵做記憶化即可（tasks 4.1）。
 */
export function aggregateToilets(rows: ToiletRow[]): ToiletPoi[] {
  const groups = new Map<string, ToiletRow[]>();
  for (const row of rows) {
    const key = `${row.lat},${row.lon}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.values()].map((group) => {
    const [first] = group;
    // 極少數座標上是不同場所（例：寶雅與派出所共用一個點），此時無共同前綴，
    // 退回第一列的名稱而不是留下空字串或半截字。
    const name = group.length > 1 ? commonPrefix(group.map((row) => row.name)) : first.name;

    return {
      id: first.id,
      name: name.length >= 2 ? name : first.name,
      category: "restroom",
      coordinate: { lat: first.lat, lon: first.lon },
      ...(first.address ? { address: first.address } : {}),
      facilityTypes: [...new Set(group.map((row) => row.type).filter(Boolean))],
      diaper: group.some((row) => row.diaper),
      grade: group.map((row) => row.grade).reduce(worseGrade),
      mergedRowCount: group.length,
    };
  });
}
