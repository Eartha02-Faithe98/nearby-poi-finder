import { describe, expect, it } from "vitest";

import {
  POI_CATEGORIES,
  type Connection,
  type ConnectionSearchResult,
  type NearbyResult,
  type PoiCategory,
} from "@/lib/domain";

describe("POI_CATEGORIES", () => {
  // 八大類別是產品定義的一部分：少一類就有一種使用者需求無處可去，
  // 多一類則代表有未定義的類別悄悄進入搜尋與行程。
  it("covers exactly the eight categories the specs define", () => {
    expect([...POI_CATEGORIES].sort()).toEqual([
      "attraction",
      "drinks",
      "food",
      "hotel",
      "parking",
      "restroom",
      "souvenir",
      "transport",
    ]);
  });

  it("keeps parking and restroom as first-class categories", () => {
    const firstClass: PoiCategory[] = ["parking", "restroom"];
    for (const category of firstClass) {
      expect(POI_CATEGORIES).toContain(category);
    }
  });
});

describe("NearbyResult", () => {
  // nearby-search spec 要求每筆結果含名稱、類別、座標、距離，
  // 並在資料來源提供時含地址與營業時間。此處以可編譯的完整物件鎖住這組欄位。
  it("carries every field the nearby-search spec requires", () => {
    const result: NearbyResult = {
      id: "tdx-001",
      name: "赤崁樓",
      category: "attraction",
      coordinate: { lat: 22.9977, lon: 120.2024 },
      address: "台南市中西區民族路二段212號",
      openingHours: { 0: [], 1: [{ start: "08:30", end: "21:30" }], 2: [], 3: [], 4: [], 5: [], 6: [] },
      distanceMeters: 320,
    };

    expect(result.distanceMeters).toBe(320);
    expect(result.openingHours?.[1]).toEqual([{ start: "08:30", end: "21:30" }]);
  });

  // 營業時間未知必須能與「全天營業」區分，否則行程會把公休的店排進去。
  it("expresses unknown opening hours as undefined, not as an empty schedule", () => {
    const unknown: NearbyResult = {
      id: "tdx-002",
      name: "某公廁",
      category: "restroom",
      coordinate: { lat: 22.9, lon: 120.2 },
      distanceMeters: 45,
    };

    expect(unknown.openingHours).toBeUndefined();
  });
});

describe("Connection", () => {
  // transit-routing spec 要求大眾運輸分段載明路線識別、上下車地點與實際班次時間，
  // 步行分段載明距離與時間。缺任一欄位，行程就退化成競品那種「車程約 40 分鐘」。
  it("carries real timetable data on transit legs and distance on walk legs", () => {
    const connection: Connection = {
      departureTime: new Date("2026-10-03T10:05:00+08:00"),
      arrivalTime: new Date("2026-10-03T10:41:00+08:00"),
      totalDurationMinutes: 36,
      legs: [
        {
          mode: "walk",
          from: { lat: 22.9971, lon: 120.2126 },
          to: { lat: 22.9968, lon: 120.2119 },
          distanceMeters: 180,
          durationMinutes: 3,
        },
        {
          mode: "transit",
          routeName: "2",
          boardStopName: "台南火車站",
          alightStopName: "安平古堡",
          departureTime: new Date("2026-10-03T10:08:00+08:00"),
          arrivalTime: new Date("2026-10-03T10:41:00+08:00"),
        },
      ],
    };

    const transit = connection.legs.find((leg) => leg.mode === "transit");
    expect(transit?.routeName).toBe("2");
    expect(transit?.departureTime.toISOString()).toBe("2026-10-03T02:08:00.000Z");
  });
});

describe("ConnectionSearchResult", () => {
  // 查無方案時規格要求不得回傳估算值。union 的 found:false 分支沒有任何
  // 可放估算值的欄位——這條需求因此在型別層就無法被違反。
  it("offers nowhere to put an estimate when no connection was found", () => {
    const notFound: ConnectionSearchResult = { found: false };

    expect(notFound.found).toBe(false);
    expect(Object.keys(notFound)).toEqual(["found"]);
  });
});
