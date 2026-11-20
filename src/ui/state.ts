/** Everything the screens show, in one place. Only src/app.ts changes it. */
import type { Analysis } from "../analysis/scoring";
import type { Technicals } from "../analysis/technicals";
import type { History, MarketCoin } from "../data/types";
import type { Overlays } from "./charts";
import type { ForecastFile, TrackFile, ValidationFile } from "../model/types";
import type { PortfolioState, PortfolioTrade } from "../paper/portfolio";
import type { PaperConfig, PaperState, PaperStrategy, TradeRecord } from "../paper/types";
import type { ScanConfig, ScanFile } from "../scan/types";

export type Tab = "overview" | "technicals" | "ranges" | "history" | "signals" | "forecast" | "backtest";
export type View = "analyze" | "discover" | "signals" | "paper";
export type SigSort = "rank" | "p7" | "p30" | "risk" | "trend" | "ret7" | "mcap";
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

/** The paper trading files, as published with the site. */
export interface PaperData { config: PaperConfig; state: PaperState; trades: TradeRecord[]; portfolio?: PortfolioState | null; portfolioTrades?: PortfolioTrade[] }

/** The nightly scan and forecast files, as published with the site (public/data/). */
export interface SignalsData { scan: ScanFile | null; model: ForecastFile | null; validation: ValidationFile | null; track: TrackFile | null; config: ScanConfig | null }

export interface SignalsViewState {
  data: SignalsData | null;
  at: number | null;
  stale: boolean;
  err: string | null;
  loading: boolean;
  tier: string;
  sector: string;
  risk: "all" | "low" | "mid" | "high";
  sort: SigSort;
  trackedOnly: boolean;
  /** Show every change since the scan before, not just the first few. */
  allChanges: boolean;
  /** Whether the "how the model was tested" block is open. */
  details: boolean;
}

export interface PaperViewState {
  data: PaperData | null;
  /** When the data was loaded; with `stale`, an older saved copy shown because loading failed. */
  at: number | null;
  stale: boolean;
  err: string | null;
  loading: boolean;
  /** The coin shown (null = all coins together). */
  coin: string | null;
  /** The strategy highlighted on the chart. */
  focus: PaperStrategy | null;
  /** The trade log's filter. */
  logStrategy: PaperStrategy | "all";
  /** Show the whole trade log rather than the newest trades. */
  logAll: boolean;
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
  paper: PaperViewState;
  /** Coins tracked on this device: on the watchlist and highlighted in Signals. */
  tracked: string[];
  signals: SignalsViewState;
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
  setPaper(patch: Partial<Pick<PaperViewState, "coin" | "focus" | "logStrategy" | "logAll">>): void;
  /** `quiet` remembers the change without redrawing (for things the browser has already drawn, like an opened block). */
  setSignals(patch: Partial<Pick<SignalsViewState, "tier" | "sector" | "risk" | "sort" | "trackedOnly" | "allChanges" | "details">>, quiet?: boolean): void;
  toggleTrack(id: string): void;
  /** Opens a coin's page (adding it to the watchlist if needed), optionally on a given tab. */
  openCoin(id: string, tab?: Tab): void;
}
