/**
 * The paper portfolio: one pot of fake money rotated weekly into the best-ranked coins, next to two things
 * to beat that start on the same day with the same money: buying and holding Bitcoin, and buying an equal
 * amount of every coin in the same universe and holding.
 *
 * Top-k rotation, each rebalance day (every `rebalanceDays` days from the start):
 *   - If Bitcoin's close is below its `trendDays`-day average: everything to cash.
 *   - Otherwise rank the `universe` biggest scanned coins by the average of two percentile ranks, the
 *     scan's composite score and the model's 7-day chance of a rise, and hold the best `k` in equal
 *     parts, never more than `maxWeight` of the pot in one coin.
 * As everywhere in paper trading, the decision for a day uses the scan and forecast of the day before and
 * trades at that day's close, with the same fee and slippage. Pure functions: no network, no files, no clock.
 */
import { START_CAPITAL, type Costs } from "../analysis/backtest";
import { maxDrawdown, sma } from "../analysis/indicators";
import type { Closes, PaperConfig } from "./types";

export interface PortfolioConfig {
  /** Coins held. */
  k: number;
  /** Picks come from this many of the biggest scanned coins. */
  universe: number;
  /** The largest share of the pot one coin may take (0.4 = 40%). */
  maxWeight: number;
  rebalanceDays: number;
  /** Bitcoin below its average of this many days counts as a downtrend. */
  trendDays: number;
}

export type BookKey = "topk" | "btc" | "equal";
export const BOOKS: BookKey[] = ["topk", "btc", "equal"];

export interface PortfolioBook {
  cash: number;
  /** Coins held, by CoinGecko id. */
  units: Record<string, number>;
  trades: number;
  /** Value at each close; equity[i] belongs to the state's dates[i]. */
  equity: number[];
}

export interface Pick { coin: string; score: number; composite: number; p: number }

export interface PortfolioState {
  version: 1;
  startDate: string | null;
  lastDate: string | null;
  dates: string[];
  /** Costs and settings locked in on the first day, so the record stays comparable. */
  fee: number;
  slippage: number;
  settings: PortfolioConfig;
  books: Record<BookKey, PortfolioBook>;
  lastRebalance: string | null;
  /** The last close of each coin the rotation holds, so its holdings can be valued without the price files. */
  marks: Record<string, number>;
  /** The newest weekly decision: the day it traded, the day its ranking is from, and what it chose. */
  decision: { date: string; rankedOn: string; picks: Pick[]; note: string } | null;
}

export interface PortfolioTrade {
  date: string;
  book: BookKey;
  coin: string;
  side: "buy" | "sell";
  close: number;
  price: number;
  units: number;
  amount: number;
  fee: number;
  slippage: number;
  reason: string;
}

/** What was known after one day's close: each scanned coin's composite score, market-cap rank and 7-day chance of a rise. */
export interface DaySignals {
  composite: Record<string, number>;
  mcapRank: Record<string, number | null>;
  p: Record<string, number>;
}

const emptyBook = (): PortfolioBook => ({ cash: START_CAPITAL, units: {}, trades: 0, equity: [] });
export const emptyPortfolio = (): PortfolioState => ({
  version: 1, startDate: null, lastDate: null, dates: [], fee: 0, slippage: 0,
  settings: { k: 0, universe: 0, maxWeight: 0, rebalanceDays: 0, trendDays: 0 },
  books: { topk: emptyBook(), btc: emptyBook(), equal: emptyBook() }, lastRebalance: null, marks: {}, decision: null,
});

export function checkPortfolioConfig(c: PortfolioConfig): string[] {
  const out: string[] = [];
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!int(c.k, 1, 20)) out.push("portfolio.k must be a whole number from 1 to 20");
  if (!int(c.universe, 2, 240) || c.universe < c.k) out.push("portfolio.universe must be a whole number from 2 to 240, at least k");
  if (typeof c.maxWeight !== "number" || !(c.maxWeight > 0 && c.maxWeight <= 1)) out.push("portfolio.maxWeight must be a fraction above 0 and at most 1 (0.4 = 40%)");
  if (!int(c.rebalanceDays, 1, 90)) out.push("portfolio.rebalanceDays must be a whole number from 1 to 90");
  if (!int(c.trendDays, 5, 300)) out.push("portfolio.trendDays must be a whole number from 5 to 300");
  return out;
}

/** The universe: the `n` biggest scanned coins that have both a score and a forecast. */
export function universe(sig: DaySignals, n: number): string[] {
  return Object.keys(sig.composite)
    .filter(c => sig.mcapRank[c] != null && sig.p[c] != null)
    .sort((a, b) => (sig.mcapRank[a] as number) - (sig.mcapRank[b] as number) || (a < b ? -1 : 1))
    .slice(0, n);
}

