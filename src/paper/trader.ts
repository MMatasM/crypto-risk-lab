/**
 * The paper trader: fake money, real daily closes. Pure functions only (no network, no files, no clock),
 * so the daily job (scripts/paper-trade.ts) and the tests run exactly the same code.
 *
 * Each run trades every day that has a close the trader hasn't traded yet, oldest first, so running twice
 * in a day changes nothing and missed days are caught up in order. Each day uses the Backtest tab's own
 * `rule` (decided from data up to the day before) and `tradeDay` (trading at that day's close).
 */
import { rule, START_CAPITAL, tradeDay, type BacktestOptions, type Book, type Rule, type Strategy } from "../analysis/backtest";
import type { Closes, CoinState, PaperConfig, PaperState, PairState, PriceFile, TradeRecord } from "./types";

/** Closes needed before a coin's first traded day, so every indicator has warmed up (MACD needs 34). */
export const WARMUP_DAYS = 60;

export const STRATEGIES: Strategy[] = ["hold", "dca", "sma", "cross", "macd", "rsi"];

/** The backtester options for a pair's locked-in settings, with trading starting at index `start`. */
export function optionsFor(p: Pick<PairState, "fee" | "slippage" | "settings">, start: number): BacktestOptions {
  const s = p.settings;
  return { fee: p.fee, slippage: p.slippage, start, len: s.smaLength, fast: s.fast, slow: s.slow, lo: s.rsiBuyBelow, hi: s.rsiSellAbove, dcaChunk: START_CAPITAL / s.dcaWeeks };
}

/** Problems with a config file, in plain words (empty when it is fine). */
export function checkConfig(c: PaperConfig): string[] {
  const out: string[] = [];
  const isInt = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!Array.isArray(c.coins) || !c.coins.length || c.coins.some(x => typeof x !== "string" || !/^[a-z0-9-]+$/.test(x))) out.push("coins must be a list of CoinGecko ids such as \"bitcoin\"");
  else if (new Set(c.coins).size !== c.coins.length) out.push("coins lists a coin twice");
  if (!Array.isArray(c.strategies) || !c.strategies.length || c.strategies.some(s => !STRATEGIES.includes(s))) out.push(`strategies must be some of: ${STRATEGIES.join(", ")}`);
  else if (!c.strategies.includes("hold")) out.push("strategies must include \"hold\" (the baseline everything is compared with)");
  if (typeof c.fee !== "number" || !(c.fee >= 0 && c.fee <= 0.05)) out.push("fee must be a fraction between 0 and 0.05 (0.0025 = 0.25%)");
  if (typeof c.slippage !== "number" || !(c.slippage >= 0 && c.slippage <= 0.05)) out.push("slippage must be a fraction between 0 and 0.05 (0.001 = 0.10%)");
  const s = c.settings;
  if (!s) out.push("settings are missing");
  else {
    if (!isInt(s.smaLength, 2, WARMUP_DAYS - 1)) out.push(`settings.smaLength must be a whole number from 2 to ${WARMUP_DAYS - 1}`);
    if (!isInt(s.fast, 2, WARMUP_DAYS - 1) || !isInt(s.slow, 3, WARMUP_DAYS - 1) || s.fast >= s.slow) out.push(`settings.fast and settings.slow must be whole numbers with fast < slow < ${WARMUP_DAYS}`);
    if (!isInt(s.rsiBuyBelow, 1, 99) || !isInt(s.rsiSellAbove, 1, 99) || s.rsiBuyBelow >= s.rsiSellAbove) out.push("settings.rsiBuyBelow must be below settings.rsiSellAbove (both 1 to 99)");
    if (!isInt(s.dcaWeeks, 1, 520)) out.push("settings.dcaWeeks must be a whole number from 1 to 520");
  }
  return out;
}

