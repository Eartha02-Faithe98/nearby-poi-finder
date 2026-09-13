import { describe, expect, it } from "vitest";

import { POI_CATEGORIES } from "@/lib/domain";
import {
  isTdxServed,
  SOUVENIR_ATTRACTION_CODES,
  SOUVENIR_CUISINE_CODES,
  TDX_SERVED_CATEGORIES,
  cityPathName,
  normalizeCityName,
  swapTaiwanCharacter,
} from "@/lib/tdx/catalog";
import type { TdxBase, TdxClient } from "@/lib/tdx/client";
import { createTdxPoiProvider, NEARBY_MAX_DISTANCE_METERS } from "@/lib/tdx/poi-provider";

const TAINAN_STATION = { lat: 22.99681, lon: 120.21295 };

/** 記錄每個請求路徑並依序比對回應，讓測試能斷言「打了幾次、打了什麼」。 */
function fakeClient(routes: { match: RegExp; body: unknown }[]) {
  const paths: string[] = [];
  const respond = (path: string): unknown => {
    const route = routes.find((r) => r.match.test(path));
    if (!route) throw new Error(`unstubbed TDX path: ${path}`);
    return route.body;
  };
  const client: TdxClient = {
    async get<T>(path: string) {
      paths.push(path);
      return respond(path) as T;
    },
    async getList<T>(path: string, _base: TdxBase, collectionKey?: string) {
      paths.push(path);
      const body = respond(path);
      if (Array.isArray(body)) return body as T[];
      const record = body as Record<string, unknown>;
      const rows = collectionKey ? record[collectionKey] : record.value;
      return (Array.isArray(rows) ? rows : []) as T[];
    },
  };
  return { client, paths };
}

const NEARBY_BODY = {
  RelationClass: "Nearby",
  RelatedAttractions: [
    { AttractionID: "A1", AttractionName: "臺灣府城城垣殘蹟", PositionLat: 22.99958, PositionLon: 120.21819 },
  ],
  RelatedRestaurants: [
    { RestaurantID: "R1", RestaurantName: "廣興肉脯店", PositionLat: 22.99025, PositionLon: 120.20929 },
  ],
  RelatedHotels: [
    { HotelID: "H1", HotelName: "英代大飯店", PositionLat: 22.998173, PositionLon: 120.206109 },
  ],
  RelatedTraRailStations: [
    { StationUID: "TRA-4220", StationName: "臺南", PositionLat: 22.99681, PositionLon: 120.21295 },
  ],
  RelatedCityCarParks: [
    { CarParkID: "P1", CarParkName: "竑穗興濟二站停車場", PositionLat: 22.99743, PositionLon: 120.20531 },
  ],
};

const nearbyRoute = { match: /^\/Nearby/, body: NEARBY_BODY };

describe("TDX 供應的類別範圍", () => {
  // 八大類中缺兩類是資料現實，不是疏漏：TDX 沒有廁所、也沒有手搖飲。
  // 這條測試存在的意義是：若有人日後把 drinks 或 restroom 加進來，
  // 必須同時面對「資料從哪來」這個問題，而不是讓它悄悄回空陣列。
  it("serves six of the eight categories, and says which two it does not", () => {
    expect([...TDX_SERVED_CATEGORIES].sort()).toEqual(
      ["attraction", "food", "hotel", "parking", "souvenir", "transport"].sort(),
    );

    const unserved = POI_CATEGORIES.filter((c) => !isTdxServed(c));
    expect([...unserved].sort()).toEqual(["drinks", "restroom"]);
  });
});

describe("縣市名正規化", () => {
  // 「台」與「臺」使用者兩種都會打，而 TDX 一律用「臺」。
  // 不處理的話「台南市」查無結果、「臺南市」正常，這對使用者毫無道理。
  it("treats 台 and 臺 as the same city", () => {
    expect(normalizeCityName("台南市")).toBe("臺南市");
    expect(cityPathName("台南市")).toBe("Tainan");
    expect(cityPathName("臺南市")).toBe("Tainan");
  });

  it("returns nothing for a name that is not a Taiwanese city", () => {
    expect(cityPathName("東京都")).toBeUndefined();
  });
});