/** The best `k` coins of the universe by the average of two percentile ranks: composite score and chance of a rise. */
export function choose(sig: DaySignals, cfg: PortfolioConfig): Pick[] {
  const u = universe(sig, cfg.universe);
  if (!u.length) return [];
  const pctRank = (value: (c: string) => number) => {
    const sorted = [...u].sort((a, b) => value(a) - value(b)), out = new Map<string, number>();
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j < sorted.length && value(sorted[j]) === value(sorted[i])) j++;
      for (let q = i; q < j; q++) out.set(sorted[q], u.length > 1 ? ((i + j - 1) / 2) / (u.length - 1) : 1);
      i = j;
    }
    return out;
  };
  const rc = pctRank(c => sig.composite[c]), rp = pctRank(c => sig.p[c]);
  return u.map(coin => ({ coin, score: (rc.get(coin)! + rp.get(coin)!) / 2, composite: sig.composite[coin], p: sig.p[coin] }))
    .sort((a, b) => b.score - a.score || (a.coin < b.coin ? -1 : 1)).slice(0, cfg.k);
}

export interface PortfolioAdvance { state: PortfolioState; trades: PortfolioTrade[]; days: string[]; notes: string[] }

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const pctText = (v: number) => (v * 100).toFixed(0) + "%";

/**
 * Trades every Bitcoin close not yet traded, oldest first. It starts on the newest close once a ranking
 * for the day before exists. `signals` is keyed by the day the ranking is from. Returns a new state.
 */
