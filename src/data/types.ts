/** Shapes of the data the app keeps. CoinGecko fields can be null for new, tiny or tokenized coins. */

/** One coin from /coins/markets, trimmed to the fields the app uses. */
export interface MarketCoin {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  current_price: number | null;
  market_cap: number | null;
  market_cap_rank: number | null;
  total_volume: number | null;
  ath: number | null;
  ath_change_percentage: number | null;
  ath_date: string | null;
  atl: number | null;
  atl_change_percentage: number | null;
  atl_date: string | null;
  price_change_percentage_7d_in_currency: number | null;
  price_change_percentage_30d_in_currency: number | null;
  price_change_percentage_1y_in_currency: number | null;
  last_updated: string | null;
}

/** Daily history: dates are UTC days (YYYY-MM-DD), closes in EUR, volumes are 24h EUR volume. */
export interface History {
  dates: string[];
  closes: number[];
  volumes: number[];
}

export interface SearchCoin {
  id: string;
  name: string;
  symbol: string;
  market_cap_rank: number | null;
}

/** What a loader hands back: the data plus whether it came from an old copy because the network failed. */
export interface Loaded<T> {
  data: T;
  /** When this data was fetched (ms since 1970). */
  at: number;
  /** True when the network failed and this is an older saved copy. */
  stale: boolean;
}
