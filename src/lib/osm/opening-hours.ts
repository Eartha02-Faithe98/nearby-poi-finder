import type { OpeningHours, Weekday } from "@/lib/domain";

/**
 * OSM `opening_hours` 字串的解析（tasks 3.9、design D9）。
 *
 * ponytail: 只解常見子集,不裝 `opening_hours` 套件。實測 9,558 個值中本子集可解
 * **95.6%**,解不掉的 423 筆是「10」「12hr」「營運12小時」「open」這類自由文字——
 * 完整文法的套件同樣解不出來,換不到那 4.4%。
 * 升級路徑:若日後 OSM 資料出現大量 `sunrise-sunset`、`PH` 行事曆或月份選擇器,再換套件。
 *
 * **解不掉時整串視為未知**,不做部分解析。半套的營業時間會讓排程引擎在錯的時間
 * 把使用者送到店門口,而兩份 spec 都允許「未知」——未知會被標註出來,錯的時間不會。
 */

const DAY_INDEX: Record<string, Weekday> = {
  su: 0,
  mo: 1,
  tu: 2,
  we: 3,
  th: 4,
  fr: 5,
  sa: 6,
};

const WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/** 國定假日與學校假期。無法對應到星期,含這種選擇器的規則整條略過。 */
const HOLIDAY_TOKENS = new Set(["ph", "sh"]);

