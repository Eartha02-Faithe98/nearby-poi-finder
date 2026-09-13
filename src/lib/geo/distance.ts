import type { Coordinate } from "@/lib/domain";

/** 地球平均半徑（公尺）。 */
const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * 兩座標間的大圓距離（公尺）。
 *
 * nearby-search spec 的「搜尋結果內容」要求每筆結果標示「與查詢中心的直線距離」
 * 並依此排序。TDX 的 `/Nearby` 不回傳距離，故於本地計算。
 *
 * ponytail: 用 haversine，不用 Vincenty。在台灣這個尺度（單次查詢半徑上限
 * 1 公里，跨島最遠約 300 公里）兩者差距遠小於 POI 座標本身的誤差。
 */
export function distanceMeters(a: Coordinate, b: Coordinate): number {
  const latDelta = toRadians(b.lat - a.lat);
  const lonDelta = toRadians(b.lon - a.lon);
  const aLatRad = toRadians(a.lat);
  const bLatRad = toRadians(b.lat);

  const h =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(aLatRad) * Math.cos(bLatRad) * Math.sin(lonDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}
