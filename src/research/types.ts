/**
 * public/data/longtest/report.json: the long-term test (the forecasting models and the paper-trading
 * strategies on seven years of Bitvavo history), written by `npm run longtest` and shown under Signals.
 */
import type { CalBin } from "../model/metrics";
import type { ModelKey } from "../model/report";
import type { ModelOptions } from "../model/walkforward";
import type { Boot, PhaseReport } from "./phases";
import type { CurveStats, RegimeSplit } from "./strategies";

export interface StrategyRow extends CurveStats {
  key: string;
  name: string;
  /** Trades per coin per year (per year for a portfolio). */
  trades: number;
  /** Each calendar year's return and worst drop (null for a year not covered); same order as `years`. */
  years: (number | null)[];
  yearMdd: (number | null)[];
  /** The days entered with Bitcoin above, or below, its 200-day average: how many, and the return compounded over them. */
  above: RegimeSplit;
  below: RegimeSplit;
  /** How much faster it grew than the table's benchmark and than buying and holding Bitcoin, per year, with a 95% range (null for the benchmark itself). */
  edge: Boot | null;
  edgeBtc: Boot | null;
  /** Per-coin strategies on the whole market: the share of coin-years it ended ahead of buying and holding the same coin. */
  beatHold?: number;
}

export interface StrategyTable {
  /** First and last day traded. */
  from: string;
  to: string;
  rows: StrategyRow[];
}

export interface LongTestFile {
  generatedAt: string;
  /** The last daily close used. */
  through: string;
  source: string;
  data: {
    /** Coins in the test, and how many of them are in tonight's scan of the top coins. */
    coins: number;
    scanCoins: number;
    from: string;
    samples: number;
    /** Coins by years of history: [label, coins]. */
    byYears: [string, number][];
    /** Coins now more than 90% below their own high on Bitvavo. */
    collapsed: number;
    /** Assets Bitvavo names without an EUR market (their history is gone), and the scanned coins it doesn't list. */
    delisted: number;
    scanTotal: number;
    scanMissing: string[];
    /** Markets that were suspended for more than a week and are treated as separate coins before and after. */
    split: string[];
  };
  options: ModelOptions;
  /** Rounds of the weekly block bootstrap. */
  bootstrapRounds: number;
  horizons: Record<string, {
    folds: number;
    firstTrainRows: number;
    lastTrainRows: number;
    /** Weeks kept together in a bootstrap block. */
    blockWeeks: number;
    overall: PhaseReport;
    years: PhaseReport[];
    regimes: PhaseReport[];
    groups: PhaseReport[];
    /** Boosted trees' Brier score minus logistic regression's over all years (negative = the trees were better). */
    gbtVsLogit: Boot;
    calibration: Record<ModelKey, CalBin[]>;
  }>;
  strategies: {
    fee: number;
    slippage: number;
    threshold: number;
    years: number[];
    /** Days in the first and the last (unfinished) year. */
    partial: Record<string, string>;
    /** Coins traded in each year by the whole-market test. */
    coinsPerYear: number[];
    /** Every coin, equal money in each, fresh every 1 January. */
    market: StrategyTable;
    /** The weekly top-k portfolio and its benchmarks, fresh every 1 January. */
    portfolio: StrategyTable & { k: number; universe: number };
    /** The paper-trading coins that trade on Bitvavo, each run without a break. */
    coins: (StrategyTable & { coin: string; name: string })[];
    /** Weekly values of the main curves (1 = the start), for a chart. */
    chart: { dates: string[]; series: { key: string; name: string; eq: number[] }[] };
  };
}
