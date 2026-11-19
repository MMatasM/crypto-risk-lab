/**
 * Backtester on daily closes. No peeking ahead: the decision to hold on day i is made from data up to
 * day i-1 (yesterday's close and the indicators computed from it), and the trade happens at day i's close.
 *
 * The rules (`rule`) and the trading (`tradeDay`) are shared with paper trading (src/paper/trader.ts),
 * which runs the same two functions one day at a time, so the two can never disagree.
 */
import { macd, maxDrawdown, rsi, sma } from "./indicators";

export type Strategy = "hold" | "sma" | "cross" | "rsi" | "macd" | "dca";

export interface BacktestOptions {
  /** Fee per trade as a fraction (0.0025 = 0.25%). */
  fee: number;
  /** Slippage per trade as a fraction (0.001 = 0.10%): buys fill this much above the close, sells this much below. */
  slippage?: number;
  /** First day traded (earlier days warm up the indicators). */
  start: number;
  len?: number;
  fast?: number;
  slow?: number;
  /** RSI: buy when it falls below lo, sell when it rises above hi. */
  lo?: number;
  hi?: number;
  /** Weekly DCA: euros bought every 7th day. Default: the €1,000 split evenly over the weeks tested. */
  dcaChunk?: number;
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

/** A rule that decides, each day, whether to be in the coin. */
export interface Rule {
  /** Whether to hold the coin on day i, from data up to day i-1. `held`: whether the rule held it on day i-1. */
  want(i: number, held: boolean): boolean;
  /** The reason for the decision on day i, in plain words. */
  why(i: number, want: boolean): string;
}

/** Short euro amount for trade reasons (€86,123 / €2.31 / €0.4512). */
const money = (v: number) => "€" + (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-IE") : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(4));

/**
 * The rule for a strategy on a series of closes. Indicators are computed once, over the whole series;
 * every indicator value at day i-1 uses only closes up to day i-1, so later closes never change a decision.
 */
export function rule(c: readonly number[], strategy: Exclude<Strategy, "dca">, opt: BacktestOptions): Rule {
  if (strategy === "hold") return { want: () => true, why: () => "Buy and hold: buys on the first day and never sells" };
  if (strategy === "sma") {
    const len = opt.len ?? 50, s = sma(c, len);
    return {
      want: i => { const v = s[i - 1]; return v != null && c[i - 1] > v; },
      why: i => { const v = s[i - 1]; return v == null ? "Not enough history for the average yet" : `Close ${money(c[i - 1])} was ${c[i - 1] > v ? "above" : "not above"} its ${len}-day average ${money(v)}`; },
    };
  }
  if (strategy === "cross") {
    const fast = opt.fast ?? 20, slow = opt.slow ?? 50, f = sma(c, fast), sl = sma(c, slow);
    return {
      want: i => { const a = f[i - 1], b = sl[i - 1]; return a != null && b != null && a > b; },
      why: i => { const a = f[i - 1], b = sl[i - 1]; return a == null || b == null ? "Not enough history for the averages yet" : `${fast}-day average ${money(a)} was ${a > b ? "above" : "not above"} the ${slow}-day average ${money(b)}`; },
    };
  }
  if (strategy === "rsi") {
    const r = rsi(c), lo = opt.lo ?? 30, hi = opt.hi ?? 70;
    return {
      want: (i, held) => {
        const v = r[i - 1];
        if (v == null) return held;
        if (!held && v < lo) return true;
        if (held && v > hi) return false;
        return held;
      },
      why: (i, want) => { const v = r[i - 1]; return v == null ? "Not enough history for RSI yet" : `RSI ${v.toFixed(1)} ${want ? `fell below ${lo} (oversold)` : `rose above ${hi} (overbought)`}`; },
    };
  }
  const m = macd(c);
  return {
    want: i => { const a = m.m[i - 1], b = m.sig[i - 1]; return a != null && b != null && a > b; },
    why: i => { const a = m.m[i - 1], b = m.sig[i - 1]; return a == null || b == null ? "Not enough history for MACD yet" : `MACD ${a.toPrecision(3)} was ${a > b ? "above" : "not above"} its signal line ${b.toPrecision(3)}`; },
  };
}

/** Whether the strategy wants to be in the coin on each day, decided from the previous day's data. */
export function positions(c: readonly number[], strategy: Exclude<Strategy, "dca">, opt: BacktestOptions): boolean[] {
  const want: boolean[] = new Array(c.length).fill(false), r = rule(c, strategy, opt);
  let held = false;
  for (let i = opt.start; i < c.length; i++) { want[i] = r.want(i, held); held = want[i]; }
  return want;
}

/** Money and coins held by one strategy on one coin. */
export interface Book { cash: number; units: number; trades: number }

export interface Costs {
  /** Fee per trade as a fraction of the amount traded. */
  fee: number;
  /** Buys fill this fraction above the close, sells this fraction below. */
  slippage: number;
}

/** One trade. Money amounts are in euros. */
export interface Fill {
  side: "buy" | "sell";
  /** The day's close. */
  close: number;
  /** The price actually paid or received (the close plus or minus slippage). */
  price: number;
  units: number;
  /** Euros spent (buy, fee included) or received (sell, after the fee). */
  amount: number;
  fee: number;
  /** Euros lost to slippage compared with trading exactly at the close. */
  slippage: number;
}

function buy(b: Book, eur: number, close: number, k: Costs): Fill {
  const price = close * (1 + k.slippage), units = eur * (1 - k.fee) / price;
  b.cash -= eur; b.units += units; b.trades++;
  return { side: "buy", close, price, units, amount: eur, fee: eur * k.fee, slippage: eur * (1 - k.fee) - units * close };
}

function sellAll(b: Book, close: number, k: Costs): Fill {
  const units = b.units, price = close * (1 - k.slippage), gross = units * price, amount = gross * (1 - k.fee);
  b.cash = amount; b.units = 0; b.trades++;
  return { side: "sell", close, price, units, amount, fee: gross * k.fee, slippage: units * close - gross };
}

/**
 * One day of trading at that day's close. `day` counts days from the first traded day (0, 1, 2, …);
 * `want` is the rule's decision (ignored by DCA, which buys `dcaChunk` euros every 7th day until the cash runs out).
 */
export function tradeDay(b: Book, strategy: Strategy, day: number, close: number, want: boolean, k: Costs, dcaChunk: number): Fill | null {
  if (strategy === "dca") {
    if (day % 7 === 0 && b.cash > 1e-9) return buy(b, Math.min(dcaChunk, b.cash), close, k);
    return null;
  }
  if (want && b.units === 0) return buy(b, b.cash, close, k);
  if (!want && b.units > 0) return sellAll(b, close, k);
  return null;
}

export function backtest(c: readonly number[], strategy: Strategy, opt: BacktestOptions): BacktestResult {
  const start = opt.start, n = c.length, k: Costs = { fee: opt.fee, slippage: opt.slippage ?? 0 };
  const chunk = opt.dcaChunk ?? START_CAPITAL / Math.ceil((n - start) / 7);
  const r = strategy === "dca" ? null : rule(c, strategy, opt);
  const b: Book = { cash: START_CAPITAL, units: 0, trades: 0 };
  const eq: number[] = [];
  let held = false, inMkt = 0;
  for (let i = start; i < n; i++) {
    const want: boolean = r ? r.want(i, held) : false;
    tradeDay(b, strategy, i - start, c[i], want, k, chunk);
    held = want;
    eq.push(b.cash + b.units * c[i]);
    if (b.units > 0) inMkt++;
  }
  const final = eq[eq.length - 1];
  return { eq, final, ret: final / START_CAPITAL - 1, mdd: maxDrawdown(eq), trades: b.trades, exposure: inMkt / eq.length };
}
