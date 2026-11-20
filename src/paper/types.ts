/**
 * Paper trading files (in public/paper/, published with the site):
 * - config.json  what to trade and the costs (edited by hand)
 * - prices.json  the daily closes the trader has used, oldest first; only ever extended, never rewritten
 * - state.json   each strategy-coin pair: cash, coins held, value after every day
 * - trades.json  every trade, oldest first
 * - portfolio.json, portfolio-trades.json  the weekly top-k portfolio and its two benchmarks (see portfolio.ts)
 */
import type { Strategy } from "../analysis/backtest";
import type { PortfolioConfig } from "./portfolio";

/** The Backtest tab's price rules, plus "model": hold while the forecast's 7-day chance of a rise is above a threshold. */
export type PaperStrategy = Strategy | "model";

export interface PaperSettings {
  /** Hold while above the moving average: its length in days. */
  smaLength: number;
  /** Crossover: fast and slow average lengths. */
  fast: number;
  slow: number;
  /** RSI: buy below, sell above. */
  rsiBuyBelow: number;
  rsiSellAbove: number;
  /** Weekly DCA: the €1,000 is spread over this many weekly buys. */
  dcaWeeks: number;
  /** Model: hold while the 7-day chance of a rise is above this (0.55 = 55%). Pairs started before the model existed don't have it. */
  modelThreshold?: number;
}

export interface PaperConfig {
  /** CoinGecko coin ids. */
  coins: string[];
  strategies: PaperStrategy[];
  /** Fee per trade, as a fraction (0.0025 = 0.25%). */
  fee: number;
  /** Slippage per trade, as a fraction (0.001 = 0.10%). */
  slippage: number;
  settings: PaperSettings;
  /** The weekly top-k portfolio; left out, it isn't traded. */
  portfolio?: PortfolioConfig;
}

/** Daily closes in EUR: dates are UTC days (YYYY-MM-DD), each the close of that day. */
export interface Closes { dates: string[]; closes: number[] }
export type PriceFile = Record<string, Closes>;

/** One strategy on one coin. */
export interface PairState {
  strategy: PaperStrategy;
  /** First day traded (at that day's close). */
  startDate: string;
  /** Settings and costs locked in when the pair started, so its record stays comparable. */
  fee: number;
  slippage: number;
  settings: PaperSettings;
  cash: number;
  units: number;
  /** Whether the rule held the coin after the last day (RSI needs it). */
  held: boolean;
  trades: number;
  /** Value at each close from startDate on: equity[k] belongs to the coin's dates[dates.length - equity.length + k]. */
  equity: number[];
}

export interface CoinState {
  /** Every day traded so far, oldest first. */
  dates: string[];
  pairs: Partial<Record<PaperStrategy, PairState>>;
}

export interface PaperState {
  version: 1;
  /** The first day any pair traded. */
  startDate: string | null;
  /** The last day traded (for the newest coin data). */
  lastDate: string | null;
  coins: Record<string, CoinState>;
}

export interface TradeRecord {
  date: string;
  coin: string;
  strategy: PaperStrategy;
  side: "buy" | "sell";
  /** The day's close. */
  close: number;
  /** Price paid or received, after slippage. */
  price: number;
  units: number;
  /** Euros spent (buy, fee included) or received (sell, after the fee). */
  amount: number;
  fee: number;
  slippage: number;
  reason: string;
}

export const emptyState = (): PaperState => ({ version: 1, startDate: null, lastDate: null, coins: {} });
