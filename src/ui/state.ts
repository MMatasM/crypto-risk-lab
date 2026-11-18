/** Everything the screens show, in one place. Only src/app.ts changes it. */
import type { Analysis } from "../analysis/scoring";
import type { Technicals } from "../analysis/technicals";
import type { History, MarketCoin } from "../data/types";
import type { Overlays } from "./charts";

export type Tab = "overview" | "technicals" | "ranges" | "history" | "signals" | "backtest";
export type View = "analyze" | "discover";
export type DiscSort = "mcap" | "quick" | "c30" | "c1y" | "risk" | "liq";

export interface DiscoverState {
  sector: string;
  tier: string;
  sort: DiscSort;
  hide: boolean;
  data: MarketCoin[] | null;
  at: number | null;
  stale: boolean;
  err: string | null;
  loading: boolean;
}

export interface AppState {
  watch: string[];
  selected: string;
  tab: Tab;
  view: View;
  markets: Record<string, MarketCoin>;
  hists: Record<string, History>;
  analyses: Record<string, Analysis>;
  techs: Record<string, Technicals | null>;
  /** Per-coin problems (delisted, too new), shown in the watchlist and on the desk. */
  coinErr: Record<string, string>;
  /** The latest general problem (rate limit, bad key), shown above the desk. */
  lastErr: string | null;
  /** Set when some data on screen is an older saved copy because the network failed. */
  staleSince: number | null;
  taShow: Overlays;
  disc: DiscoverState;
}

/** The actions the screens can trigger. */
export interface Actions {
  selectCoin(id: string): void;
  addToWatch(id: string): void;
  removeSelected(): void;
  setTab(tab: Tab): void;
  setView(view: View): void;
  toggleOverlay(k: keyof Overlays): void;
  setDiscover(patch: Partial<Pick<DiscoverState, "sector" | "tier" | "sort" | "hide">>): void;
  analyzeFromDiscover(id: string): void;
  retryCoin(id: string): void;
}