describe("searchNearby", () => {
  // /Nearby 一次回傳所有類別的集合。多類別查詢若打成多次請求，
  // 會直接抵觸 design D6 的呼叫預算。
  it("answers a multi-category query with a single TDX request", async () => {
    const { client, paths } = fakeClient([nearbyRoute]);

    const results = await createTdxPoiProvider(client).searchNearby({
      center: TAINAN_STATION,
      categories: ["attraction", "food", "hotel", "parking", "transport"],
      radiusMeters: 1000,
    });

    expect(paths).toHaveLength(1);
    expect(results.map((r) => r.category).sort()).toEqual(
      ["attraction", "food", "hotel", "parking", "transport"].sort(),
    );
  });

  it("maps each collection to the right category", async () => {
    const { client } = fakeClient([nearbyRoute]);

    const results = await createTdxPoiProvider(client).searchNearby({
      center: TAINAN_STATION,
      categories: [...POI_CATEGORIES].filter((c) => c !== "souvenir"),
      radiusMeters: 1000,
    });

    const byId = Object.fromEntries(results.map((r) => [r.id, r.category]));
    expect(byId).toMatchObject({
      A1: "attraction",
      R1: "food",
      H1: "hotel",
      "TRA-4220": "transport",
      P1: "parking",
    });
  });

  // spec 的「結果排序」要求依距離由近至遠，且每筆標示距離。
  it("returns results sorted by ascending distance with the distance attached", async () => {
    const { client } = fakeClient([nearbyRoute]);

    const results = await createTdxPoiProvider(client).searchNearby({
      center: TAINAN_STATION,
      categories: ["attraction", "food", "hotel", "parking", "transport"],
      radiusMeters: 1000,
    });

    const distances = results.map((r) => r.distanceMeters);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(distances.every((d) => Number.isFinite(d))).toBe(true);
    // 查詢中心就是台南車站，因此該站的距離應為零。
    expect(results[0].id).toBe("TRA-4220");
    expect(results[0].distanceMeters).toBeCloseTo(0, 5);
  });

  // 未支援的類別不得靜默回空——那會與「查無結果」混淆，
  // 而 nearby-search spec 要求查無結果必須是明確的告知。
  it("ignores categories TDX does not serve rather than pretending they are empty", async () => {
    const { client, paths } = fakeClient([nearbyRoute]);

    const results = await createTdxPoiProvider(client).searchNearby({
      center: TAINAN_STATION,
      categories: ["drinks", "restroom"],
      radiusMeters: 1000,
    });

    expect(results).toEqual([]);
    // 完全沒有 TDX 可供應的類別時，不應白打一次請求。
    expect(paths).toHaveLength(0);
  });

  // /Nearby 的 Distance 上限為 1000（spike-notes 1.1）。
  // 超過時若靜默截短，使用者會以為搜過了 3 公里但其實只搜了 1 公里。
  it("refuses a radius beyond what TDX supports instead of silently narrowing it", async () => {
    const { client } = fakeClient([nearbyRoute]);

    await expect(
      createTdxPoiProvider(client).searchNearby({
        center: TAINAN_STATION,
        categories: ["attraction"],
        radiusMeters: NEARBY_MAX_DISTANCE_METERS + 1,
      }),
    ).rejects.toThrowError(/1000/);
  });

  it("skips rows that lack coordinates rather than emitting a broken result", async () => {
    const { client } = fakeClient([
      {
        match: /^\/Nearby/,
        body: {
          RelatedAttractions: [
            { AttractionID: "A1", AttractionName: "無座標", PositionLat: null, PositionLon: null },
            { AttractionID: "A2", AttractionName: "有座標", PositionLat: 22.99, PositionLon: 120.21 },
          ],
        },
      },
    ]);

    const results = await createTdxPoiProvider(client).searchNearby({
      center: TAINAN_STATION,
      categories: ["attraction"],
      radiusMeters: 1000,
    });

    expect(results.map((r) => r.id)).toEqual(["A2"]);
  });
});

