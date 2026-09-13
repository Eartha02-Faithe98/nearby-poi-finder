import { describe, expect, it } from "vitest";

import { isWithinTaiwan } from "@/lib/geo/taiwan-bounds";

// 範圍判定直接決定 trip-planning 與 nearby-search 兩份 spec 的「地理範圍限制」
// 需求能否成立：判定過寬會讓使用者拿到空結果而非明確拒絕；判定過窄則會把
// 離島使用者整個擋在門外，而離島正是本產品的差異化所在。
describe("isWithinTaiwan", () => {
  it.each([
    ["台北車站", 25.0478, 121.517],
    ["墾丁", 21.9482, 120.7973],
    ["富貴角（本島最北）", 25.2977, 121.5374],
    ["蘭嶼", 22.0464, 121.5582],
    ["綠島", 22.6614, 121.4879],
    ["澎湖馬公", 23.5655, 119.5795],
    ["金門金城", 24.4327, 118.3171],
    ["馬祖南竿", 26.1508, 119.9319],
    ["馬祖東引", 26.3667, 120.4922],
  ])("accepts %s", (_name, lat, lon) => {
    expect(isWithinTaiwan({ lat, lon })).toBe(true);
  });

  it.each([
    ["東京", 35.6812, 139.7671],
    ["香港", 22.3193, 114.1694],
    ["首爾", 37.5665, 126.978],
    ["沖繩那霸", 26.2124, 127.6809],
    ["台灣海峽以西外海", 24.0, 117.0],
    ["巴士海峽以南", 20.5, 121.0],
  ])("rejects %s", (_name, lat, lon) => {
    expect(isWithinTaiwan({ lat, lon })).toBe(false);
  });

  // 沖繩那霸與馬祖東引緯度相近（26.2 對 26.37），若馬祖矩形的經度上界放得太寬
  // 就會把琉球群島一併吃進來。這個案例鎖住該邊界。
  it("does not let the Matsu box leak east into the Ryukyus", () => {
    expect(isWithinTaiwan({ lat: 26.2124, lon: 127.6809 })).toBe(false);
    expect(isWithinTaiwan({ lat: 26.2, lon: 121.0 })).toBe(false);
  });
});
