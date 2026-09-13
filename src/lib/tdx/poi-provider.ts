import "server-only";

import type {
  Coordinate,
  GeocodeMatch,
  NearbyResult,
  Poi,
  PoiCategory,
  PoiProvider,
} from "@/lib/domain";
import { distanceMeters } from "@/lib/geo/distance";
import {
  cityPathName,
  isTdxServed,
  NEARBY_COLLECTIONS,
  normalizeCityName,
  SOUVENIR_ATTRACTION_CODES,
  SOUVENIR_CUISINE_CODES,
  swapTaiwanCharacter,
  type TdxServedCategory,
} from "@/lib/tdx/catalog";
import type { TdxClient } from "@/lib/tdx/client";

/** `/Nearby` 的 `Distance` 參數上限，見 spike-notes 1.1。 */
export const NEARBY_MAX_DISTANCE_METERS = 1_000;

/** 單次列表查詢的每頁筆數。實測 500 安全，1000 在部分端點回 400。 */
const PAGE_SIZE = 500;

/**
 * 列表查詢的頁數上限。
 *
 * design D6 原寫「每個區域每個類別只打一次」，但當時尚未取得總筆數——
 * 現已知全台景點 6,228 筆，單一直轄市可能超過單頁的 500 筆，只打一次會**靜默截斷**。
 * 以有上限的分頁取代：既不靜默截斷，呼叫數仍然可預期。
 * 觸頂時的筆數（5,000）遠超過一次行程規劃所需的候選量。
 */
const MAX_PAGES = 10;

type TdxAddress = { City?: string; Town?: string; StreetAddress?: string };

type TourismRow = {
  PositionLat?: number;
  PositionLon?: number;
  PostalAddress?: TdxAddress;
} & Record<string, unknown>;

type NearbyPoint = {
  PositionLat?: number;
  PositionLon?: number;
} & Record<string, unknown>;

/** `api/basic` 的站牌／車站名稱是多語物件，不是字串。 */
type LocalizedName = { Zh_tw?: string; En?: string };
type TdxPosition = { PositionLat?: number; PositionLon?: number };

type BusStopRow = { StopUID?: string; StopName?: LocalizedName; StopPosition?: TdxPosition; StopAddress?: string };
type TraStationRow = {
  StationUID?: string;
  StationName?: LocalizedName;
  StationPosition?: TdxPosition;
  StationAddress?: string;
};
type CarParkRow = {
  CarParkID?: string;
  CarParkName?: LocalizedName;
  CarParkPosition?: TdxPosition;
  Address?: string;
};

function coordinateOf(lat: unknown, lon: unknown): Coordinate | undefined {
  return typeof lat === "number" && typeof lon === "number" ? { lat, lon } : undefined;
}

/** 觀光 API 的地址分成三段，組起來才是可用的地址。 */
function formatAddress(address: TdxAddress | undefined): string | undefined {
  if (!address) return undefined;
  const joined = [address.City, address.Town, address.StreetAddress].filter(Boolean).join("");
  return joined || undefined;
}

function odata(params: Record<string, string>): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `?${query}`;
}

