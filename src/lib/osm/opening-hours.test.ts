import { describe, expect, it } from "vitest";

import { parseOpeningHours } from "@/lib/osm/opening-hours";

/** 只列出有時段的日子，讓斷言短到看得出意圖。 */
function open(value: string): Record<string, string[]> {
  const parsed = parseOpeningHours(value);
  if (!parsed) throw new Error(`預期可解析：${value}`);
  const out: Record<string, string[]> = {};
  const names = ["日", "一", "二", "三", "四", "五", "六"];
  for (let day = 0; day < 7; day++) {
    const spans = parsed[day as 0 | 1 | 2 | 3 | 4 | 5 | 6];
    if (spans.length > 0) out[names[day]] = spans.map((s) => `${s.start}-${s.end}`);
  }
  return out;
}

const ALL_DAY = ["00:00-24:00"];

describe("parseOpeningHours", () => {
  it("24/7 為每天全天", () => {
    expect(open("24/7")).toEqual({ 日: ALL_DAY, 一: ALL_DAY, 二: ALL_DAY, 三: ALL_DAY, 四: ALL_DAY, 五: ALL_DAY, 六: ALL_DAY });
  });

  it("Mo-Su 與省略星期都代表每天", () => {
    const everyDay = { 日: ["11:00-21:00"], 一: ["11:00-21:00"], 二: ["11:00-21:00"], 三: ["11:00-21:00"], 四: ["11:00-21:00"], 五: ["11:00-21:00"], 六: ["11:00-21:00"] };
    expect(open("Mo-Su 11:00-21:00")).toEqual(everyDay);
    expect(open("11:00-21:00")).toEqual(everyDay);
  });

  it("未被提到的日子視為公休，而不是沿用其他日子的時段", () => {
    // OSM 的語意就是如此。若誤把週末當成與平日相同，排程引擎會把使用者
    // 排到一家週末不開的店門口，而這正是可行性驗證要擋掉的事。
    expect(open("Mo-Fr 09:00-18:00")).toEqual({
      一: ["09:00-18:00"], 二: ["09:00-18:00"], 三: ["09:00-18:00"], 四: ["09:00-18:00"], 五: ["09:00-18:00"],
    });
  });

  it("同一天的多個時段（午休）都保留", () => {
    expect(open("Mo-Tu 11:00-14:00,17:00-21:00")).toEqual({
      一: ["11:00-14:00", "17:00-21:00"], 二: ["11:00-14:00", "17:00-21:00"],
    });
  });

  it("逗號也可能分隔規則，依後段是否以星期開頭區分", () => {
    expect(open("Mo-Tu 09:00-21:30,Sa-Su 10:00-22:00")).toEqual({
      一: ["09:00-21:30"], 二: ["09:00-21:30"], 六: ["10:00-22:00"], 日: ["10:00-22:00"],
    });
  });

  it("後面的規則覆寫前面的同一天", () => {
    expect(open("Mo-We 09:00-18:00; We off")).toEqual({
      一: ["09:00-18:00"], 二: ["09:00-18:00"],
    });
  });

  it("跨午夜的時段拆到隔天，讓消費端只需比較 start <= t <= end", () => {
    expect(open("Fr 18:00-02:00")).toEqual({ 五: ["18:00-24:00"], 六: ["00:00-02:00"] });
    // 開到午夜整點不應拆出一段零長度的隔日時段。
    expect(open("Fr 18:00-00:00")).toEqual({ 五: ["18:00-24:00"] });
  });

  it("OSM 的延伸時刻（25:00 = 隔天凌晨一點）與跨午夜寫法等義", () => {
    // 實測有 70 筆在用這種寫法。兩種寫法若不等義，同一家店會因為店家怎麼填
    // 而得到不同的營業時間。
    expect(open("Fr 18:00-25:00")).toEqual(open("Fr 18:00-01:00"));
    expect(open("Fr 18:00-25:00")).toEqual({ 五: ["18:00-24:00"], 六: ["00:00-01:00"] });
  });

  it("星期範圍可以跨過週末回繞", () => {
    expect(open("Fr-Mo 10:00-12:00")).toEqual({
      五: ["10:00-12:00"], 六: ["10:00-12:00"], 日: ["10:00-12:00"], 一: ["10:00-12:00"],
    });
  });

  it("國定假日規則被略過，不影響同一串裡的星期規則", () => {
    expect(open("Mo-Tu 06:00-24:00; PH off")).toEqual({
      一: ["06:00-24:00"], 二: ["06:00-24:00"],
    });
  });

  it("整串只談國定假日時回傳未知，而不是判成每天公休", () => {
    expect(parseOpeningHours("PH off")).toBeUndefined();
  });

  it.each([
    ["", "空字串"],
    ["10", "只有數字"],
    ["12hr", "自由文字"],
    ["營運12小時", "中文描述"],
    ["open", "非時間的英文"],
    ["sunrise-sunset", "日出日落"],
    ["Mo-Fr", "只有星期沒有時間"],
    ["25:00-26:00", "起點不是當日的時刻"],
    ["10:00-99:00", "超出延伸時刻上限"],
    ["Su-Wd 11:00-21:30", "拼錯的星期"],
  ])("解不掉的值回傳未知：%s（%s）", (value) => {
    expect(parseOpeningHours(value)).toBeUndefined();
  });
});
