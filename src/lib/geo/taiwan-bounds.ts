import type { Coordinate } from "@/lib/domain";

type Box = { name: string; minLat: number; maxLat: number; minLon: number; maxLon: number };

// ponytail: 以 bounding box 判定，不做 point-in-polygon。
// 已知天花板：金門與廈門相距僅約 10 公里，任何矩形都無法乾淨分開兩者——
// 廈門島東側約 118.14–118.20 這一小段會被誤判為在範圍內。MVP 可接受，因為
// 資料來源不會回傳廈門的地點，使用者只會得到「查無結果」而非錯誤資料。
// 升級路徑：若誤判造成實際困擾，改以國土測繪中心的縣市界圖資做 point-in-polygon。
const BOXES: Box[] = [
  // 本島，含蘭嶼與綠島（兩者落在本島矩形內）。
  { name: "本島", minLat: 21.85, maxLat: 25.35, minLon: 119.9, maxLon: 122.05 },
  { name: "澎湖", minLat: 23.1, maxLat: 23.85, minLon: 119.3, maxLon: 119.75 },
  { name: "金門", minLat: 24.35, maxLat: 24.54, minLon: 118.14, maxLon: 118.51 },
  { name: "馬祖", minLat: 25.9, maxLat: 26.4, minLon: 119.8, maxLon: 120.55 },
];

/**
 * 判定座標是否落在 MVP 支援的範圍內（台灣本島與有觀光活動的離島）。
 *
 * 不涵蓋東沙島與南沙太平島：兩者雖為我國領土，但無觀光資料亦無大眾運輸，
 * 納入只會讓使用者得到一個永遠查無結果的區域。
 */
export function isWithinTaiwan(coord: Coordinate): boolean {
  return BOXES.some(
    (box) =>
      coord.lat >= box.minLat &&
      coord.lat <= box.maxLat &&
      coord.lon >= box.minLon &&
      coord.lon <= box.maxLon,
  );
}
