import { describe, expect, it } from "vitest";

import type { Poi } from "@/lib/domain";
import {
  applyOpeningHours,
  createOsmIndex,
  excludeDuplicates,
  MATCH_RADIUS_METERS,
  normalizeName,
} from "@/lib/osm/match";
import type { OsmPlaceRow } from "@/lib/osm/pois";

const CENTER = { lat: 25.0339, lon: 121.5645 };

/** 由中心往北移動指定公尺數。緯度一度約 111 公里。 */
const north = (metres: number) => ({ lat: CENTER.lat + metres / 111_000, lon: CENTER.lon });

function tdxPoi(name: string, coordinate = CENTER): Poi {
  return { id: `TDX_${name}`, name, category: "food", coordinate };
}

function osmRow(name: string, overrides: Partial<OsmPlaceRow> = {}): OsmPlaceRow {
  return { id: `node/${name}`, name, lat: CENTER.lat, lon: CENTER.lon, ...overrides };
}

const OPEN_DAILY = "Mo-Su 11:00-21:00";

function enrich(pois: Poi[], rows: OsmPlaceRow[]) {
  return applyOpeningHours(pois, createOsmIndex(rows));
}

describe("createOsmIndex", () => {
  it("名稱相同且在半徑內即比對成功", () => {
    const index = createOsmIndex([osmRow("鼎泰豐", { openingHours: OPEN_DAILY })]);
    expect(index.findMatch("鼎泰豐", north(50))?.name).toBe("鼎泰豐");
  });

  it("名稱相同但超出半徑不算比對成功", () => {
    // 同名不同店（連鎖）是這條界線存在的理由：把隔壁分店的營業時間套上去，
    // 比沒有營業時間更糟——那會通過可行性驗證，然後讓使用者吃閉門羹。
    const index = createOsmIndex([osmRow("鼎泰豐", { openingHours: OPEN_DAILY })]);
    expect(index.findMatch("鼎泰豐", north(MATCH_RADIUS_METERS + 50))).toBeUndefined();
  });

  it("台／臺、空白與括號的寫法差異不影響比對", () => {
    const index = createOsmIndex([osmRow("台北 101 觀景台")]);
    expect(index.findMatch("臺北101觀景臺", CENTER)?.name).toBe("台北 101 觀景台");
    expect(normalizeName("台北 101 觀景台")).toBe(normalizeName("臺北101觀景臺"));
  });

  it("名稱互相包含也算比對成功：分店名與副標題是兩邊命名習慣的主要差異", () => {
    const index = createOsmIndex([osmRow("龍情花生"), osmRow("甘泉魚麵埔心店")]);
    expect(index.findMatch("龍情花生軟糖(龍潭總店)", CENTER)?.name).toBe("龍情花生");
    expect(index.findMatch("甘泉魚麵", CENTER)?.name).toBe("甘泉魚麵埔心店");
  });

  it("完全相同優先於互相包含", () => {
    const index = createOsmIndex([
      osmRow("甘泉魚麵埔心店", { lat: CENTER.lat }),
      osmRow("甘泉魚麵", { ...north(100) }),
    ]);
    expect(index.findMatch("甘泉魚麵", CENTER)?.name).toBe("甘泉魚麵");
  });

  it("兩個字以下的名稱不做包含比對", () => {
    // 「城」能包進上百個店名，這種比對只會製造錯誤的營業時間。
    const index = createOsmIndex([osmRow("古城牛肉麵")]);
    expect(index.findMatch("古城", CENTER)).toBeUndefined();
  });

  it("多個候選時取距離最近的", () => {
    const index = createOsmIndex([
      osmRow("鼎泰豐", { id: "far", ...north(150) }),
      osmRow("鼎泰豐", { id: "near", ...north(20) }),
    ]);
    expect(index.findMatch("鼎泰豐", CENTER)?.id).toBe("near");
  });
});

