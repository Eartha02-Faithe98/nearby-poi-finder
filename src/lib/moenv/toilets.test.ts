import { describe, expect, it } from "vitest";

import { aggregateToilets, type ToiletRow } from "@/lib/moenv/toilets";

/** 中油濱江站：實際資料中最典型的一組——同一座標、男／女／無障礙各一列。 */
const GAS_STATION: ToiletRow[] = [
  {
    id: "A010000003",
    name: "台灣中油濱江大直橋加油加氣站男",
    address: "臺北市松山區莊敬里濱江街373號",
    lat: 25.072592,
    lon: 121.551928,
    type: "男廁所",
    grade: "特優級",
    diaper: false,
  },
  {
    id: "A010001285",
    name: "台灣中油濱江大直橋加油加氣站女",
    address: "臺北市松山區莊敬里濱江街373號",
    lat: 25.072592,
    lon: 121.551928,
    type: "女廁所",
    grade: "特優級",
    diaper: true,
  },
  {
    id: "A010001286",
    name: "台灣中油濱江大直橋加油加氣站無障礙",
    address: "臺北市松山區莊敬里濱江街373號",
    lat: 25.072592,
    lon: 121.551928,
    type: "無障礙廁所",
    grade: "優等級",
    diaper: false,
  },
];

function row(overrides: Partial<ToiletRow> & Pick<ToiletRow, "id">): ToiletRow {
  return {
    name: "某公廁",
    address: "某地",
    lat: 25,
    lon: 121,
    type: "混合廁所",
    grade: "特優級",
    diaper: false,
    ...overrides,
  };
}

describe("aggregateToilets", () => {
  it("同一座標的男廁／女廁／無障礙合併為單一地點，設施型別成為其屬性", () => {
    const places = aggregateToilets(GAS_STATION);

    // 不合併的話，在加油站旁查廁所會得到三筆指向同一個點的結果（design D8）。
    expect(places).toHaveLength(1);
    expect(places[0].facilityTypes).toEqual(["男廁所", "女廁所", "無障礙廁所"]);
    expect(places[0].coordinate).toEqual({ lat: 25.072592, lon: 121.551928 });
    expect(places[0].category).toBe("restroom");
    expect(places[0].mergedRowCount).toBe(3);
  });

  it("合併後的名稱去掉男／女／無障礙的區別，保留共同的場所名", () => {
    expect(aggregateToilets(GAS_STATION)[0].name).toBe("台灣中油濱江大直橋加油加氣站");
  });

  it("同座標但不同場所（無共同前綴）時退回第一列的名稱，不留下空名稱", () => {
    const places = aggregateToilets([
      row({ id: "1", name: "寶雅POYA民生分公司" }),
      row({ id: "2", name: "三民派出所男女" }),
    ]);

    expect(places).toHaveLength(1);
    expect(places[0].name).toBe("寶雅POYA民生分公司");
  });

  it("任一列有尿布台即視為該地點有尿布台", () => {
    expect(aggregateToilets(GAS_STATION)[0].diaper).toBe(true);
  });

  it("清潔等級取最差的一級，避免以其中一間的評等高報整個地點", () => {
    expect(aggregateToilets(GAS_STATION)[0].grade).toBe("優等級");
    // 不在等級表上的值（實測有 8 筆未設定）同樣視為最差，寧可低報。
    expect(
      aggregateToilets([row({ id: "1", grade: "特優級" }), row({ id: "2", grade: "" })])[0].grade,
    ).toBe("");
  });

  it("座標不同的列不合併，即使名稱與地址相同", () => {
    const places = aggregateToilets([
      row({ id: "1", lat: 25, lon: 121 }),
      row({ id: "2", lat: 25.0001, lon: 121 }),
    ]);

    expect(places).toHaveLength(2);
  });

  it("重複的設施型別只出現一次", () => {
    const places = aggregateToilets([
      row({ id: "1", type: "男廁所" }),
      row({ id: "2", type: "男廁所" }),
      row({ id: "3", type: "女廁所" }),
    ]);

    expect(places[0].facilityTypes).toEqual(["男廁所", "女廁所"]);
  });
});