export interface MergeResult {
  closes: Closes;
  /** New closes added. */
  added: number;
  /** Set when the fetched data looks wrong; the saved closes are then returned unchanged. */
  problem: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Adds freshly fetched closes to the saved ones. Only finished days count (dates before `today`, UTC);
 * saved closes are never changed. The fetch is refused, and nothing added, when it disagrees with the saved
 * closes it overlaps (a wrong coin or currency) or jumps implausibly from one day to the next (a glitch).
 */
export function mergeCloses(saved: Closes | undefined, fetched: Closes, today: string): MergeResult {
  const keep = (why: string): MergeResult => ({ closes: saved ?? { dates: [], closes: [] }, added: 0, problem: why });
  const f: Closes = { dates: [], closes: [] };
  for (let i = 0; i < fetched.dates.length; i++) {
    const d = fetched.dates[i], v = fetched.closes[i];
    if (!DAY.test(d) || d >= today) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return keep(`a bad price on ${d}`);
    if (f.dates.length && d <= f.dates[f.dates.length - 1]) return keep("dates out of order");
    f.dates.push(d); f.closes.push(v);
  }
  const base = saved ?? { dates: [], closes: [] };
  const last = base.dates[base.dates.length - 1];
  // Overlapping days must agree with what was saved (CoinGecko revises a little, never by much).
  const savedAt = new Map(base.dates.map((d, i) => [d, base.closes[i]] as const));
  const gaps = f.dates.flatMap((d, i) => (savedAt.has(d) ? [Math.abs(f.closes[i] / savedAt.get(d)! - 1)] : [])).sort((a, b) => a - b);
  if (gaps.length && gaps[Math.floor(gaps.length / 2)] > 0.05) return keep("the prices don't match the saved ones (wrong coin or currency?)");
  const out: Closes = { dates: [...base.dates], closes: [...base.closes] };
  let added = 0;
  for (let i = 0; i < f.dates.length; i++) {
    if (last && f.dates[i] <= last) continue;
    const prev = out.closes[out.closes.length - 1];
    if (prev && (f.closes[i] / prev > 5 || f.closes[i] / prev < 0.2)) return keep(`an implausible jump on ${f.dates[i]}`);
    out.dates.push(f.dates[i]); out.closes.push(f.closes[i]);
    added++;
  }
  return { closes: out, added, problem: null };
}

export interface AdvanceResult {
  state: PaperState;
  /** Trades made in this run, oldest first. */
  trades: TradeRecord[];
  /** Days traded in this run, per coin. */
  days: Record<string, string[]>;
  /** Coins skipped, with the reason. */
  notes: string[];
}

/** Where a pair's first day sits in its coin's list of traded days. */
export const pairOffset = (cs: CoinState, p: PairState) => cs.dates.indexOf(p.startDate);

/**
 * Trades every day in `prices` that hasn't been traded yet, oldest first. A coin seen for the first time
 * starts on its newest close (that is the "first run" start date); a strategy added to the config later
 * starts on the next day traded. Returns a new state; the one passed in is not changed.
 */
export function advance(state0: PaperState, prices: PriceFile, config: PaperConfig): AdvanceResult {
  const state: PaperState = structuredClone(state0);
  const trades: TradeRecord[] = [], days: Record<string, string[]> = {}, notes: string[] = [];
  for (const coin of config.coins) {
    const p = prices[coin];
    if (!p?.dates.length) { notes.push(`${coin}: no prices yet`); continue; }
    const cs: CoinState = state.coins[coin] ?? { dates: [], pairs: {} };
    const lastTraded = cs.dates[cs.dates.length - 1];
    let from: number;
    if (lastTraded) {
      from = p.dates.indexOf(lastTraded) + 1;
      if (from === 0) { notes.push(`${coin}: the saved prices don't include the last day traded (${lastTraded})`); continue; }
    } else {
      from = p.dates.length - 1;
      if (from < WARMUP_DAYS) { notes.push(`${coin}: only ${p.dates.length} days of prices; it needs ${WARMUP_DAYS + 1} to start`); continue; }
    }
    if (from >= p.dates.length) continue; // nothing new: already traded today's close
    state.coins[coin] = cs;
    days[coin] = [];
    const rules = new Map<Strategy, Rule>();
    for (let i = from; i < p.dates.length; i++) {
      const date = p.dates[i], close = p.closes[i];
      cs.dates.push(date);
      days[coin].push(date);
      for (const strategy of config.strategies) {
        let pair = cs.pairs[strategy];
        if (!pair) {
          pair = { strategy, startDate: date, fee: config.fee, slippage: config.slippage, settings: { ...config.settings }, cash: START_CAPITAL, units: 0, held: false, trades: 0, equity: [] };
          cs.pairs[strategy] = pair;
        }
        let r = rules.get(strategy);
        if (!r && strategy !== "dca") { r = rule(p.closes, strategy, optionsFor(pair, 0)); rules.set(strategy, r); }
        const want = r ? r.want(i, pair.held) : false;
        const book: Book = { cash: pair.cash, units: pair.units, trades: pair.trades };
        const fill = tradeDay(book, strategy, pair.equity.length, close, want, { fee: pair.fee, slippage: pair.slippage }, START_CAPITAL / pair.settings.dcaWeeks);
        if (fill) {
          const reason = r ? r.why(i, want) : `Weekly buy ${book.trades} of ${pair.settings.dcaWeeks}`;
          trades.push({ date, coin, strategy, side: fill.side, close: fill.close, price: fill.price, units: fill.units, amount: fill.amount, fee: fill.fee, slippage: fill.slippage, reason });
        }
        pair.cash = book.cash; pair.units = book.units; pair.trades = book.trades; pair.held = want;
        pair.equity.push(book.cash + book.units * close);
      }
    }
  }
  const all = Object.values(state.coins).flatMap(cs => Object.values(cs.pairs).map(p => p!.startDate));
  const ends = Object.values(state.coins).map(cs => cs.dates[cs.dates.length - 1]).filter(Boolean);
  state.startDate = all.length ? all.sort()[0] : null;
  state.lastDate = ends.length ? ends.sort()[ends.length - 1] : null;
  // Oldest first across coins (a stable sort keeps the config's coin and strategy order within a day).
  trades.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { state, trades, days, notes };
}