describe("applyOpeningHours", () => {
  it("比對成功時套用營業時間並標示出處為 OSM", () => {
    const [poi] = enrich([tdxPoi("鼎泰豐")], [osmRow("鼎泰豐", { openingHours: OPEN_DAILY })]);

    expect(poi.openingHours?.[1]).toEqual([{ start: "11:00", end: "21:00" }]);
    // 出處要標到單筆地點上，spec 才能據此在介面標示 ODbL。
    expect(poi.usesOsmData).toBe(true);
  });

  it.each([
    ["比對不到", [osmRow("其他店家", { openingHours: OPEN_DAILY })]],
    ["對到的 OSM 地點沒有營業時間", [osmRow("鼎泰豐")]],
    ["OSM 的營業時間字串解不出來", [osmRow("鼎泰豐", { openingHours: "12hr" })]],
  ])("%s 時，地點仍回傳且營業時間維持未知", (_case, rows) => {
    const result = enrich([tdxPoi("鼎泰豐")], rows);

    // 略過這筆會讓使用者以為這家店不存在；填一個猜的營業時間會讓引擎排錯時間。
    // 兩份 spec 的要求都是第三條路：留著，標未知。
    expect(result).toHaveLength(1);
    expect(result[0].openingHours).toBeUndefined();
    expect(result[0].usesOsmData).toBeUndefined();
  });

  it("地點原本就有營業時間時不被 OSM 覆寫", () => {
    const poi: Poi = {
      ...tdxPoi("鼎泰豐"),
      openingHours: { 0: [], 1: [{ start: "09:00", end: "17:00" }], 2: [], 3: [], 4: [], 5: [], 6: [] },
    };
    const [result] = enrich([poi], [osmRow("鼎泰豐", { openingHours: OPEN_DAILY })]);

    expect(result.openingHours?.[1]).toEqual([{ start: "09:00", end: "17:00" }]);
    expect(result.usesOsmData).toBeUndefined();
  });

  it("不改變地點的筆數與順序", () => {
    const pois = [tdxPoi("甲"), tdxPoi("乙"), tdxPoi("丙")];
    expect(enrich(pois, []).map((p) => p.name)).toEqual(["甲", "乙", "丙"]);
  });
});

describe("excludeDuplicates（tasks 3.12）", () => {
  const osmPoi = (name: string, coordinate = CENTER): Poi & { usesOsmData: true } => ({
    id: `node/${name}`,
    name,
    category: "food",
    coordinate,
    usesOsmData: true,
  });

  it("同一家店不因為來自兩個資料源而出現兩次", () => {
    const kept = excludeDuplicates([osmPoi("鼎泰豐")], [tdxPoi("鼎泰豐")]);
    expect(kept).toEqual([]);
  });

  it("分店名與副標題的差異仍算同一家店", () => {
    const kept = excludeDuplicates(
      [osmPoi("龍情花生")],
      [tdxPoi("龍情花生軟糖(龍潭總店)")],
    );
    expect(kept).toEqual([]);
  });

  it("同名但相距超過比對半徑的是不同分店，兩筆都要留", () => {
    // 連鎖店在同一條街上有兩家分店是常態。把它們併成一筆，使用者就會被導到
    // 比較遠的那一家。
    const kept = excludeDuplicates(
      [osmPoi("清心福全", north(MATCH_RADIUS_METERS + 50))],
      [tdxPoi("清心福全")],
    );
    expect(kept.map((p) => p.name)).toEqual(["清心福全"]);
  });

  it("另一個資料源才有的店家全部保留", () => {
    const kept = excludeDuplicates([osmPoi("巷口紅茶冰"), osmPoi("鼎泰豐")], [tdxPoi("鼎泰豐")]);
    expect(kept.map((p) => p.name)).toEqual(["巷口紅茶冰"]);
  });

  it("既有清單為空時不動任何候選", () => {
    const kept = excludeDuplicates([osmPoi("甲"), osmPoi("乙")], []);
    expect(kept.map((p) => p.name)).toEqual(["甲", "乙"]);
  });
});