export function advancePortfolio(state0: PortfolioState, prices: Record<string, Closes>, signals: Record<string, DaySignals>, config: PaperConfig): PortfolioAdvance {
  const state: PortfolioState = structuredClone(state0);
  const trades: PortfolioTrade[] = [], days: string[] = [], notes: string[] = [];
  const btc = prices.bitcoin;
  if (!config.portfolio) return { state, trades, days, notes };
  if (!btc?.dates.length) { notes.push("portfolio: no Bitcoin prices yet"); return { state, trades, days, notes }; }

  const at = new Map<string, Map<string, number>>();
  const closes = (coin: string) => { let m = at.get(coin); if (!m) { const p = prices[coin]; at.set(coin, m = new Map(p ? p.dates.map((d, i) => [d, p.closes[i]] as const) : [])); } return m; };
  /** The close on the day, or the newest one before it (for valuing a coin whose prices have stopped). */
  const lastKnown = (coin: string, date: string) => { const p = prices[coin]; if (!p) return 0; for (let i = p.dates.length - 1; i >= 0; i--) if (p.dates[i] <= date) return p.closes[i]; return 0; };
  const value = (b: PortfolioBook, date: string) => b.cash + Object.entries(b.units).reduce((s, [c, u]) => s + u * (closes(c).get(date) ?? lastKnown(c, date)), 0);

  let from: number;
  if (state.lastDate) {
    from = btc.dates.indexOf(state.lastDate) + 1;
    if (from === 0) { notes.push(`portfolio: the saved prices don't include the last day traded (${state.lastDate})`); return { state, trades, days, notes }; }
  } else from = btc.dates.length - 1;

  for (let i = Math.max(1, from); i < btc.dates.length; i++) {
    const date = btc.dates[i], prev = btc.dates[i - 1], sig = signals[prev];
    const k: Costs = state.startDate ? { fee: state.fee, slippage: state.slippage } : { fee: config.fee, slippage: config.slippage };
    const record = (book: BookKey, coin: string, side: "buy" | "sell", close: number, units: number, amount: number, fee: number, slippage: number, reason: string) =>
      trades.push({ date, book, coin, side, close, price: close * (side === "buy" ? 1 + k.slippage : 1 - k.slippage), units, amount, fee, slippage, reason });
    const buy = (key: BookKey, coin: string, eur: number, reason: string) => {
      const b = state.books[key], close = closes(coin).get(date);
      eur = Math.min(eur, b.cash);
      if (!close || eur <= 0) return;
      const units = eur * (1 - k.fee) / (close * (1 + k.slippage));
      b.cash -= eur; b.units[coin] = (b.units[coin] ?? 0) + units; b.trades++;
      record(key, coin, "buy", close, units, eur, eur * k.fee, eur * (1 - k.fee) - units * close, reason);
    };
    const sell = (key: BookKey, coin: string, units: number, reason: string) => {
      const b = state.books[key], close = closes(coin).get(date), have = b.units[coin] ?? 0;
      if (!close || units <= 0 || have <= 0) return;
      const u = Math.min(units, have), gross = u * close * (1 - k.slippage), amount = gross * (1 - k.fee);
      b.cash += amount; b.trades++;
      if (have - u < 1e-12) delete b.units[coin]; else b.units[coin] = have - u;
      record(key, coin, "sell", close, u, amount, gross * k.fee, u * close - gross, reason);
    };

    if (!state.startDate) {
      if (!sig) { notes.push(`portfolio: waiting for a ranking from ${prev} before it starts`); continue; }
      state.startDate = date; state.fee = config.fee; state.slippage = config.slippage; state.settings = { ...config.portfolio };
      buy("btc", "bitcoin", state.books.btc.cash, "Buy and hold Bitcoin: buys on the first day and never sells");
      const u = universe(sig, state.settings.universe).filter(c => closes(c).has(date));
      for (const c of u) buy("equal", c, START_CAPITAL / u.length, `Equal weight: 1/${u.length} of the money in each of the ${u.length} biggest coins, bought once and held`);
    }
    const cfg = state.settings;
    const due = !state.lastRebalance || daysBetween(state.lastRebalance, date) >= cfg.rebalanceDays;
    if (due && !sig) notes.push(`portfolio: no ranking from ${prev}, so the weekly rebalance waits a day`);
    if (due && sig) {
      const book = state.books.topk;
      const avg = sma(btc.closes.slice(0, i), cfg.trendDays)[i - 1];
      const down = avg != null && btc.closes[i - 1] < avg;
      const picks = down ? [] : choose(sig, cfg).filter(p => closes(p.coin).has(date));
      const weight = picks.length ? Math.min(1 / picks.length, cfg.maxWeight) : 0;
      const total = value(book, date), tolerance = 0.01 * total;
      const target = new Map(picks.map(p => [p.coin, weight * total] as const));
      for (const [coin, units] of Object.entries(book.units)) {
        const close = closes(coin).get(date);
        if (!close) { notes.push(`portfolio: no close for ${coin} on ${date}, so it wasn't traded`); continue; }
        const goal = target.get(coin) ?? 0, cur = units * close;
        if (goal === 0) sell("topk", coin, units, down ? `Bitcoin closed below its ${cfg.trendDays}-day average: everything to cash` : `No longer in the top ${cfg.k}`);
        else if (cur - goal > tolerance) sell("topk", coin, (cur - goal) / close, "Trimmed back to its equal share");
      }
      picks.forEach((p, n) => {
        const cur = (book.units[p.coin] ?? 0) * closes(p.coin).get(date)!, goal = target.get(p.coin)!;
        if (goal - cur > tolerance) buy("topk", p.coin, Math.min(goal - cur, book.cash), `Pick ${n + 1} of ${picks.length}: composite score ${p.composite.toFixed(0)}, 7-day chance of a rise ${pctText(p.p)}`);
      });
      state.lastRebalance = date;
      state.decision = { date, rankedOn: prev, picks, note: down ? `Bitcoin closed below its ${cfg.trendDays}-day average, so the portfolio is in cash.` : picks.length ? `Holding the best ${picks.length} of the ${cfg.universe} biggest coins.` : "No coin had both a score and a forecast, so the portfolio is in cash." };
    }
    for (const key of BOOKS) state.books[key].equity.push(value(state.books[key], date));
    state.marks = Object.fromEntries(Object.keys(state.books.topk.units).map(c => [c, closes(c).get(date) ?? lastKnown(c, date)]));
    state.dates.push(date); state.lastDate = date;
    days.push(date);
  }
  return { state, trades, days, notes };
}

export const BOOK_NAMES: Record<BookKey, string> = { topk: "Top-k rotation", btc: "Buy and hold Bitcoin", equal: "Equal weight, held" };

export interface PortfolioRow {
  book: BookKey;
  name: string;
  value: number;
  ret: number;
  mdd: number;
  trades: number;
  /** Return minus buy-and-hold Bitcoin's, and minus the equal-weight portfolio's (null for the benchmark itself). */
  vsBtc: number | null;
  vsEqual: number | null;
}

export function portfolioBoard(state: PortfolioState): PortfolioRow[] {
  if (!state.dates.length) return [];
  const ret = (k: BookKey) => state.books[k].equity[state.books[k].equity.length - 1] / START_CAPITAL - 1;
  const name = (k: BookKey) => (k === "topk" ? `Top-${state.settings.k} rotation` : BOOK_NAMES[k]);
  return BOOKS.map(book => {
    const b = state.books[book];
    return { book, name: name(book), value: b.equity[b.equity.length - 1], ret: ret(book), mdd: maxDrawdown(b.equity), trades: b.trades, vsBtc: book === "btc" ? null : ret(book) - ret("btc"), vsEqual: book === "equal" ? null : ret(book) - ret("equal") };
  }).sort((a, b) => b.ret - a.ret);
}