describe("searchNearby 的伴手禮", () => {
  const souvenirRoutes = [
    ...SOUVENIR_CUISINE_CODES.map((code) => ({
      match: new RegExp(`Restaurant.*c%20eq%20${code}`),
      body: {
        value: [
          {
            RestaurantID: `S-${code}`,
            RestaurantName: `名產店 ${code}`,
            PositionLat: 22.997,
            PositionLon: 120.213,
            PostalAddress: { City: "臺南市", Town: "中西區", StreetAddress: "中山路1號" },
          },
        ],
      },
    })),
    ...SOUVENIR_ATTRACTION_CODES.map((code) => ({
      match: new RegExp(`Attraction.*c%20eq%20${code}`),
      body: { value: [] },
    })),
  ];

  // 伴手禮需要類別代碼，而 /Nearby 的資料列沒有這個欄位（實測）。
  // 這條測試釘住「伴手禮不是從 /Nearby 來的」這個事實。
  it("fetches souvenirs by class code because /Nearby carries no class field", async () => {
    const { client, paths } = fakeClient([nearbyRoute, ...souvenirRoutes]);

    const results = await createTdxPoiProvider(client).searchNearby({
      center: TAINAN_STATION,
      categories: ["souvenir"],
      radiusMeters: 1000,
    });

    expect(paths.some((p) => p.startsWith("/Nearby"))).toBe(false);
    expect(results.every((r) => r.category === "souvenir")).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  // TDX 不提供代碼表，這份對應是實證反推的。代碼語意若變動，
  // 測試必須抓到——否則伴手禮會安靜地變成別的東西。
  it("pins the empirically derived class codes", () => {
    expect([...SOUVENIR_CUISINE_CODES]).toEqual([116, 115, 204]);
    expect([...SOUVENIR_ATTRACTION_CODES]).toEqual([14, 6, 21]);
  });

  // 多個條件以 or 包在 any() 裡 TDX 會回 500，故必須一碼一次查詢。
  it("queries one class code per request, never combining them", async () => {
    const { client, paths } = fakeClient([nearbyRoute, ...souvenirRoutes]);

    await createTdxPoiProvider(client).searchNearby({
      center: TAINAN_STATION,
      categories: ["souvenir"],
      radiusMeters: 1000,
    });

    const filterPaths = paths.filter((p) => p.includes("any"));
    expect(filterPaths).toHaveLength(
      SOUVENIR_CUISINE_CODES.length + SOUVENIR_ATTRACTION_CODES.length,
    );
    expect(filterPaths.every((p) => !p.includes("%20or%20"))).toBe(true);
  });

  it("excludes souvenirs outside the requested radius", async () => {
    const faraway = souvenirRoutes.map((route) =>
      route.match.source.includes("Restaurant")
        ? {
            ...route,
            body: {
              value: [
                {
                  RestaurantID: "S-far",
                  RestaurantName: "台北名產",
                  PositionLat: 25.0478,
                  PositionLon: 121.5171,
                },
              ],
            },
          }
        : route,
    );
    const { client } = fakeClient([nearbyRoute, ...faraway]);

    const results = await createTdxPoiProvider(client).searchNearby({
      center: TAINAN_STATION,
      categories: ["souvenir"],
      radiusMeters: 1000,
    });

    expect(results).toEqual([]);
  });
});

describe("searchByArea", () => {
  it("filters tourism resources by city and carries the assembled address", async () => {
    const { client, paths } = fakeClient([
      {
        match: /^\/Attraction/,
        body: {
          value: [
            {
              AttractionID: "A1",
              AttractionName: "安平古堡",
              PositionLat: 23.00125,
              PositionLon: 120.16083,
              PostalAddress: { City: "臺南市", Town: "安平區", StreetAddress: "國勝路82號" },
            },
          ],
        },
      },
    ]);

    const results = await createTdxPoiProvider(client).searchByArea({
      area: "台南市",
      categories: ["attraction"],
    });

    expect(paths[0]).toContain(encodeURIComponent("contains(PostalAddress/City, '臺南市')"));
    expect(results[0]).toMatchObject({
      id: "A1",
      name: "安平古堡",
      category: "attraction",
      address: "臺南市安平區國勝路82號",
    });
  });

  // 停車場與公車站牌走 /City/{英文名} 的路徑參數，與觀光 API 的中文 $filter 不通用。
  it("uses the English city path for parking and transport endpoints", async () => {
    const { client, paths } = fakeClient([
      {
        match: /Parking/,
        body: {
          CarParks: [
            {
              CarParkID: "P1",
              CarParkName: { Zh_tw: "永康中華立體停車場" },
              CarParkPosition: { PositionLat: 23.00072, PositionLon: 120.23762 },
              Address: "台南市永康區華興街77號",
            },
          ],
        },
      },
      {
        match: /Bus\/Stop/,
        body: [
          {
            StopUID: "TNN10010",
            StopName: { Zh_tw: "西門健康立體停車場" },
            StopPosition: { PositionLat: 22.98237, PositionLon: 120.19756 },
            StopAddress: "台南市南區西門路一段473-499號",
          },
        ],
      },
    ]);

    const results = await createTdxPoiProvider(client).searchByArea({
      area: "臺南市",
      categories: ["parking", "transport"],
    });

    expect(paths.some((p) => p.includes("/City/Tainan"))).toBe(true);
    expect(results.map((r) => r.category).sort()).toEqual(["parking", "transport"]);
    expect(results.find((r) => r.category === "parking")?.name).toBe("永康中華立體停車場");
  });

  // 無法對應到縣市代碼時靜默略過，會被讀成「這個城市沒有停車場」。
  it("fails loudly when the area cannot be mapped to a TDX city code", async () => {
    const { client } = fakeClient([]);

    await expect(
      createTdxPoiProvider(client).searchByArea({ area: "東京都", categories: ["parking"] }),
    ).rejects.toThrowError(/東京都/);
  });
});

describe("geocode", () => {
  const emptyTourism = [
    { match: /^\/Attraction/, body: { value: [] } },
    { match: /^\/Restaurant/, body: { value: [] } },
    { match: /^\/Hotel/, body: { value: [] } },
  ];
  const stationRoute = {
    match: /Rail\/TRA\/Station/,
    body: {
      Stations: [
        {
          StationUID: "TRA-4220",
          StationName: { Zh_tw: "臺南" },
          StationPosition: { PositionLat: 22.99681, PositionLon: 120.21295 },
          StationAddress: "700臺南市中西區北門路二段4號",
        },
        {
          StationUID: "TRA-0900",
          StationName: { Zh_tw: "基隆" },
          StationPosition: { PositionLat: 25.13191, PositionLon: 121.73837 },
        },
      ],
    },
  };

  it("resolves a tourism POI by name", async () => {
    const { client } = fakeClient([
      {
        match: /^\/Attraction/,
        body: {
          value: [
            {
              AttractionID: "A1",
              AttractionName: "安平古堡",
              PositionLat: 23.00125,
              PositionLon: 120.16083,
              PostalAddress: { City: "臺南市", Town: "安平區", StreetAddress: "國勝路82號" },
            },
          ],
        },
      },
      { match: /^\/Restaurant/, body: { value: [] } },
      { match: /^\/Hotel/, body: { value: [] } },
      stationRoute,
    ]);

    const matches = await createTdxPoiProvider(client).geocode("安平古堡");

    expect(matches).toContainEqual({
      name: "安平古堡",
      coordinate: { lat: 23.00125, lon: 120.16083 },
      address: "臺南市安平區國勝路82號",
    });
  });

  // 使用者最常拿來當查詢中心的就是車站，而 TDX 的站名是「臺南」不是「臺南車站」。
  it("resolves a rail station whether or not the user types 車站", async () => {
    const { client } = fakeClient([...emptyTourism, stationRoute]);
    const provider = createTdxPoiProvider(client);

    for (const query of ["台南車站", "臺南車站", "臺南"]) {
      const matches = await provider.geocode(query);
      expect(matches.map((m) => m.name)).toContain("臺南車站");
    }
  });

  it("does not return unrelated stations", async () => {
    const { client } = fakeClient([...emptyTourism, stationRoute]);

    const matches = await createTdxPoiProvider(client).geocode("臺南車站");

    expect(matches.map((m) => m.name)).not.toContain("基隆車站");
  });

  // spec 的「地點名稱有多個相符結果」要求列出候選供使用者選擇，
  // 因此解析必須能回傳多筆，而不是自行挑一個。
  it("returns every match so the caller can ask the user to choose", async () => {
    const { client } = fakeClient([
      {
        match: /^\/Attraction/,
        body: {
          value: [
            { AttractionID: "A1", AttractionName: "文化中心", PositionLat: 22.99, PositionLon: 120.21 },
            { AttractionID: "A2", AttractionName: "文化中心", PositionLat: 25.04, PositionLon: 121.51 },
          ],
        },
      },
      { match: /^\/Restaurant/, body: { value: [] } },
      { match: /^\/Hotel/, body: { value: [] } },
      stationRoute,
    ]);

    const matches = await createTdxPoiProvider(client).geocode("文化中心");

    expect(matches).toHaveLength(2);
    expect(matches[0].coordinate).not.toEqual(matches[1].coordinate);
  });

  it("returns nothing for a blank query without calling TDX", async () => {
    const { client, paths } = fakeClient([]);

    expect(await createTdxPoiProvider(client).geocode("   ")).toEqual([]);
    expect(paths).toHaveLength(0);
  });
});

describe("台／臺 的處理", () => {
  // TDX 的景點名稱含「台」252 筆、含「臺」225 筆，兩種寫法都大量存在。
  // 把 POI 名稱正規化成「臺」會讓「台灣戲劇館」「台塑企業文物館」永遠查不到。
  it("searches POI names literally first, without normalising 台 to 臺", async () => {
    const { client, paths } = fakeClient([
      {
        match: /^\/Attraction/,
        body: {
          value: [
            { AttractionID: "A1", AttractionName: "台灣戲劇館", PositionLat: 24.75, PositionLon: 121.75 },
          ],
        },
      },
      { match: /^\/Restaurant/, body: { value: [] } },
      { match: /^\/Hotel/, body: { value: [] } },
      { match: /Rail\/TRA\/Station/, body: { Stations: [] } },
    ]);

    const matches = await createTdxPoiProvider(client).geocode("台灣戲劇館");

    expect(matches.map((m) => m.name)).toContain("台灣戲劇館");
    expect(paths[0]).toContain(encodeURIComponent("'台灣戲劇館'"));
  });

  // 額度每分鐘只有 5 次，所以另一種寫法只在字面查不到時才試。
  it("retries with the other character form only when the literal query found nothing", async () => {
    let attractionCalls = 0;
    const client: TdxClient = {
      async get<T>() {
        return {} as T;
      },
      async getList<T>(path: string, _base: TdxBase, collectionKey?: string) {
        if (path.startsWith("/Attraction")) {
          attractionCalls++;
          // 第一次（字面「台北」）無結果，第二次（「臺北」）才有。
          if (path.includes(encodeURIComponent("'臺北故事館'"))) {
            return [
              { AttractionID: "A1", AttractionName: "臺北故事館", PositionLat: 25.07, PositionLon: 121.53 },
            ] as T[];
          }
          return [] as T[];
        }
        if (path.includes("Station")) return [] as T[];
        void collectionKey;
        return [] as T[];
      },
    };

    const matches = await createTdxPoiProvider(client).geocode("台北故事館");

    expect(attractionCalls).toBe(2);
    expect(matches.map((m) => m.name)).toContain("臺北故事館");
  });

  it("does not spend a second request when the literal query already matched", async () => {
    let attractionCalls = 0;
    const client: TdxClient = {
      async get<T>() {
        return {} as T;
      },
      async getList<T>(path: string) {
        if (path.startsWith("/Attraction")) {
          attractionCalls++;
          return [
            { AttractionID: "A1", AttractionName: "台灣戲劇館", PositionLat: 24.75, PositionLon: 121.75 },
          ] as T[];
        }
        return [] as T[];
      },
    };

    await createTdxPoiProvider(client).geocode("台灣戲劇館");

    expect(attractionCalls).toBe(1);
  });

  // 縣市名則相反：TDX 的 PostalAddress/City 一律用「臺」，必須正規化。
  it("still normalises city names, where TDX uses 臺 consistently", () => {
    expect(normalizeCityName("台南市")).toBe("臺南市");
    expect(swapTaiwanCharacter("台灣戲劇館")).toBe("臺灣戲劇館");
    expect(swapTaiwanCharacter("臺北故事館")).toBe("台北故事館");
  });
});
