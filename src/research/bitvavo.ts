/**
 * Long daily history from Bitvavo's PUBLIC market-data API, for research and backtests only (the nightly
 * scan and paper trading don't use it). Pure functions: no network, no files, no clock.
 *
 * A Bitvavo daily candle is [start of the UTC day in ms, open, high, low, close, volume in the coin]; the
 * close is the last trade before the next UTC midnight. Days without a trade have no candle.
 */
import { isNoise } from "../analysis/screen";
import type { History, MarketCoin } from "../data/types";

/** One row of GET /v2/{market}/candles. Numbers arrive as strings. */
export type Candle = [number, string, string, string, string, string];

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Candles (any order, duplicates allowed) as a history, oldest first: the close in EUR and the day's
 * volume in EUR (coins traded times the close). Only finished days count (dates before `today`, UTC).
 */
export function candlesToHistory(candles: readonly Candle[], today: string): History {
  const byDay = new Map<string, [number, number]>();
  for (const c of candles) {
    const close = Number(c[4]), vol = Number(c[5]);
    if (!Number.isFinite(c[0]) || !(close > 0)) continue;
    const d = dayOf(c[0]);
    if (d < today) byDay.set(d, [close, Number.isFinite(vol) && vol > 0 ? vol * close : 0]);
  }
  const dates = [...byDay.keys()].sort();
  return { dates, closes: dates.map(d => byDay.get(d)![0]), volumes: dates.map(d => Math.round(byDay.get(d)![1])) };
}

/** Saved days are never rewritten: only days after the last saved one are added. */
export function extendHistory(saved: History | undefined, fetched: History): History {
  if (!saved?.dates.length) return fetched;
  const last = saved.dates[saved.dates.length - 1], out: History = { dates: [...saved.dates], closes: [...saved.closes], volumes: [...saved.volumes] };
  for (let i = 0; i < fetched.dates.length; i++) if (fetched.dates[i] > last) { out.dates.push(fetched.dates[i]); out.closes.push(fetched.closes[i]); out.volumes.push(fetched.volumes[i]); }
  return out;
}

/**
 * Whether a Bitvavo market is a stablecoin, a wrapped or staked copy, or a tokenized fund: the same filter
 * the nightly scan uses (`isNoise`), fed with numbers worked out from the market's own candles.
 */
export function isNoiseMarket(symbol: string, name: string, h: History, usdInEur: number): boolean {
  const n = h.closes.length;
  if (!n) return true;
  const chg = (d: number) => (n > d ? (h.closes[n - 1] / h.closes[n - 1 - d] - 1) * 100 : null);
  const vol = h.volumes.slice(-30).reduce((s, v) => s + v, 0) / Math.min(30, n);
  const m: MarketCoin = {
    id: symbol.toLowerCase(), symbol: symbol.toLowerCase(), name, image: null, current_price: h.closes[n - 1], market_cap: null, market_cap_rank: null,
    total_volume: vol || null, ath: null, ath_change_percentage: null, ath_date: null, atl: null, atl_change_percentage: null, atl_date: null,
    price_change_percentage_7d_in_currency: chg(7), price_change_percentage_30d_in_currency: chg(30), price_change_percentage_1y_in_currency: null, last_updated: null,
  };
  return isNoise(m, usdInEur);
}

export interface PriceMatch {
  /** The middle relative gap between the two price series on the days they share (0.01 = 1%). */
  gap: number;
  /** Days added to the second series' dates for the best fit (data providers disagree on which day a midnight price belongs to). */
  shift: number;
  days: number;
}

/**
 * How closely two daily price series agree, trying the second one as it is and moved a day either way.
 * Null when they share fewer than `minDays` days. Used to check that a Bitvavo ticker and a CoinGecko id
 * really are the same coin (tickers are reused; prices of different coins never agree for months).
 */
