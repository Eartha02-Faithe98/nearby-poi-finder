/** WGS84 座標。 */
export type Coordinate = { lat: number; lon: number };

/** 八大類別。定義於 nearby-search spec 的「類別涵蓋範圍」需求。 */
export const POI_CATEGORIES = [
  "food",
  "drinks",
  "parking",
  "restroom",
  "attraction",
  "hotel",
  "transport",
  "souvenir",
] as const;

export type PoiCategory = (typeof POI_CATEGORIES)[number];

/** 週日為 0，與 Date.prototype.getDay() 一致。 */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** 單日的營業時段，時間為當地時間的 "HH:mm"。空陣列代表該日公休。 */
export type OpeningHours = Record<Weekday, { start: string; end: string }[]>;

/**
 * 一個地點。
 *
 * `openingHours` 為選填：nearby-search 與 trip-planning 兩份 spec 都要求，
 * 資料來源未提供營業時間時該筆地點仍須回傳並標註為未知，而非被略過。
 * 以 undefined 表示未知，讓呼叫端無法把「未知」誤當成「全天營業」。
 */
export type Poi = {
  id: string;
  name: string;
  category: PoiCategory;
  coordinate: Coordinate;
  address?: string;
  openingHours?: OpeningHours;
};

/** 附近搜尋的單筆結果。距離為與查詢中心的直線距離。 */
export type NearbyResult = Poi & { distanceMeters: number };

/** 地點名稱解析的單一候選。名稱有多個相符結果時會回傳多筆供使用者選擇。 */
export type GeocodeMatch = {
  name: string;
  coordinate: Coordinate;
  address?: string;
};

/** 步行分段。transit-routing spec 要求載明距離與所需時間。 */
export type WalkLeg = {
  mode: "walk";
  from: Coordinate;
  to: Coordinate;
  distanceMeters: number;
  durationMinutes: number;
};

/**
 * 大眾運輸分段。
 *
 * transit-routing spec 要求載明可供使用者辨識的路線識別、上下車地點，
 * 以及該班次的實際發車與抵達時間。這些欄位皆為必填——一旦設為選填，
 * 「不得以估算值取代實際班次時間」這條需求就會在型別層失守。
 */
export type TransitLeg = {
  mode: "transit";
  routeName: string;
  boardStopName: string;
  alightStopName: string;
  departureTime: Date;
  arrivalTime: Date;
};

export type ConnectionLeg = WalkLeg | TransitLeg;

/** 一組完整的交通銜接方案。 */
export type Connection = {
  departureTime: Date;
  arrivalTime: Date;
  totalDurationMinutes: number;
  legs: ConnectionLeg[];
};

/**
 * 銜接查詢的結果。
 *
 * 刻意使用 discriminated union 而非空陣列：transit-routing spec 要求查無方案時
 * MUST NOT 回傳估算值。`{ found: false }` 沒有可放置估算值的欄位，讓該需求
 * 在型別層即無法被違反。
 */
export type ConnectionSearchResult =
  | { found: true; connections: Connection[] }
  | { found: false };

/** POI 資料來源。MVP 僅有 TDX 一個實作。 */
export interface PoiProvider {
  /** 取得某區域內指定類別的候選地點，供排程引擎的候選召回階段使用。 */
  searchByArea(input: { area: string; categories: PoiCategory[] }): Promise<Poi[]>;

  /** 取得某座標周邊指定類別的地點，依距離由近至遠排序。 */
  searchNearby(input: {
    center: Coordinate;
    categories: PoiCategory[];
    radiusMeters: number;
  }): Promise<NearbyResult[]>;

  /** 將地點名稱解析為座標。回傳多筆代表該名稱有多個相符結果。 */
  geocode(query: string): Promise<GeocodeMatch[]>;
}

/** 交通銜接資料來源。MVP 僅有 TDX 一個實作。 */
export interface RoutingProvider {
  /**
   * 查詢兩點間於指定時間之後可搭乘的銜接方案。
   * 給定 `arriveBefore` 時，實作應僅回傳能在該時間前抵達的方案。
   */
  findConnections(input: {
    from: Coordinate;
    to: Coordinate;
    departAfter: Date;
    arriveBefore?: Date;
  }): Promise<ConnectionSearchResult>;
}
