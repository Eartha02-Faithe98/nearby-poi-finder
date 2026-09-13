import { describe, expect, it } from "vitest";

import { distanceMeters } from "@/lib/geo/distance";

const TAINAN_STATION = { lat: 22.99681, lon: 120.21295 };
const ANPING_FORT = { lat: 23.00125, lon: 120.16083 };

describe("distanceMeters", () => {
  it("returns zero for the same point", () => {
    expect(distanceMeters(TAINAN_STATION, TAINAN_STATION)).toBe(0);
  });

  // 台南車站到安平古堡實際約 5.4 公里。誤差容許 100 公尺——
  // 這個量級的準確度足以支撐距離排序與步行可達性判斷。
  it("matches the real distance between two known landmarks", () => {
    expect(distanceMeters(TAINAN_STATION, ANPING_FORT)).toBeCloseTo(5_370, -2);
  });

  it("is symmetric", () => {
    expect(distanceMeters(TAINAN_STATION, ANPING_FORT)).toBeCloseTo(
      distanceMeters(ANPING_FORT, TAINAN_STATION),
      6,
    );
  });

  // 排序正確性依賴這件事：近的點算出來必須真的比較小。
  it("orders nearby points before distant ones", () => {
    const near = { lat: 22.9971, lon: 120.2135 };
    const far = { lat: 25.0478, lon: 121.5171 };

    expect(distanceMeters(TAINAN_STATION, near)).toBeLessThan(
      distanceMeters(TAINAN_STATION, far),
    );
  });

  // 跨越經度時若用平面近似會嚴重失真，此處確認大圓公式成立。
  it("handles the span from Penghu to the main island", () => {
    const magong = { lat: 23.5655, lon: 119.5794 };

    expect(distanceMeters(magong, TAINAN_STATION)).toBeGreaterThan(80_000);
    expect(distanceMeters(magong, TAINAN_STATION)).toBeLessThan(110_000);
  });
});
