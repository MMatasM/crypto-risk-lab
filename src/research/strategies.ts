/**
 * The paper-trading strategies on long history. Nothing is re-implemented: the trades are made by the paper
 * trader's own `advance` (the six rules and the per-coin model strategy) and `advancePortfolio` (the weekly
 * top-k rotation and its two benchmarks), started on a chosen day in the past and fed that day's prices and
 * the walk-forward forecasts, with the same fee, slippage and timing (decide after one close, trade at the next).
 * Pure functions: no network, no files, no clock.
 */
import { START_CAPITAL } from "../analysis/backtest";
import { maxDrawdown } from "../analysis/indicators";
import { analyze, MIN_DAYS } from "../analysis/scoring";
import type { History } from "../data/types";
import { advancePortfolio, BOOKS, emptyPortfolio, type BookKey, type DaySignals } from "../paper/portfolio";
import { advance, WARMUP_DAYS, type Signals } from "../paper/trader";
import { emptyState, type Closes, type PaperConfig, type PaperStrategy, type PriceFile } from "../paper/types";
import { bootstrapByWeek, type Boot } from "./phases";

/** Value over time as a multiple of the starting money (1 = the start), one value per date. */
export interface Curve { dates: string[]; eq: number[] }

/** The index of the first date on or after `d` (the list's length when there is none). */
export function firstOnOrAfter(dates: readonly string[], d: string): number {
  let lo = 0, hi = dates.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] < d) lo = m + 1; else hi = m; }
  return lo;
}
const firstAfter = (dates: readonly string[], d: string) => { const i = firstOnOrAfter(dates, d); return dates[i] === d ? i + 1 : i; };

export interface PairRun extends Curve { trades: number }

/**
 * Every strategy in `config.strategies` on each coin, each with its own money, trading every close from
 * `start` to `end`. A coin takes part only if it has `WARMUP_DAYS` closes before `start` (as in paper trading)
 * and, when the model strategy is among them, a forecast made from its last close before `start`, so that
 * every strategy trades the same days. Prices after `end` are never seen.
 */
export function runPairs(prices: PriceFile, signals: Signals, config: PaperConfig, coins: readonly string[], start: string, end: string): Map<string, Map<PaperStrategy, PairRun>> {
  const window: PriceFile = {}, state = emptyState(), used: string[] = [];
  const needForecast = config.strategies.includes("model");
  for (const coin of coins) {
    const p = prices[coin];
    if (!p) continue;
    const first = firstOnOrAfter(p.dates, start), stop = firstAfter(p.dates, end);
    if (first < WARMUP_DAYS || first >= stop) continue;
    const seed = p.dates[first - 1];
    if (needForecast && signals[coin]?.[seed] == null) continue;
    window[coin] = { dates: p.dates.slice(0, stop), closes: p.closes.slice(0, stop) };
    // The paper trader carries on from the last day it traded: telling it that was the day before `start` starts it there.
    state.coins[coin] = { dates: [seed], pairs: {} };
    used.push(coin);
  }
  const r = advance(state, window, { ...config, coins: used }, signals);
  const out = new Map<string, Map<PaperStrategy, PairRun>>();
  for (const coin of used) {
    const cs = r.state.coins[coin], runs = new Map<PaperStrategy, PairRun>();
    for (const s of config.strategies) {
      const pair = cs.pairs[s];
      if (pair?.equity.length) runs.set(s, { dates: cs.dates.slice(cs.dates.length - pair.equity.length), eq: pair.equity.map(v => v / START_CAPITAL), trades: pair.trades });
    }
    out.set(coin, runs);
  }
  return out;
}

/**
 * Equal money in each run, as one curve on `dates`: the average of the runs' values. A run without a value
 * on a day keeps its last one (a market with no trades that day, or one that was suspended); before its first
 * day it is still cash.
 */
export function combine(runs: readonly Curve[], dates: readonly string[]): Curve {
  const eq = new Array<number>(dates.length).fill(0);
  for (const r of runs) {
    let j = 0, v = 1;
    for (let i = 0; i < dates.length; i++) { while (j < r.dates.length && r.dates[j] <= dates[i]) v = r.eq[j++]; eq[i] += v; }
  }
  return { dates: [...dates], eq: eq.map(v => (runs.length ? v / runs.length : 1)) };
}

