/**
 * Backtester on daily closes. No peeking ahead: the decision to hold on day i is made from data up to
 * day i-1 (yesterday's close and the indicators computed from it), and the trade happens at day i's close.
 */
import { macd, maxDrawdown, rsi, sma } from "./indicators";

export type Strategy = "hold" | "sma" | "cross" | "rsi" | "macd" | "dca";

export interface BacktestOptions {
  /** Fee per trade as a fraction (0.0025 = 0.25%). */
  fee: number;
  /** First day traded (earlier days warm up the indicators). */
  start: number;
  len?: number;
  fast?: number;
  slow?: number;
  /** RSI: buy when it falls below lo, sell when it rises above hi. */
  lo?: number;
  hi?: number;
}

export interface BacktestResult {
  /** Portfolio value at each close from `start` on, starting with €1,000. */
  eq: number[];
  final: number;
  ret: number;
  mdd: number;
  trades: number;
  /** Share of days with money in the coin. */
  exposure: number;
}

export const START_CAPITAL = 1000;

/** Whether the strategy wants to be in the coin on each day, decided from the previous day's data. */
export function positions(c: readonly number[], strategy: Exclude<Strategy, "dca">, opt: BacktestOptions): boolean[] {
  const n = c.length, start = opt.start;
  const want: boolean[] = new Array(n).fill(false);
  if (strategy === "hold") {
    for (let i = start; i < n; i++) want[i] = true;
  } else if (strategy === "sma") {
    const s = sma(c, opt.len ?? 50);
    for (let i = start; i < n; i++) { const v = s[i - 1]; want[i] = v != null && c[i - 1] > v; }
  } else if (strategy === "cross") {
    const f = sma(c, opt.fast ?? 20), sl = sma(c, opt.slow ?? 50);
    for (let i = start; i < n; i++) { const a = f[i - 1], b = sl[i - 1]; want[i] = a != null && b != null && a > b; }
  } else if (strategy === "rsi") {
    const r = rsi(c), lo = opt.lo ?? 30, hi = opt.hi ?? 70;
    let pos = false;
    for (let i = start; i < n; i++) {
      const v = r[i - 1];
      if (v != null) { if (!pos && v < lo) pos = true; else if (pos && v > hi) pos = false; }
      want[i] = pos;
    }
  } else if (strategy === "macd") {
    const m = macd(c);
    for (let i = start; i < n; i++) { const a = m.m[i - 1], b = m.sig[i - 1]; want[i] = a != null && b != null && a > b; }
  }
  return want;
}

export function backtest(c: readonly number[], strategy: Strategy, opt: BacktestOptions): BacktestResult {
  const fee = opt.fee, start = opt.start, n = c.length;
  let cash = START_CAPITAL, units = 0, trades = 0, inMkt = 0;
  const eq: number[] = [];
  if (strategy === "dca") {
    // Spread the €1,000 evenly over every 7th day from `start`.
    const buys = Math.ceil((n - start) / 7), chunk = START_CAPITAL / buys;
    let left = START_CAPITAL;
    for (let i = start; i < n; i++) {
      if ((i - start) % 7 === 0 && left > 1e-9) { const amt = Math.min(chunk, left); left -= amt; units += amt * (1 - fee) / c[i]; trades++; }
      cash = left;
      eq.push(cash + units * c[i]);
      if (units > 0) inMkt++;
    }
  } else {
    const want = positions(c, strategy, opt);
    for (let i = start; i < n; i++) {
      if (want[i] && units === 0) { units = cash * (1 - fee) / c[i]; cash = 0; trades++; }
      else if (!want[i] && units > 0) { cash = units * c[i] * (1 - fee); units = 0; trades++; }
      eq.push(cash + units * c[i]);
      if (units > 0) inMkt++;
    }
  }
  const final = eq[eq.length - 1];
  return { eq, final, ret: final / START_CAPITAL - 1, mdd: maxDrawdown(eq), trades, exposure: inMkt / eq.length };
}