const DAY_TOKEN = "(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)";
const DAY_SELECTOR = new RegExp(
  `^${DAY_TOKEN}(?:-${DAY_TOKEN})?(?:,${DAY_TOKEN}(?:-${DAY_TOKEN})?)*$`,
  "i",
);
const RULE = /^([A-Za-z][A-Za-z\s,-]*?)?\s*((?:\d|off\b|closed\b).*)$/i;
/** 規則的開頭是不是星期。用於判斷逗號是規則分隔還是時段並列。 */
const STARTS_WITH_DAY = /^\s*(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b/i;
const TIME_SPAN = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;

function emptyWeek(): Record<Weekday, Span[]> {
  return { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
}

/**
 * 切出規則。
 *
 * `;`（含全形,實測資料裡有）一律是規則分隔;`,` 則同時用於「時段並列」與
 * 「規則並列」（`Mo-Fr 09:00-21:30,Sa-Su 10:00-22:00`）,只有在後一段以星期開頭
 * 且前一段已含時間時才視為規則分隔。加上這條後涵蓋率從 90.1% 升到 95.6%。
 */
function splitRules(text: string): string[] {
  const rules: string[] = [];
  for (const chunk of text.split(/[;；]/)) {
    let current = "";
    for (const part of chunk.split(",")) {
      if (current && /\d/.test(current) && STARTS_WITH_DAY.test(part)) {
        rules.push(current);
        current = part;
      } else {
        current = current ? `${current},${part}` : part;
      }
    }
    if (current.trim()) rules.push(current);
  }
  return rules.map((rule) => rule.trim()).filter(Boolean);
}

function expandDays(selector: string): Weekday[] | undefined {
  const days = new Set<Weekday>();
  for (const part of selector.replace(/\s+/g, "").split(",")) {
    const [from, to] = part.toLowerCase().split("-");
    if (HOLIDAY_TOKENS.has(from)) continue;
    const start = DAY_INDEX[from];
    if (start === undefined) return undefined;
    if (to === undefined) {
      days.add(start);
      continue;
    }
    const end = DAY_INDEX[to];
    if (end === undefined) return undefined;
    // Sa-Su、Fr-Mo 這類跨週末的範圍要繞回去,不能只走遞增。
    for (let i = start; ; i = ((i + 1) % 7) as Weekday) {
      days.add(i as Weekday);
      if (i === end) break;
    }
  }
  return [...days];
}

const MINUTES_PER_DAY = 24 * 60;

/** 1440 分鐘輸出為 "24:00" 而不是隔日的 "00:00",讓「開到打烊」在字串比較下仍成立。 */
const asClock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * 一段時間。`end` 以「距當日 00:00 的分鐘數」表示,可以超過 1440——
 * OSM 用 `25:00` 表示隔日凌晨一點,`11:00-03:00` 同樣是跨午夜。
 * 兩者在這裡是同一件事,到 `splitOvernight` 才拆日。
 */
type Span = { startMinutes: number; endMinutes: number };

function parseSpans(body: string): Span[] | undefined {
  const spans: Span[] = [];
  for (const piece of body.split(",")) {
    const m = TIME_SPAN.exec(piece.trim());
    if (!m) return undefined;
    const [, fromHour, fromMinute, toHour, toMinute] = m;
    if (Number(fromMinute) > 59 || Number(toMinute) > 59) return undefined;
    // 起點必須是當日的時刻;終點可到 48:00（OSM 的延伸時刻,實測 70 筆在用）。
    if (Number(fromHour) > 24 || Number(toHour) > 48) return undefined;

    const startMinutes = Number(fromHour) * 60 + Number(fromMinute);
    let endMinutes = Number(toHour) * 60 + Number(toMinute);
    // 終點不大於起點就是跨午夜:`11:00-03:00` 等同 `11:00-27:00`。
    if (endMinutes <= startMinutes) endMinutes += MINUTES_PER_DAY;
    if (endMinutes - startMinutes > MINUTES_PER_DAY) return undefined;
    spans.push({ startMinutes, endMinutes });
  }
  return spans;
}

/**
 * 解析 OSM 的 `opening_hours` 值。
 *
 * 回傳 `undefined` 代表「未知」——呼叫端必須據此標註,不得當成全天營業或公休。
 */
export function parseOpeningHours(value: string): OpeningHours | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (/^24\s*\/\s*7$/.test(text)) {
    const week = emptyWeek();
    for (const day of WEEKDAYS) week[day] = [{ startMinutes: 0, endMinutes: MINUTES_PER_DAY }];
    return splitOvernight(week);
  }

  const rules = splitRules(text);
  if (rules.length === 0) return undefined;

  const week = emptyWeek();
  let applied = false;
  for (const rule of rules) {
    const m = RULE.exec(rule);
    if (!m) return undefined;
    const [, selector, body] = m;

    let days = WEEKDAYS;
    if (selector) {
      const cleaned = selector.replace(/\s+/g, "");
      if (!DAY_SELECTOR.test(cleaned)) return undefined;
      const expanded = expandDays(cleaned);
      if (!expanded) return undefined;
      // 整條規則只談國定假日（例 `PH off`）,對星期沒有主張,略過。
      if (expanded.length === 0) continue;
      days = expanded;
    }

    const closed = /^(off|closed)$/i.test(body.trim());
    const spans = closed ? [] : parseSpans(body);
    if (!spans) return undefined;

    // 同一天被後面的規則再次提到時,以後者為準（OSM 的規則覆寫語意）。
    for (const day of days) week[day] = spans;
    applied = true;
  }

  // 沒有任何一條規則談到星期（例如整串只有 `PH off`）,那就是沒說,不是每天公休。
  return applied ? splitOvernight(week) : undefined;
}

/**
 * 把跨午夜的時段拆到隔天。
 *
 * `Mo-Su 11:00-03:00`（與同義的 `11:00-27:00`）拆成當日 11:00-24:00 與隔日 00:00-03:00。
 * 留著跨午夜的表示法會讓每一個消費端都得自己處理繞圈,而漏掉的那一個
 * 會安靜地把凌晨兩點判定為「已打烊」。在這裡拆一次,消費端就只需 `start <= t <= end`。
 */
function splitOvernight(week: Record<Weekday, Span[]>): OpeningHours {
  const result: OpeningHours = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const day of WEEKDAYS) {
    for (const span of week[day]) {
      if (span.endMinutes <= MINUTES_PER_DAY) {
        result[day].push({ start: asClock(span.startMinutes), end: asClock(span.endMinutes) });
        continue;
      }
      result[day].push({ start: asClock(span.startMinutes), end: "24:00" });
      const next = ((day + 1) % 7) as Weekday;
      result[next].push({ start: "00:00", end: asClock(span.endMinutes - MINUTES_PER_DAY) });
    }
  }
  return result;
}
