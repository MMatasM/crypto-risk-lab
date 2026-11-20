/**
 * The nightly market scan: which coins to scan, each coin's scores and technical consensus (the same
 * `analyze` and `technicals` the app's coin page uses), the ranking, and what changed since the scan before.
 * Pure functions: no network, no files, no clock.
 */
import { analyze, MIN_DAYS, type Tone } from "../analysis/scoring";
import { isNoise, usdRate } from "../analysis/screen";
import { logrets, std } from "../analysis/math";
import { technicals } from "../analysis/technicals";
import type { History, MarketCoin } from "../data/types";
import type { Change, DayRow, ScanCoin, ScanConfig, ScanDay, ScanHistory } from "./types";

/** A coin already being scanned stays in until it falls this far below the cut, so the list doesn't flicker. */
const STICKY = 1.2;
/** A one-day move this many times the coin's usual daily move counts as unusual. */
export const UNUSUAL = 2;
/** Rank changes smaller than this aren't worth mentioning. */
export const RANK_JUMP = 15;

export function checkScanConfig(c: ScanConfig): string[] {
  const out: string[] = [];
  if (!Number.isInteger(c.topN) || c.topN < 1 || c.topN > 240) out.push("topN must be a whole number from 1 to 240");
  if (!Array.isArray(c.watchlist) || c.watchlist.some(x => typeof x !== "string" || !/^[a-z0-9-]+$/.test(x))) out.push("watchlist must be a list of CoinGecko ids such as \"bitcoin\"");
  if (!Number.isInteger(c.historyDays) || c.historyDays < 2 || c.historyDays > 400) out.push("historyDays must be a whole number from 2 to 400");
  return out;
}

/**
 * The coins to scan: the top `topN` by market cap once stablecoins, wrapped and staked tokens and tokenized
 * funds are left out (the Discover filter), plus every `forced` coin, plus coins scanned last time that are
 * still close to the cut. Bitcoin always comes first (the other coins are compared with it).
 */
export function pickUniverse(markets: readonly MarketCoin[], topN: number, forced: readonly string[], previous: readonly string[] = []): string[] {
  const usd = usdRate(markets);
  const real = markets.filter(m => (m.market_cap ?? 0) > 0 && m.current_price != null && !isNoise(m, usd))
    .sort((a, b) => (b.market_cap ?? 0) - (a.market_cap ?? 0));
  const top = real.slice(0, topN).map(m => m.id);
  const near = new Set(real.slice(0, Math.round(topN * STICKY)).map(m => m.id));
  return [...new Set(["bitcoin", ...top, ...previous.filter(id => near.has(id)), ...forced])];
}

const round = (x: number, d: number) => { const k = 10 ** d; return Math.round(x * k) / k; };
const roundOrNull = (x: number | null, d: number) => (x == null || !Number.isFinite(x) ? null : round(x, d));
/** Prices keep 6 significant digits (57416.2 and 0.0000123456 alike). */
const sig = (x: number) => Number(x.toPrecision(6));

/** One coin's row, or the reason it can't be scanned. `h` holds finished days only. Rank is filled in by `rank`. */
export function scanCoin(h: History, btc: History, m: MarketCoin, extra: { sectors: string[]; watch: boolean }): ScanCoin | string {
  const n = h.closes.length;
  if (n < MIN_DAYS) return `only ${n} days of prices so far (the scores need ${MIN_DAYS})`;
  const a = analyze(h, btc, m), t = technicals(h, a);
  const c = h.closes;
  return {
    id: m.id, symbol: m.symbol, name: m.name, image: m.image, rank: 0,
    mcapRank: m.market_cap_rank, mcap: m.market_cap, volume: m.total_volume,
    tier: a.tier.k, sectors: extra.sectors, watch: extra.watch,
    price: sig(a.p),
    ret1: roundOrNull(c[n - 1] / c[n - 2] - 1, 4), ret7: roundOrNull(a.ret7, 4), ret30: roundOrNull(a.ret30, 4), ret90: roundOrNull(a.ret90, 4),
    vol90: round(a.vol90, 3), dayVol: round(std(logrets(c).slice(-90)), 4), dd: round(a.dd, 4), rsi: round(a.R, 1),
    risk: round(a.risk, 1), trend: round(a.trend, 1), composite: round(a.composite, 1),
    cls: { k: a.cls.k, t: a.cls.t }, lean: { k: a.lean.k, t: a.lean.t }, cons: { k: t.cons.k, t: t.cons.t.replace(/^Technicals: /, "") },
    bull: t.bull, bear: t.bear, tags: a.tags, days: n,
  };
}

