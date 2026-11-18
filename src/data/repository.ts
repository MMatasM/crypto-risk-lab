/**
 * What the app asks for (markets, history, the Discover list, search), with caching in browser storage.
 * Fresh copies are used without a request; when a request fails (offline, rate limit, server error)
 * an older copy is used instead and marked `stale`.
 */
import { ApiError, type CoinGeckoClient } from "./coingecko";
import { CACHE_PREFIX, type Store } from "./storage";
import type { History, Loaded, MarketCoin, SearchCoin } from "./types";

export const MARKETS_TTL = 5 * 60e3;
export const HISTORY_TTL = 6 * 3600e3;
export const DISCOVER_TTL = 15 * 60e3;

/** Request priorities: higher runs first. */
export const URGENT = 10, NORMAL = 5, BACKGROUND = 0;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Keep only the fields the app uses, with missing or broken numbers as null. */
export function slimCoin(m: Record<string, unknown>): MarketCoin {
  return {
    id: String(m.id), symbol: String(m.symbol ?? ""), name: String(m.name ?? m.id),
    image: str(m.image), current_price: num(m.current_price), market_cap: num(m.market_cap),
    market_cap_rank: num(m.market_cap_rank), total_volume: num(m.total_volume),
    ath: num(m.ath), ath_change_percentage: num(m.ath_change_percentage), ath_date: str(m.ath_date),
    atl: num(m.atl), atl_change_percentage: num(m.atl_change_percentage), atl_date: str(m.atl_date),
    price_change_percentage_7d_in_currency: num(m.price_change_percentage_7d_in_currency),
    price_change_percentage_30d_in_currency: num(m.price_change_percentage_30d_in_currency),
    price_change_percentage_1y_in_currency: num(m.price_change_percentage_1y_in_currency),
    last_updated: str(m.last_updated),
  };
}

/**
 * The UTC day a CoinGecko daily point belongs to. Daily points are stamped 00:00 UTC and hold the
 * price at the end of the previous day, so they count as that day's close; the last point is the
 * current price and counts for today.
 */
export function closeDay(ts: number): string {
  const d = new Date(ts);
  const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
  return new Date(midnight ? ts - 1 : ts).toISOString().slice(0, 10);
}

type Pair = [number, number | null];

/** Turn a /market_chart reply into one close per day, dropping zero, negative and missing prices. */
export function parseMarketChart(d: { prices?: Pair[]; total_volumes?: Pair[] }): History {
  const px = new Map<string, number>(), vol = new Map<string, number>();
  for (const [ts, v] of d.prices ?? []) if (typeof v === "number" && Number.isFinite(v) && v > 0) px.set(closeDay(ts), v);
  for (const [ts, v] of d.total_volumes ?? []) if (typeof v === "number" && Number.isFinite(v) && v >= 0) vol.set(closeDay(ts), v);
  const dates = [...px.keys()].sort();
  return { dates, closes: dates.map(k => px.get(k)!), volumes: dates.map(k => vol.get(k) ?? 0) };
}

interface Saved<T> { t: number; d: T }

/** Failures where an old copy is better than nothing. Auth and not-found errors are shown instead. */
const recoverable = (e: unknown) => e instanceof ApiError && (e.kind === "offline" || e.kind === "network" || e.kind === "rate" || e.kind === "http");

export class Repository {
  constructor(private api: CoinGeckoClient, private store: Store, private now: () => number = () => Date.now()) {}

  private async cached<T>(key: string, ttl: number, force: boolean, fetcher: () => Promise<T>): Promise<Loaded<T>> {
    const saved = this.store.get<Saved<T> | null>(CACHE_PREFIX + key, null);
    if (!force && saved && this.now() - saved.t < ttl) return { data: saved.d, at: saved.t, stale: false };
    try {
      const data = await fetcher();
      const t = this.now();
      this.store.set(CACHE_PREFIX + key, { t, d: data });
      return { data, at: t, stale: false };
    } catch (e) {
      if (saved && recoverable(e)) return { data: saved.d, at: saved.t, stale: true };
      throw e;
    }
  }

  /** Market data for the watchlist, as a map by coin id. */
  async markets(ids: string[], force = false, priority = NORMAL): Promise<Loaded<Record<string, MarketCoin>>> {
    const saved = this.store.get<Saved<Record<string, MarketCoin>> | null>(CACHE_PREFIX + "mkt", null);
    const fresh = saved && this.now() - saved.t < MARKETS_TTL && ids.every(id => saved.d[id]);
    if (!force && fresh) return { data: saved.d, at: saved.t, stale: false };
    try {
      const list = await this.api.get<Record<string, unknown>[]>(
        `/coins/markets?vs_currency=eur&ids=${ids.map(encodeURIComponent).join(",")}&per_page=250&price_change_percentage=7d,30d,1y`, priority);
      const data: Record<string, MarketCoin> = {};
      for (const m of list) { const c = slimCoin(m); data[c.id] = c; }
      const t = this.now();
      this.store.set(CACHE_PREFIX + "mkt", { t, d: data });
      return { data, at: t, stale: false };
    } catch (e) {
      if (saved && recoverable(e)) return { data: saved.d, at: saved.t, stale: true };
      throw e;
    }
  }

  /** 365 days of daily closes and volumes in EUR. */
  history(id: string, force = false, priority = BACKGROUND): Promise<Loaded<History>> {
    return this.cached("h." + id, HISTORY_TTL, force, async () =>
      parseMarketChart(await this.api.get(`/coins/${encodeURIComponent(id)}/market_chart?vs_currency=eur&days=365&interval=daily`, priority)));
  }

  /** The top 250 coins by market cap, optionally within one CoinGecko category. */
  discover(sector: string, force = false): Promise<Loaded<MarketCoin[]>> {
    return this.cached("disc." + (sector || "all"), DISCOVER_TTL, force, async () => {
      const list = await this.api.get<Record<string, unknown>[]>(
        `/coins/markets?vs_currency=eur&order=market_cap_desc&per_page=250&page=1&price_change_percentage=7d,30d,1y${sector ? "&category=" + encodeURIComponent(sector) : ""}`, NORMAL);
      return list.map(slimCoin);
    });
  }

  async search(q: string): Promise<SearchCoin[]> {
    const d = await this.api.get<{ coins?: Record<string, unknown>[] }>(`/search?query=${encodeURIComponent(q)}`, URGENT);
    return (d.coins ?? []).map(c => ({ id: String(c.id), name: String(c.name ?? c.id), symbol: String(c.symbol ?? ""), market_cap_rank: num(c.market_cap_rank) }));
  }

  /** Saved copies of any age, without a request: shown at startup while fresh data loads. */
  peekMarkets(): Loaded<Record<string, MarketCoin>> | null {
    const s = this.store.get<Saved<Record<string, MarketCoin>> | null>(CACHE_PREFIX + "mkt", null);
    return s ? { data: s.d, at: s.t, stale: this.now() - s.t >= MARKETS_TTL } : null;
  }
  peekHistory(id: string): Loaded<History> | null {
    const s = this.store.get<Saved<History> | null>(CACHE_PREFIX + "h." + id, null);
    return s ? { data: s.d, at: s.t, stale: this.now() - s.t >= HISTORY_TTL } : null;
  }

  /** Drop saved history for coins no longer on the watchlist. */
  forgetHistory(id: string) { this.store.del(CACHE_PREFIX + "h." + id); }
}