/** Consecutive periods joined into one curve: each starts with the money the one before ended with. */
export function chain(parts: readonly Curve[]): Curve {
  const out: Curve = { dates: [], eq: [] };
  let level = 1;
  for (const p of parts) {
    if (!p.eq.length) continue;
    for (let i = 0; i < p.eq.length; i++) { out.dates.push(p.dates[i]); out.eq.push(level * p.eq[i]); }
    level *= p.eq[p.eq.length - 1];
  }
  return out;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

export interface CurveStats {
  /** Total return (1 = +100%). */
  ret: number;
  /** The same as a yearly rate. */
  cagr: number;
  /** The worst fall from a high, as a negative fraction; the starting money counts as the first high. */
  mdd: number;
}

export function curveStats(c: Curve): CurveStats {
  if (!c.eq.length) return { ret: 0, cagr: 0, mdd: 0 };
  const final = c.eq[c.eq.length - 1], days = daysBetween(c.dates[0], c.dates[c.dates.length - 1]) + 1;
  return { ret: final - 1, cagr: final > 0 ? final ** (365.25 / days) - 1 : -1, mdd: maxDrawdown([1, ...c.eq]) };
}

/** Each calendar year's return and worst drop, from the value at the end of the year before (null for a year the curve doesn't cover). */
export function yearStats(c: Curve, years: readonly number[]): { ret: (number | null)[]; mdd: (number | null)[] } {
  const ret: (number | null)[] = [], mdd: (number | null)[] = [];
  for (const y of years) {
    const a = firstOnOrAfter(c.dates, `${y}-01-01`), b = firstOnOrAfter(c.dates, `${y + 1}-01-01`);
    if (a >= b) { ret.push(null); mdd.push(null); continue; }
    const before = a > 0 ? c.eq[a - 1] : 1;
    ret.push(c.eq[b - 1] / before - 1);
    mdd.push(maxDrawdown([before, ...c.eq.slice(a, b)]));
  }
  return { ret, mdd };
}

export interface RegimeSplit { days: number; ret: number }

/**
 * The curve's daily returns compounded separately over two kinds of days: those entered with Bitcoin above
 * its 200-day average (as known at the close before) and those entered with it below.
 */
export function regimeSplit(c: Curve, above: ReadonlyMap<string, boolean>): { above: RegimeSplit; below: RegimeSplit } {
  const out = { above: { days: 0, ret: 1 }, below: { days: 0, ret: 1 } };
  for (let i = 1; i < c.eq.length; i++) {
    const a = above.get(c.dates[i - 1]);
    if (a == null || !(c.eq[i - 1] > 0)) continue;
    const side = a ? out.above : out.below;
    side.days++; side.ret *= c.eq[i] / c.eq[i - 1];
  }
  out.above.ret -= 1; out.below.ret -= 1;
  return out;
}

/**
 * By how much curve `a` outgrew curve `b`, as a yearly rate (0.05 = 5 percentage points a year faster), with a
 * 95% range from a block bootstrap of the daily differences by week (runs of `blockWeeks` weeks). A range
 * that includes zero means the gap is within what luck would explain.
 */
export function edgeOver(a: Curve, b: Curve, blockWeeks = 4, rounds = 2000): Boot {
  const at = new Map(b.dates.map((d, i) => [d, i] as const)), day: number[] = [], gap: number[] = [];
  let pa = 0, pb = 0; // the first shared day only sets the levels
  for (let i = 0; i < a.dates.length; i++) {
    const j = at.get(a.dates[i]);
    if (j == null) continue;
    if (pa > 0 && pb > 0 && a.eq[i] > 0 && b.eq[j] > 0) { day.push(Math.round(Date.parse(a.dates[i] + "T00:00:00Z") / 864e5)); gap.push(Math.log(a.eq[i] / pa) - Math.log(b.eq[j] / pb)); }
    pa = a.eq[i]; pb = b.eq[j];
  }
  const r = bootstrapByWeek(day, gap, null, blockWeeks, rounds), yearly = (v: number | null) => (v == null ? null : Math.expm1(v * 365.25));
  return { mean: yearly(r.mean) as number, lo: yearly(r.lo), hi: yearly(r.hi), below: r.below, weeks: r.weeks };
}

/**
 * Each coin's place by trading volume on each day (1 = most traded on Bitvavo over the last `days` days).
 * Bitvavo's public data has no market caps, so this stands in for the scan's market-cap rank when the
 * portfolio picks "the biggest coins". Only what was known on the day is used.
 */
export function volumeRanks(histories: ReadonlyMap<string, History>, from: string, days = 30): Map<string, Record<string, number>> {
  const byDate = new Map<string, [string, number][]>();
  for (const [coin, h] of histories) {
    let sum = 0;
    for (let i = 0; i < h.dates.length; i++) {
      sum += h.volumes[i] ?? 0;
      if (i >= days) sum -= h.volumes[i - days] ?? 0;
      if (i < days - 1 || h.dates[i] < from) continue;
      let list = byDate.get(h.dates[i]);
      if (!list) byDate.set(h.dates[i], list = []);
      list.push([coin, sum / days]);
    }
  }
  const out = new Map<string, Record<string, number>>();
  for (const [date, list] of byDate) {
    list.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    out.set(date, Object.fromEntries(list.map(([coin], i) => [coin, i + 1])));
  }
  return out;
}

/**
 * The scan's composite score for each coin on each day from `from` on, from the `window` days before it (the
 * nightly scan sees a year). Without market caps the score's size and liquidity parts are the same for every
 * coin, so here it ranks coins on trend, volatility and drawdown only.
 */
export function compositeScores(histories: ReadonlyMap<string, History>, from: string, window = 365): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const [coin, h] of histories) {
    for (let i = Math.max(MIN_DAYS - 1, firstOnOrAfter(h.dates, from)); i < h.dates.length; i++) {
      const a = Math.max(0, i + 1 - window);
      const score = analyze({ dates: h.dates.slice(a, i + 1), closes: h.closes.slice(a, i + 1), volumes: h.volumes.slice(a, i + 1) }, null, null).composite;
      let day = out.get(h.dates[i]);
      if (!day) out.set(h.dates[i], day = {});
      day[coin] = Math.round(score * 10) / 10; // the scan saves one decimal
    }
  }
  return out;
}