export function createTdxPoiProvider(client: TdxClient): PoiProvider {
  /** 分頁取回列表端點的全部資料列，頁數以 MAX_PAGES 為上限。 */
  async function fetchPages<T>(
    build: (skip: number) => string,
    collectionKey?: string,
  ): Promise<T[]> {
    const all: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await client.getList<T>(build(page * PAGE_SIZE), "basic", collectionKey);
      all.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
    return all;
  }

  /** 觀光 API（tourism base）的分頁查詢。 */
  async function fetchTourism<T>(resource: string, filter?: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const params: Record<string, string> = {
        $top: String(PAGE_SIZE),
        $skip: String(page * PAGE_SIZE),
        $format: "JSON",
      };
      if (filter) params.$filter = filter;
      const rows = await client.getList<T>(`/${resource}${odata(params)}`, "tourism");
      all.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
    return all;
  }

  /**
   * 取得伴手禮候選。
   *
   * 必須一個代碼查一次——多個條件以 `or` 包在 `any()` 裡 TDX 回 500（實測）。
   * 全台合計約 1,091 筆（含跨代碼重複），屬低頻變動的小集合，
   * 適合由 tasks 3.4 的 TTL 快取承接，此處不自行快取。
   */
  async function fetchSouvenirPois(): Promise<Poi[]> {
    const byId = new Map<string, Poi>();

    for (const code of SOUVENIR_CUISINE_CODES) {
      const rows = await fetchTourism<TourismRow>(
        "Restaurant",
        `CuisineClasses/any(c: c eq ${code})`,
      );
      for (const row of rows) {
        const poi = toTourismPoi(row, "RestaurantID", "RestaurantName", "souvenir");
        if (poi) byId.set(poi.id, poi);
      }
    }

    for (const code of SOUVENIR_ATTRACTION_CODES) {
      const rows = await fetchTourism<TourismRow>(
        "Attraction",
        `AttractionClasses/any(c: c eq ${code})`,
      );
      for (const row of rows) {
        const poi = toTourismPoi(row, "AttractionID", "AttractionName", "souvenir");
        if (poi) byId.set(poi.id, poi);
      }
    }

    return [...byId.values()];
  }

  function toTourismPoi(
    row: TourismRow,
    idField: string,
    nameField: string,
    category: TdxServedCategory,
  ): Poi | undefined {
    const id = row[idField];
    const name = row[nameField];
    const coordinate = coordinateOf(row.PositionLat, row.PositionLon);
    if (typeof id !== "string" || typeof name !== "string" || !coordinate) return undefined;

    const address = formatAddress(row.PostalAddress);
    return { id, name, category, coordinate, ...(address ? { address } : {}) };
  }

  async function nearbyByCollections(
    center: Coordinate,
    radiusMeters: number,
    wanted: Set<TdxServedCategory>,
  ): Promise<NearbyResult[]> {
    // `/Nearby` 不接受任何 OData 參數（$top、$format 皆回 400，實測）。
    // 它一次回傳所有類別的集合，因此多類別查詢只需這一個請求。
    const body = await client.get<Record<string, unknown>>(
      `/Nearby?X=${center.lon}&Y=${center.lat}&Distance=${radiusMeters}`,
      "tourism",
    );

    const results: NearbyResult[] = [];
    for (const spec of NEARBY_COLLECTIONS) {
      if (!wanted.has(spec.category)) continue;
      const rows = body[spec.collection];
      if (!Array.isArray(rows)) continue;

      for (const row of rows as NearbyPoint[]) {
        const id = row[spec.idField];
        const name = row[spec.nameField];
        const coordinate = coordinateOf(row.PositionLat, row.PositionLon);
        if (typeof id !== "string" || typeof name !== "string" || !coordinate) continue;

        results.push({
          id,
          name,
          category: spec.category,
          coordinate,
          distanceMeters: distanceMeters(center, coordinate),
        });
      }
    }
    return results;
  }

  async function searchNearby(input: {
    center: Coordinate;
    categories: PoiCategory[];
    radiusMeters: number;
  }): Promise<NearbyResult[]> {
    if (input.radiusMeters <= 0 || input.radiusMeters > NEARBY_MAX_DISTANCE_METERS) {
      throw new Error(
        `TDX 的周邊查詢半徑上限為 ${NEARBY_MAX_DISTANCE_METERS} 公尺，收到 ${input.radiusMeters}`,
      );
    }

    const served = input.categories.filter(isTdxServed);
    const wanted = new Set(served);
    const results: NearbyResult[] = [];

    // 伴手禮需要類別代碼，而 `/Nearby` 的資料列沒有這個欄位（實測），故另外取得。
    if (wanted.delete("souvenir")) {
      for (const poi of await fetchSouvenirPois()) {
        const metres = distanceMeters(input.center, poi.coordinate);
        if (metres <= input.radiusMeters) results.push({ ...poi, distanceMeters: metres });
      }
    }

    if (wanted.size > 0) {
      results.push(...(await nearbyByCollections(input.center, input.radiusMeters, wanted)));
    }

    // spec 的「結果排序」要求依距離由近至遠。
    return results.sort((a, b) => a.distanceMeters - b.distanceMeters);
  }

  async function searchByArea(input: {
    area: string;
    categories: PoiCategory[];
  }): Promise<Poi[]> {
    const city = normalizeCityName(input.area);
    const served = new Set(input.categories.filter(isTdxServed));
    const results: Poi[] = [];

    const cityFilter = `contains(PostalAddress/City, '${city}')`;

    if (served.has("attraction")) {
      const rows = await fetchTourism<TourismRow>("Attraction", cityFilter);
      results.push(...collect(rows, "AttractionID", "AttractionName", "attraction"));
    }
    if (served.has("food")) {
      const rows = await fetchTourism<TourismRow>("Restaurant", cityFilter);
      results.push(...collect(rows, "RestaurantID", "RestaurantName", "food"));
    }
    if (served.has("hotel")) {
      const rows = await fetchTourism<TourismRow>("Hotel", cityFilter);
      results.push(...collect(rows, "HotelID", "HotelName", "hotel"));
    }
    if (served.has("souvenir")) {
      const souvenirs = await fetchSouvenirPois();
      results.push(...souvenirs.filter((poi) => poi.address?.includes(city)));
    }

    if (served.has("parking") || served.has("transport")) {
      const pathName = cityPathName(city);
      // 縣市名無法對應到 TDX 的路徑代碼時，靜默略過會被誤讀為「該市沒有停車場」。
      if (!pathName) {
        throw new Error(`無法將「${input.area}」對應到 TDX 的縣市代碼`);
      }
      if (served.has("parking")) results.push(...(await fetchCarParks(pathName)));
      if (served.has("transport")) results.push(...(await fetchBusStops(pathName)));
    }

    return results;
  }

  function collect(
    rows: TourismRow[],
    idField: string,
    nameField: string,
    category: TdxServedCategory,
  ): Poi[] {
    return rows
      .map((row) => toTourismPoi(row, idField, nameField, category))
      .filter((poi): poi is Poi => poi !== undefined);
  }

  /** 停車場走 `api/basic` 的 v1 端點，回應是具名集合信封 `{ ..., CarParks }`。 */
  async function fetchCarParks(cityPath: string): Promise<Poi[]> {
    const rows = await fetchPages<CarParkRow>(
      (skip) =>
        `/v1/Parking/OffStreet/CarPark/City/${cityPath}${odata({
          $top: String(PAGE_SIZE),
          $skip: String(skip),
          $format: "JSON",
        })}`,
      "CarParks",
    );

    return rows.flatMap((row) => {
      const coordinate = coordinateOf(row.CarParkPosition?.PositionLat, row.CarParkPosition?.PositionLon);
      const name = row.CarParkName?.Zh_tw;
      if (!row.CarParkID || !name || !coordinate) return [];
      return [
        {
          id: row.CarParkID,
          name,
          category: "parking" as const,
          coordinate,
          ...(row.Address ? { address: row.Address } : {}),
        },
      ];
    });
  }

  async function fetchBusStops(cityPath: string): Promise<Poi[]> {
    const rows = await fetchPages<BusStopRow>(
      (skip) =>
        `/v2/Bus/Stop/City/${cityPath}${odata({
          $top: String(PAGE_SIZE),
          $skip: String(skip),
          $format: "JSON",
        })}`,
    );

    return rows.flatMap((row) => {
      const coordinate = coordinateOf(row.StopPosition?.PositionLat, row.StopPosition?.PositionLon);
      const name = row.StopName?.Zh_tw;
      if (!row.StopUID || !name || !coordinate) return [];
      return [
        {
          id: row.StopUID,
          name,
          category: "transport" as const,
          coordinate,
          ...(row.StopAddress ? { address: row.StopAddress } : {}),
        },
      ];
    });
  }

  /**
   * 地點名稱解析。
   *
   * **TDX 沒有 geocoding 端點**（實測 `/v2/Map/GeoCode` 與 `maas/geocoding` 皆 404），
   * 故以名稱搜尋組成：觀光 POI 走 `contains()` 的伺服器端比對，
   * 台鐵車站則全量取回後本地比對（該端點無名稱篩選，但全台僅約 240 站）。
   *
   * 涵蓋「安平古堡」這類景點與「臺南車站」這類交通節點兩種典型輸入。
   * 公車站牌未納入：其端點需逐縣市查詢，而解析當下並不知道縣市，
   * 掃 22 個縣市會讓請求數不可控。
   */
  async function geocode(query: string): Promise<GeocodeMatch[]> {
    const keyword = query.trim();
    if (!keyword) return [];

    const matches: GeocodeMatch[] = [];

    const tourism: [string, string, string][] = [
      ["Attraction", "AttractionID", "AttractionName"],
      ["Restaurant", "RestaurantID", "RestaurantName"],
      ["Hotel", "HotelID", "HotelName"],
    ];
    for (const [resource, , nameField] of tourism) {
      // 以使用者輸入的字面查詢，**不做台／臺正規化**。
      // TDX 的景點名稱兩種寫法都大量存在（實測：含「台」252 筆、含「臺」225 筆），
      // 正規化成「臺」會讓「台灣戲劇館」「台塑企業文物館」這類永遠查不到。
      let rows = await fetchTourism<TourismRow>(
        resource,
        `contains(${nameField}, '${keyword}')`,
      );

      // 字面查不到時才試另一種寫法。額度極稀缺（每分鐘 5 次），
      // 因此只在真的沒結果時多花這一次。
      const variant = swapTaiwanCharacter(keyword);
      if (rows.length === 0 && variant !== keyword) {
        rows = await fetchTourism<TourismRow>(
          resource,
          `contains(${nameField}, '${variant}')`,
        );
      }

      for (const row of rows) {
        const coordinate = coordinateOf(row.PositionLat, row.PositionLon);
        const name = row[nameField];
        if (typeof name !== "string" || !coordinate) continue;
        const address = formatAddress(row.PostalAddress);
        matches.push({ name, coordinate, ...(address ? { address } : {}) });
      }
    }

    const stations = await client.getList<TraStationRow>(
      `/v3/Rail/TRA/Station${odata({ $top: String(PAGE_SIZE), $format: "JSON" })}`,
      "basic",
      "Stations",
    );
    for (const station of stations) {
      const name = station.StationName?.Zh_tw;
      const coordinate = coordinateOf(
        station.StationPosition?.PositionLat,
        station.StationPosition?.PositionLon,
      );
      if (!name || !coordinate) continue;
      // 台鐵的站名是「臺南」而非「臺南車站」，兩種說法都要能對上。
      // 此處的比對在本地進行，不花 TDX 額度，因此可以放心把兩邊都正規化，
      // 讓「台南車站」與「臺南」對得上——這與名稱搜尋不做正規化並不衝突：
      // 那邊是把字面交給 TDX 比對，這邊是我們自己比對。
      const normalizedKeyword = normalizeCityName(keyword);
      const aliases = [name, `${name}車站`, `${name}火車站`].map(normalizeCityName);
      if (
        !aliases.some(
          (alias) => alias.includes(normalizedKeyword) || normalizedKeyword.includes(alias),
        )
      ) {
        continue;
      }
      matches.push({
        name: `${name}車站`,
        coordinate,
        ...(station.StationAddress ? { address: station.StationAddress } : {}),
      });
    }

    return matches;
  }

  return { searchByArea, searchNearby, geocode };
}
