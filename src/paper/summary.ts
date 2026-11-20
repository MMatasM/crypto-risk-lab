/** Leaderboards and equity curves from the paper trading state, shared by the app and the daily job's report. */
import { maxDrawdown } from "../analysis/indicators";
import { START_CAPITAL } from "../analysis/backtest";
import { MODEL_THRESHOLD, pairOffset } from "./trader";
import type { PaperSettings, PaperState, PaperStrategy, PairState } from "./types";

export function strategyName(s: PaperStrategy, k: PaperSettings): string {
  switch (s) {
    case "hold": return "Buy and hold";
    case "dca": return `Weekly DCA (${k.dcaWeeks} weeks)`;
    case "sma": return `Above ${k.smaLength}-day average`;
    case "cross": return `${k.fast}/${k.slow} crossover`;
    case "macd": return "MACD above signal";
    case "rsi": return `RSI ${k.rsiBuyBelow}/${k.rsiSellAbove}`;
    case "model": return `Model: 7-day chance above ${((k.modelThreshold ?? MODEL_THRESHOLD) * 100).toFixed(0)}%`;
  }
}

export interface Row {
  strategy: PaperStrategy;
  name: string;
  /** Starting money (€1,000 per coin). */
  capital: number;
  value: number;
  ret: number;
  /** Worst fall from a high, as a negative fraction. */
  mdd: number;
  trades: number;
  /**
   * Return minus buy and hold's return over the same days (+0.02 = 2 percentage points ahead). Null for buy
   * and hold itself. A strategy that started later is compared with buying and holding from its own first day.
   */
  vsHold: number | null;
  /** The first day traded. */
  since: string;
}

/** One pair's dates and values. */
export function pairCurve(state: PaperState, coin: string, p: PairState): { dates: string[]; eq: number[] } {
  const cs = state.coins[coin], o = pairOffset(cs, p);
  return { dates: cs.dates.slice(o, o + p.equity.length), eq: p.equity };
}

export interface Curve { strategy: PaperStrategy; name: string; dates: string[]; eq: number[]; capital: number; trades: number }

/**
 * Each strategy's curve, for one coin or (coin = null) all coins added together. Added-together curves
 * only cover the days every coin was traded, so a coin joining later doesn't look like a gain.
 */
export function curves(state: PaperState, coin: string | null, strategies: PaperStrategy[]): Curve[] {
  const coins = coin ? [coin] : Object.keys(state.coins);
  const out: Curve[] = [];
  for (const s of strategies) {
    const parts = coins.flatMap(c => { const p = state.coins[c]?.pairs[s]; return p ? [{ ...pairCurve(state, c, p), trades: p.trades, settings: p.settings }] : []; });
    if (!parts.length) continue;
    const name = strategyName(s, parts[0].settings);
    if (parts.length === 1) { out.push({ strategy: s, name, dates: parts[0].dates, eq: parts[0].eq, capital: START_CAPITAL, trades: parts[0].trades }); continue; }
    const maps = parts.map(x => new Map(x.dates.map((d, i) => [d, x.eq[i]] as const)));
    const dates = parts[0].dates.filter(d => maps.every(m => m.has(d)));
    out.push({ strategy: s, name, dates, eq: dates.map(d => maps.reduce((sum, m) => sum + m.get(d)!, 0)), capital: START_CAPITAL * parts.length, trades: parts.reduce((t, x) => t + x.trades, 0) });
  }
  return out;
}

/** The leaderboard: best end value first. */
export function board(cs: Curve[]): Row[] {
  const rows: Row[] = cs.filter(c => c.eq.length).map(c => {
    const value = c.eq[c.eq.length - 1];
    return { strategy: c.strategy, name: c.name, capital: c.capital, value, ret: value / c.capital - 1, mdd: maxDrawdown(c.eq), trades: c.trades, vsHold: null, since: c.dates[0] };
  });
  const hold = cs.find(c => c.strategy === "hold" && c.eq.length);
  for (const r of rows) {
    if (!hold || r.strategy === "hold") continue;
    const c = cs.find(x => x.strategy === r.strategy)!;
    // Buying and holding from this strategy's first day: buy and hold's own curve from that day on, scaled so
    // it starts where a fresh purchase would (its first value is the money left after the fee and slippage).
    const from = hold.dates.indexOf(c.dates[0]), to = hold.dates.indexOf(c.dates[c.dates.length - 1]);
    if (from < 0 || to < 0) continue;
    r.vsHold = r.ret - (hold.eq[to] / hold.eq[from] * (hold.eq[0] / hold.capital) - 1);
  }
  return rows.sort((a, b) => b.ret - a.ret);
}

/** Days traded so far (the longest-running coin). */
export const daysOfData = (state: PaperState) => Math.max(0, ...Object.values(state.coins).map(c => c.dates.length));