/** Best composite score first (bigger coin first on a tie); fills in `rank`. */
export function rank(coins: ScanCoin[]): ScanCoin[] {
  coins.sort((a, b) => b.composite - a.composite || (b.mcap ?? 0) - (a.mcap ?? 0) || (a.id < b.id ? -1 : 1));
  coins.forEach((c, i) => { c.rank = i + 1; });
  return coins;
}

export const dayRow = (c: ScanCoin): DayRow => [c.rank, c.composite, c.risk, c.trend, c.price, c.cls.t, c.cons.t];

const TONE_ORDER: Record<Tone, number> = { bad: 0, warn: 1, neutral: 2, good: 3 };
const CONS_ORDER = ["mostly bearish", "leaning bearish", "mixed", "leaning bullish", "mostly bullish"];
/** The tone of each classification label (they are fixed texts in scoring.ts). */
const CLASS_TONE: Record<string, Tone> = { "Steady uptrend": "good", "High potential, high risk": "warn", "Out of favour, watch": "neutral", "Avoid for now": "bad", "Mixed, no clear trend": "neutral" };

/** What changed between the scan before (`prev`, from history.json) and this one. Tracked coins first. */
export function diff(prev: ScanDay | undefined, coins: readonly ScanCoin[]): Change[] {
  const out: Change[] = [];
  const add = (c: ScanCoin, kind: Change["kind"], text: string, k: Tone) => out.push({ id: c.id, name: c.name, kind, text, k, watch: c.watch });
  for (const c of coins) {
    const move = c.ret1 != null ? Math.abs(Math.log(1 + c.ret1)) : 0;
    if (c.ret1 != null && c.dayVol > 0 && move >= UNUSUAL * c.dayVol) {
      add(c, "move", `${c.ret1 >= 0 ? "Rose" : "Fell"} ${(Math.abs(c.ret1) * 100).toFixed(1)}% in a day, ${(move / c.dayVol).toFixed(1)} times its usual daily move`, c.ret1 >= 0 ? "good" : "bad");
    }
    if (!prev) continue;
    const p = prev.coins[c.id];
    if (!p) { add(c, "new", `New in the scan, at rank ${c.rank}`, "neutral"); continue; }
    const pRank = p[0], pCls = p[5], pCons = p[6];
    if (pCls !== c.cls.t) {
      const was = CLASS_TONE[pCls], now = TONE_ORDER[c.cls.k];
      add(c, "cls", `Classification: ${pCls} → ${c.cls.t}`, was == null || TONE_ORDER[was] === now ? "neutral" : now > TONE_ORDER[was] ? "good" : "bad");
    }
    if (pCons !== c.cons.t) {
      const was = CONS_ORDER.indexOf(pCons), now = CONS_ORDER.indexOf(c.cons.t);
      add(c, "cons", `Technicals: ${pCons} → ${c.cons.t}`, was < 0 || now < 0 || was === now ? "neutral" : now > was ? "good" : "bad");
    }
    if (Math.abs(pRank - c.rank) >= RANK_JUMP) add(c, "rank", `Rank ${pRank} → ${c.rank}`, c.rank < pRank ? "good" : "bad");
  }
  if (prev) {
    const now = new Set(coins.map(c => c.id));
    for (const id of Object.keys(prev.coins)) if (!now.has(id)) out.push({ id, name: id, kind: "gone", text: "No longer in the scan (fell out of the top coins, or no fresh prices)", k: "neutral", watch: false });
  }
  const order: Record<Change["kind"], number> = { cls: 0, move: 1, cons: 2, rank: 3, new: 4, gone: 5 };
  return out.sort((a, b) => Number(b.watch) - Number(a.watch) || order[a.kind] - order[b.kind]);
}

/** history.json with this scan added (replacing an earlier scan of the same day), trimmed to the newest `keep` days. */
export function addDay(hist: ScanHistory, date: string, coins: readonly ScanCoin[], keep: number): ScanHistory {
  const days = hist.days.filter(d => d.date !== date);
  days.push({ date, coins: Object.fromEntries(coins.map(c => [c.id, dayRow(c)])) });
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { days: days.slice(-keep) };
}

/** The newest scan before `date`. */
export const dayBefore = (hist: ScanHistory, date: string): ScanDay | undefined => hist.days.filter(d => d.date < date).pop();