export function priceMatch(a: History, b: History, minDays = 30): PriceMatch | null {
  const at = new Map(a.dates.map((d, i) => [d, a.closes[i]] as const));
  let best: PriceMatch | null = null;
  for (const shift of [0, -1, 1]) {
    const gaps: number[] = [];
    for (let i = 0; i < b.dates.length; i++) {
      const d = new Date(Date.parse(b.dates[i] + "T00:00:00Z") + shift * 864e5).toISOString().slice(0, 10), p = at.get(d);
      if (p != null) gaps.push(Math.abs(b.closes[i] / p - 1));
    }
    if (gaps.length < minDays) continue;
    gaps.sort((x, y) => x - y);
    const gap = gaps[Math.floor(gaps.length / 2)];
    if (!best || gap < best.gap) best = { gap, shift, days: gaps.length };
  }
  return best;
}

export interface ScanMatch { id: string; symbol: string; name: string; market: string; gap: number; how: "ticker" | "price" }
export interface ScanMapping {
  matched: ScanMatch[];
  /** Scan coins with no Bitvavo EUR market. */
  unlisted: { id: string; symbol: string; name: string }[];
  /** Scan coins whose ticker exists on Bitvavo but whose prices disagree: a different coin with the same ticker. */
  clash: { id: string; symbol: string; name: string; market: string; gap: number | null }[];
}

/** Prices of the same coin on two venues stay within a few percent; anything above this is a different coin. */
export const SAME_COIN = 0.10;
/** Matching by price alone (the ticker differs) has to be much tighter. */
export const SAME_COIN_STRICT = 0.02;

/**
 * Which Bitvavo EUR market each scanned coin is. A ticker match counts only when the prices agree; a coin
 * without a ticker match is looked for by price alone (some coins trade under another ticker on Bitvavo).
 */
export function mapScanCoins(scan: readonly { id: string; symbol: string; name: string }[], cg: ReadonlyMap<string, History>, bitvavo: ReadonlyMap<string, History>): ScanMapping {
  const out: ScanMapping = { matched: [], unlisted: [], clash: [] };
  const taken = new Set<string>();
  const later: typeof scan[number][] = [];
  for (const c of scan) {
    const market = c.symbol.toUpperCase(), b = bitvavo.get(market), h = cg.get(c.id);
    if (!b || !h) { later.push(c); continue; }
    const m = priceMatch(h, b);
    if (m && m.gap <= SAME_COIN) { out.matched.push({ id: c.id, symbol: c.symbol, name: c.name, market, gap: m.gap, how: "ticker" }); taken.add(market); }
    else { out.clash.push({ id: c.id, symbol: c.symbol, name: c.name, market, gap: m?.gap ?? null }); later.push(c); }
  }
  for (const c of later) {
    const h = cg.get(c.id);
    let best: ScanMatch | null = null;
    if (h) for (const [market, b] of bitvavo) {
      if (taken.has(market)) continue;
      const m = priceMatch(h, b, 90);
      if (m && m.gap <= SAME_COIN_STRICT && (!best || m.gap < best.gap)) best = { id: c.id, symbol: c.symbol, name: c.name, market, gap: m.gap, how: "price" };
    }
    if (best) { out.matched.push(best); taken.add(best.market); out.clash = out.clash.filter(x => x.id !== c.id); }
    else if (!out.clash.some(x => x.id === c.id)) out.unlisted.push({ id: c.id, symbol: c.symbol, name: c.name });
  }
  return out;
}

/** Years of history between a market's first and last day. */
export const yearsOf = (h: History) => (h.dates.length ? (Date.parse(h.dates[h.dates.length - 1]) - Date.parse(h.dates[0])) / 864e5 / 365.25 : 0);

/** The research data's index file (data/bitvavo/index.json). */
export interface BitvavoIndex {
  fetchedAt: string;
  /** The newest finished day asked for. */
  through: string;
  source: string;
  markets: { market: string; name: string; status: string; from: string; to: string; days: number; noise: boolean }[];
  /** Assets Bitvavo still names but no longer has an EUR market for: their price history is gone from the public API. */
  delisted: { symbol: string; name: string; status: string }[];
  scan: ScanMapping & { date: string };
}
