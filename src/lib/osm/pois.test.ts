import { describe, expect, it } from "vitest";

import {
  NEARBY_SEARCH_ONLY_CATEGORIES,
  OSM_CATEGORY_TAGS,
  selectOsmPois,
  type OsmPlaceRow,
} from "@/lib/osm/pois";

function row(name: string, tags: Partial<OsmPlaceRow> = {}): OsmPlaceRow {
  return { id: `node/${name}`, name, lat: 25.0339, lon: 121.5645, ...tags };
}

/** 取自快照的真實標籤組合。 */
const PLACES = {
  handShakenShop: row("迷客夏", { shop: "beverages", cuisine: "bubble_tea" }),
  handShakenCafe: row("可不可熟成紅茶", { amenity: "cafe", cuisine: "bubble_tea" }),
  teaShop: row("不二本一.茶.製作所", { amenity: "restaurant", cuisine: "tea" }),
  bakeryCafe: row("85度C", { shop: "bakery", amenity: "cafe", cuisine: "coffee_shop" }),
  pureBakery: row("Dori 烘培坊", { shop: "bakery" }),
  restaurant: row("鼎泰豐", { amenity: "restaurant", cuisine: "chinese;dumplings" }),
  giftShop: row("宜蘭餅發明館", { shop: "gift" }),
};

const drinkNames = (rows: OsmPlaceRow[]) => selectOsmPois(rows, "drinks").map((poi) => poi.name);

describe("selectOsmPois — 飲料（design D11）", () => {
  it("手搖飲的兩種標法都要收", () => {
    // 同一個連鎖品牌的分店在 OSM 被標成 shop=beverages 或 amenity=cafe+cuisine=bubble_tea，
    // 只收一種會讓同品牌的一半分店查不到。
    expect(drinkNames([PLACES.handShakenShop, PLACES.handShakenCafe])).toEqual([
      "迷客夏",
      "可不可熟成紅茶",
    ]);
  });

  it("一般餐廳與純麵包店不算飲料", () => {
    expect(drinkNames([PLACES.restaurant, PLACES.pureBakery, PLACES.giftShop])).toEqual([]);
  });

  it("分號分隔的多值標籤也能命中", () => {
    // 實測 2,942 筆 cuisine 是多值。只比對整串會讓這些店全部落榜。
    expect(drinkNames([row("明星西點咖啡", { amenity: "restaurant", cuisine: "bakery;coffee_shop" })]))
      .toEqual(["明星西點咖啡"]);
  });

  it("兼營咖啡的麵包店算飲料，只賣麵包的不算", () => {
    expect(drinkNames([PLACES.bakeryCafe, PLACES.pureBakery])).toEqual(["85度C"]);
  });

  it("飲料的標籤集合固定為 D11 裁示的內容", () => {
    // 這份對應是 spike 期間逐一比對筆數與樣本店家得出的。改動它應該是一個明確的決定，
    // 而不是某次重構的副作用。
    expect(OSM_CATEGORY_TAGS.drinks).toEqual({
      amenity: ["cafe"],
      shop: ["beverages", "tea", "coffee"],
      cuisine: ["bubble_tea", "coffee_shop"],
    });
  });

  it("尚未定義 OSM 標籤的類別回傳空陣列", () => {
    expect(selectOsmPois([PLACES.handShakenShop], "restroom")).toEqual([]);
  });
});

describe("selectOsmPois — 伴手禮的 OSM 側（design D11）", () => {
  const souvenirNames = (rows: OsmPlaceRow[]) =>
    selectOsmPois(rows, "souvenir").map((poi) => poi.name);

  it("收禮品、糖果與糕餅店", () => {
    expect(
      souvenirNames([
        row("宜蘭餅發明館", { shop: "gift" }),
        row("糖村", { shop: "confectionery" }),
        row("舊振南餅店", { shop: "pastry" }),
      ]),
    ).toEqual(["宜蘭餅發明館", "糖村", "舊振南餅店"]);
  });

  it("排除一般麵包店與熟食店", () => {
    // D11 的明文裁示。bakery 有 1,390 筆、deli 36 筆，收進來會讓「伴手禮」
    // 變成「所有賣吃的店」，使用者要找的名產就被淹沒。
    expect(souvenirNames([row("Dori 烘培坊", { shop: "bakery" }), row("某熟食店", { shop: "deli" })]))
      .toEqual([]);
  });

  it("伴手禮的標籤集合固定為 D11 裁示的內容", () => {
    // TDX 側的代碼集合由 poi-provider.test.ts 固定（SOUVENIR_CUISINE_CODES／
    // SOUVENIR_ATTRACTION_CODES）。兩側合起來才是這個類別的定義。
    expect(OSM_CATEGORY_TAGS.souvenir).toEqual({ shop: ["gift", "confectionery", "pastry"] });
  });

  it("飲料與伴手禮的判定互不干擾", () => {
    const cafe = row("某咖啡館", { amenity: "cafe" });
    const gift = row("某名產店", { shop: "gift" });
    expect(souvenirNames([cafe, gift])).toEqual(["某名產店"]);
    expect(selectOsmPois([cafe, gift], "drinks").map((p) => p.name)).toEqual(["某咖啡館"]);
  });
});

describe("selectOsmPois — 美食（design D12，只供附近搜尋）", () => {
  it("收一般餐廳、速食與冰品，咖啡館歸飲料不重複收", () => {
    const rows = [
      row("鼎泰豐", { amenity: "restaurant" }),
      row("麥當勞", { amenity: "fast_food" }),
      row("小美冰淇淋", { amenity: "ice_cream" }),
      row("某咖啡館", { amenity: "cafe" }),
    ];
    expect(selectOsmPois(rows, "food").map((p) => p.name)).toEqual(["鼎泰豐", "麥當勞", "小美冰淇淋"]);
  });

  it("美食被標記為只供附近搜尋，飲料與伴手禮則兩者皆可", () => {
    // 行程規劃的候選召回要讀這個集合把 OSM 餐飲排除在外——OSM 的餐飲沒有 TDX 的
    // 觀光策展，排進行程會出現巷口便當店。
    expect(NEARBY_SEARCH_ONLY_CATEGORIES.has("food")).toBe(true);
    expect(NEARBY_SEARCH_ONLY_CATEGORIES.has("drinks")).toBe(false);
    expect(NEARBY_SEARCH_ONLY_CATEGORIES.has("souvenir")).toBe(false);
  });
});

describe("selectOsmPois — 欄位轉換", () => {
  it("營業時間解析後帶上，並標示含 OSM 資料", () => {
    const [poi] = selectOsmPois(
      [row("迷客夏", { shop: "beverages", openingHours: "Mo-Su 10:00-22:00" })],
      "drinks",
    );

    expect(poi.category).toBe("drinks");
    expect(poi.coordinate).toEqual({ lat: 25.0339, lon: 121.5645 });
    expect(poi.openingHours?.[1]).toEqual([{ start: "10:00", end: "22:00" }]);
    // ODbL 要求標示出處，spec 的「資料出處標示」需求據此判斷該不該標。
    expect(poi.usesOsmData).toBe(true);
  });

  it.each([
    ["沒有營業時間", undefined],
    ["營業時間解不出來", "12hr"],
  ])("%s 的店家仍然回傳，營業時間為未知", (_case, openingHours) => {
    const [poi] = selectOsmPois([row("茶的魔手", { shop: "beverages", openingHours })], "drinks");

    expect(poi.name).toBe("茶的魔手");
    expect(poi.openingHours).toBeUndefined();
  });
});