/** What the weekly portfolio knew after each day's close: scores, size ranks and the 7-day chance of a rise. */
export function daySignals(composite: ReadonlyMap<string, Record<string, number>>, ranks: ReadonlyMap<string, Record<string, number>>, chance: Readonly<Record<string, Record<string, number>>>): Record<string, DaySignals> {
  const out: Record<string, DaySignals> = {};
  for (const [date, p] of Object.entries(chance)) out[date] = { composite: composite.get(date) ?? {}, mcapRank: ranks.get(date) ?? {}, p };
  return out;
}

export interface PortfolioRun { dates: string[]; books: Record<BookKey, PairRun> }

/**
 * The weekly top-k portfolio and its two benchmarks (buy and hold Bitcoin; equal weight of the same universe,
 * bought once and held), all started with fresh money on the first Bitcoin close on or after `start` and run
 * to `end`. Null when Bitcoin has no close before `start` or none in the period.
 */
export function runPortfolio(prices: Readonly<Record<string, Closes>>, signals: Record<string, DaySignals>, config: PaperConfig, start: string, end: string): PortfolioRun | null {
  const btc = prices.bitcoin;
  if (!btc || !config.portfolio) return null;
  const first = firstOnOrAfter(btc.dates, start);
  if (first < 1 || first >= firstAfter(btc.dates, end)) return null;
  const window: Record<string, Closes> = {};
  for (const [coin, p] of Object.entries(prices)) { const stop = firstAfter(p.dates, end); if (stop) window[coin] = { dates: p.dates.slice(0, stop), closes: p.closes.slice(0, stop) }; }
  const state = emptyPortfolio();
  state.lastDate = btc.dates[first - 1]; // "the last day traded": the portfolio starts on the next close
  const r = advancePortfolio(state, window, signals, config).state;
  if (!r.dates.length) return null;
  const books = {} as Record<BookKey, PairRun>;
  for (const k of BOOKS) books[k] = { dates: r.dates, eq: r.books[k].equity.map(v => v / START_CAPITAL), trades: r.books[k].trades };
  return { dates: r.dates, books };
}

export interface YearWindow { year: number; start: string; end: string }

/** The calendar years from `first` to `last`, the first and last cut to those days. */
export function yearWindows(first: string, last: string): YearWindow[] {
  const out: YearWindow[] = [];
  for (let y = Number(first.slice(0, 4)); y <= Number(last.slice(0, 4)); y++) {
    const start = `${y}-01-01` < first ? first : `${y}-01-01`, end = `${y}-12-31` > last ? last : `${y}-12-31`;
    if (start <= end) out.push({ year: y, start, end });
  }
  return out;
}

export interface MarketYear {
  window: YearWindow;
  /** Coins traded this year. */
  coins: number;
  /** Per strategy: equal money in every coin, as one curve. */
  curves: Map<PaperStrategy, Curve>;
  /** Per strategy: trades per coin, and the share of coins on which it ended the year ahead of buying and holding that coin. */
  trades: Map<PaperStrategy, number>;
  beatHold: Map<PaperStrategy, number>;
}

/**
 * One calendar year of the whole market: every coin that could be traded on the year's first day gets fresh
 * money for each strategy. Coins that later collapsed are in for as long as they traded.
 */
export function marketYear(prices: PriceFile, signals: Signals, config: PaperConfig, window: YearWindow, calendar: readonly string[]): MarketYear {
  const runs = runPairs(prices, signals, config, Object.keys(prices), window.start, window.end);
  const dates = calendar.slice(firstOnOrAfter(calendar, window.start), firstAfter(calendar, window.end));
  const out: MarketYear = { window, coins: runs.size, curves: new Map(), trades: new Map(), beatHold: new Map() };
  for (const s of config.strategies) {
    const list = [...runs.values()].map(m => m.get(s)).filter((r): r is PairRun => !!r);
    out.curves.set(s, combine(list, dates));
    out.trades.set(s, list.length ? list.reduce((n, r) => n + r.trades, 0) / list.length : 0);
    let beat = 0, n = 0;
    for (const m of runs.values()) { const a = m.get(s), b = m.get("hold"); if (a && b) { n++; if (a.eq[a.eq.length - 1] > b.eq[b.eq.length - 1]) beat++; } }
    out.beatHold.set(s, n ? beat / n : 0);
  }
  return out;
}
