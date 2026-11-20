/**
 * The forecast log (one CSV file per night) and the live track record built from it: each logged forecast
 * is scored once the close exactly 7 or 30 days later exists. Pure functions.
 */
import type { History } from "../data/types";
import { dayNumber, dayString, HORIZONS, type Horizon } from "./features";
import { evaluate } from "./report";
import type { LogRow, TrackFile } from "./types";
import type { Tested } from "./walkforward";

const HEADER = "date,coin,h,logit,gbt,base,momentum,trendUp,mu,lo,hi";

export function logToCsv(rows: readonly LogRow[]): string {
  const f = (x: number, d: number) => x.toFixed(d);
  return [HEADER, ...rows.map(r => [r.date, r.coin, r.h, f(r.logit, 4), f(r.gbt, 4), f(r.base, 4), f(r.momentum, 4), r.trendUp ? 1 : 0, f(r.mu, 5), f(r.lo, 5), f(r.hi, 5)].join(","))].join("\n") + "\n";
}

export function parseLog(text: string): LogRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines[0] !== HEADER) throw new Error(`expected the first line to be "${HEADER}"`);
  return lines.slice(1).map(line => {
    const c = line.split(","), n = c.slice(3).map(Number);
    if (c.length !== 11 || n.some(v => !Number.isFinite(v)) || (c[2] !== "7" && c[2] !== "30")) throw new Error(`a bad line: "${line}"`);
    return { date: c[0], coin: c[1], h: Number(c[2]) as Horizon, logit: n[0], gbt: n[1], base: n[2], momentum: n[3], trendUp: n[4] === 1, mu: n[5], lo: n[6], hi: n[7] };
  });
}

/** Where a night's log file lives, relative to the log folder. */
export const logPath = (date: string) => `${date.slice(0, 7)}/${date}.csv`;

/** The logged forecasts whose outcome is known by now, with that outcome; and how many are still waiting. */
export function resolve(log: readonly LogRow[], histories: ReadonlyMap<string, History>, h: Horizon): { rows: Tested[]; pending: number } {
  const index = new Map<string, Map<number, number>>();
  const rows: Tested[] = [];
  let pending = 0;
  for (const r of log) {
    if (r.h !== h) continue;
    const hist = histories.get(r.coin);
    let at = index.get(r.coin);
    if (hist && !at) index.set(r.coin, at = new Map(hist.dates.map((d, i) => [dayNumber(d), hist.closes[i]] as const)));
    const day = dayNumber(r.date), c0 = at?.get(day), c1 = at?.get(day + h);
    if (c0 == null || c1 == null) { pending++; continue; }
    const ret = Math.log(c1 / c0);
    rows.push({ coin: r.coin, day, r: ret, y: ret > 0 ? 1 : 0, logit: r.logit, gbt: r.gbt, base: r.base, momentum: r.momentum, trendUp: r.trendUp, mu: r.mu, lo: r.lo, hi: r.hi });
  }
  return { rows, pending };
}

export function trackRecord(log: readonly LogRow[], histories: ReadonlyMap<string, History>, generatedAt: string): TrackFile {
  const nights = [...new Set(log.map(r => r.date))].sort();
  const horizons: TrackFile["horizons"] = {};
  for (const h of HORIZONS) {
    const { rows, pending } = resolve(log, histories, h);
    horizons[h] = { ...evaluate(rows, h), pending, firstResolves: nights.length ? dayString(dayNumber(nights[0]) + h) : null };
  }
  return { generatedAt, since: nights[0] ?? null, latest: nights[nights.length - 1] ?? null, nights: nights.length, horizons };
}
