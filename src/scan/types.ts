/**
 * The nightly market scan's files.
 * - public/data/scan/config.json   how many coins to scan and the watchlist (edited by hand)
 * - public/data/scan/latest.json   the newest ranked list, with what changed since the scan before
 * - public/data/scan/history.json  a compact copy of the last weeks of scans (for "what changed" and the paper portfolio)
 * - data/history/<coin>.csv        each coin's daily closes and volumes in EUR; only ever extended
 */
import type { TierKey, Tone } from "../analysis/scoring";

export interface ScanConfig {
  /** Coins scanned, by market cap, after stablecoins, wrapped and staked tokens are left out. */
  topN: number;
  /** CoinGecko ids that are always scanned and marked as tracked, whatever their size. */
  watchlist: string[];
  /** Days of scans kept in history.json. */
  historyDays: number;
}

export interface Label { k: Tone; t: string }

/** One coin in the ranked list. Money in EUR; returns and volatility as fractions (0.05 = 5%). */
export interface ScanCoin {
  id: string;
  symbol: string;
  name: string;
  image: string | null;
  /** Place in this list, 1 = best composite score. */
  rank: number;
  mcapRank: number | null;
  mcap: number | null;
  volume: number | null;
  tier: TierKey;
  sectors: string[];
  /** In the nightly watchlist (config.json). */
  watch: boolean;
  /** The daily close the numbers are from. */
  price: number;
  ret1: number | null;
  ret7: number | null;
  ret30: number | null;
  ret90: number | null;
  /** Yearly volatility from the last 90 days. */
  vol90: number;
  /** The usual size of a one-day move (standard deviation of daily returns, last 90 days). */
  dayVol: number;
  /** Fall from the highest close in the saved history (negative). */
  dd: number;
  rsi: number;
  risk: number;
  trend: number;
  composite: number;
  cls: Label;
  lean: Label;
  /** The technical consensus and how many indicators point each way. */
  cons: Label;
  bull: number;
  bear: number;
  tags: string[];
  /** Days of history behind the numbers. */
  days: number;
}

export type ChangeKind = "cls" | "cons" | "rank" | "move" | "new" | "gone";

export interface Change {
  id: string;
  name: string;
  kind: ChangeKind;
  /** Plain words, ready to show. */
  text: string;
  /** Good, bad or neutral news for someone holding the coin. */
  k: Tone;
  watch: boolean;
}

export interface ScanFile {
  /** The daily close the scan is from (UTC day). */
  date: string;
  /** The scan it is compared with (normally the day before). */
  previousDate: string | null;
  generatedAt: string;
  coins: ScanCoin[];
  /** Coins that should have been scanned but weren't, with the reason. */
  skipped: { id: string; name: string; why: string }[];
  changes: Change[];
}

/** One coin on one day in history.json: [rank, composite, risk, trend, price, classification, consensus, market-cap rank]. */
export type DayRow = [number, number, number, number, number, string, string, number | null];
export interface ScanDay { date: string; coins: Record<string, DayRow> }
export interface ScanHistory { days: ScanDay[] }

/** Which sector lists (CoinGecko categories) each coin is in; refreshed weekly. */
export interface SectorFile { at: string; coins: Record<string, string[]> }

/** The sectors offered as filters: CoinGecko category id and the name shown. */
export const SECTORS: [string, string][] = [["layer-1", "Layer 1"], ["decentralized-finance-defi", "DeFi"], ["artificial-intelligence", "AI"], ["meme-token", "Meme"], ["real-world-assets-rwa", "Real-world assets"], ["gaming", "Gaming"], ["privacy-coins", "Privacy"]];
