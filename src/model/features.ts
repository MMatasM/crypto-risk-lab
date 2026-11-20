/**
 * The forecasting model's inputs and targets, built from the daily histories in data/history/.
 *
 * Every feature for a day uses only closes and volumes up to and including that day. The target for a day
 * is the return from that day's close to the close exactly 7 or 30 days later, which is only known later:
 * the walk-forward code (walkforward.ts) is what keeps those future returns out of training.
 */
import { macd, rsi, sma } from "../analysis/indicators";
import type { History } from "../data/types";

export const HORIZONS = [7, 30] as const;
export type Horizon = (typeof HORIZONS)[number];

/** Days of history a coin needs before it gets a forecast (the 90-day return and a long average need them). */
export const MIN_ROWS = 100;
/** The long average is 200 days once a coin has that much history, and all its history until then. */
export const LONG = 200;

/** The model's inputs, in order. `name` is shown in the app. */
export const FEATURES = [
  { key: "ret1", name: "1-day return" },
  { key: "ret7", name: "7-day return" },
  { key: "ret30", name: "30-day return" },
  { key: "ret90", name: "90-day return" },
  { key: "vol30", name: "Volatility (30 days)" },
  { key: "rsi", name: "RSI (14)" },
  { key: "macd", name: "MACD vs zero" },
  { key: "macdHist", name: "MACD vs its signal line" },
  { key: "dist20", name: "Distance from 20-day average" },
  { key: "dist50", name: "Distance from 50-day average" },
  { key: "dist200", name: "Distance from 200-day average" },
  { key: "volChg", name: "Trading volume, last week vs last month" },
  { key: "dd", name: "Fall from its 1-year high" },
  { key: "btcRet30", name: "Bitcoin's 30-day return (market mood)" },
  { key: "btcDist50", name: "Bitcoin vs its 50-day average (market mood)" },
  { key: "btcDist200", name: "Bitcoin vs its 200-day average (market mood)" },
] as const;
export const P = FEATURES.length;
export type FeatureKey = (typeof FEATURES)[number]["key"];
export const featureIndex = (k: FeatureKey) => FEATURES.findIndex(f => f.key === k);

/** Whole days since 1970 for a YYYY-MM-DD date, so "exactly 7 days later" is plain arithmetic. */
export const dayNumber = (d: string) => Math.round(Date.parse(d + "T00:00:00Z") / 864e5);
export const dayString = (n: number) => new Date(n * 864e5).toISOString().slice(0, 10);

function longAverage(c: readonly number[]): (number | null)[] {
  const s200 = sma(c, LONG), out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < c.length; i++) { sum += c[i]; out.push(s200[i] ?? (i + 1 >= MIN_ROWS ? sum / (i + 1) : null)); }
  return out;
}

/** Bitcoin's trend on each day, the model's picture of the market's mood: [30-day return, vs 50-day average, vs long average]. */
export function btcRegime(btc: History): Map<number, [number, number, number]> {
  const c = btc.closes, s50 = sma(c, 50), sl = longAverage(c), out = new Map<number, [number, number, number]>();
  for (let i = 30; i < c.length; i++) {
    const a = s50[i], b = sl[i];
    if (a == null || b == null) continue;
    out.set(dayNumber(btc.dates[i]), [Math.log(c[i] / c[i - 30]), Math.log(c[i] / a), Math.log(c[i] / b)]);
  }
  return out;
}

/**
 * The feature row for each day of a coin's history (null while there isn't enough history, or where days
 * are missing from it). Returns and distances are log ratios, so +10% and -10% are about the same size.
 */
export function coinFeatures(h: History, regime: Map<number, [number, number, number]>): (number[] | null)[] {
  const c = h.closes, v = h.volumes, n = c.length;
  const days = h.dates.map(dayNumber);
  const s20 = sma(c, 20), s50 = sma(c, 50), sl = longAverage(c), r = rsi(c), m = macd(c);
  const lr: number[] = [0];
  for (let i = 1; i < n; i++) lr.push(Math.log(c[i] / c[i - 1]));
  const out: (number[] | null)[] = [];
  for (let i = 0; i < n; i++) {
    const reg = regime.get(days[i]);
    const a20 = s20[i], a50 = s50[i], al = sl[i], R = r[i], M = m.m[i], H = m.hist[i];
    // A few missing days are tolerated; more would make "90 days ago" mean something else.
    if (i + 1 < MIN_ROWS || !reg || a20 == null || a50 == null || al == null || R == null || M == null || H == null || days[i] - days[i - 90] > 93) { out.push(null); continue; }
    let s = 0, ss = 0;
    for (let j = i - 29; j <= i; j++) { s += lr[j]; ss += lr[j] * lr[j]; }
    const vol30 = Math.sqrt(Math.max(0, (ss - s * s / 30) / 29));
    let v7 = 0, v30 = 0;
    for (let j = i - 29; j <= i; j++) { v30 += v[j] ?? 0; if (j > i - 7) v7 += v[j] ?? 0; }
    let high = c[i];
    for (let j = Math.max(0, i - 364); j < i; j++) if (c[j] > high) high = c[j];
    out.push([
      lr[i], Math.log(c[i] / c[i - 7]), Math.log(c[i] / c[i - 30]), Math.log(c[i] / c[i - 90]),
      vol30, (R - 50) / 50, M / c[i], H / c[i],
      Math.log(c[i] / a20), Math.log(c[i] / a50), Math.log(c[i] / al),
      v7 > 0 && v30 > 0 ? Math.log((v7 / 7) / (v30 / 30)) : 0,
      c[i] / high - 1,
      reg[0], reg[1], reg[2],
    ]);
  }
  return out;
}

/** One coin on one day: its features and, where they are known by now, what happened next. */
export interface Sample {
  coin: string;
  /** Days since 1970 (see `dayNumber`). */
  day: number;
  x: number[];
  /** The log return from this day's close to the close exactly h days later; null when that close doesn't exist (yet). */
  fwd: Record<Horizon, number | null>;
}

/** Every coin-day with a full feature row, oldest day first. */
export function buildSamples(histories: ReadonlyMap<string, History>): Sample[] {
  const btc = histories.get("bitcoin");
  if (!btc) throw new Error("Bitcoin's history is needed (its trend is one of the model's inputs)");
  const regime = btcRegime(btc), out: Sample[] = [];
  for (const [coin, h] of histories) {
    const rows = coinFeatures(h, regime);
    const days = h.dates.map(dayNumber), at = new Map(days.map((d, i) => [d, i] as const));
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i];
      if (!x) continue;
      const fwd = {} as Record<Horizon, number | null>;
      for (const hz of HORIZONS) { const j = at.get(days[i] + hz); fwd[hz] = j == null ? null : Math.log(h.closes[j] / h.closes[i]); }
      out.push({ coin, day: days[i], x, fwd });
    }
  }
  return out.sort((a, b) => a.day - b.day || (a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : 0));
}
