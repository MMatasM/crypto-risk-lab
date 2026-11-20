/**
 * The forecasting model's files.
 * - public/data/model/latest.json      tonight's forecasts for every scanned coin
 * - public/data/model/validation.json  the walk-forward test on past data, against the baselines
 * - public/data/model/track.json       the live record: forecasts logged each night, scored once their outcome is known
 * - data/model/log/<month>/<day>.csv   every forecast ever made, one file per night, never changed afterwards
 */
import type { Horizon } from "./features";
import type { HorizonReport, ModelKey } from "./report";
import type { ModelOptions } from "./walkforward";

/** public/data/model/config.json: which model's chance the app shows and the paper strategies trade on, and why. Edited by hand. */
export interface ModelConfig { primary: ModelKey; note: string }

/** Used when there is no config file: the simple model. */
export const DEFAULT_MODEL_CONFIG: ModelConfig = { primary: "logit", note: "The simpler model, used by default." };

/** One coin's forecast for one horizon. Probabilities and returns as fractions. */
export interface HorizonForecast {
  /** The chance the price is higher h days later (the primary model). */
  p: number;
  /** How far that chance moves when the model is refitted on resampled history: the 10th to 90th percentile. */
  band: [number, number];
  /** The same chance in the forecast of the night before (null when there was none). */
  was: number | null;
  /** Each model's own number. */
  logit: number;
  gbt: number;
  /** The return estimate: [low, middle, high]; the low-high range held 80% of the time in training. */
  ret: [number, number, number];
  /** What pushed the primary model's forecast most: [input index into FEATURES, push in log-odds], biggest first. */
  why: [number, number][];
}

export interface CoinForecast { id: string; h7: HorizonForecast; h30: HorizonForecast }

export interface ForecastFile {
  /** The daily close the forecasts are made from (UTC day). */
  date: string;
  generatedAt: string;
  primary: ModelKey;
  /** Why that model is the one shown (from config.json). */
  primaryNote: string;
  coins: CoinForecast[];
  /** Rows trained on and the days they span, per horizon. */
  trained: Record<string, { rows: number; from: string; to: string }>;
  /** The logistic model's weights per standardised input (same order as FEATURES), and the boosted trees' importance shares. */
  weights: Record<string, { logit: number[]; gbt: number[] }>;
}

export interface ValidationFile {
  generatedAt: string;
  /** The newest close used. */
  date: string;
  /** Coins and coin-days the test could draw on, and the first day of history. */
  coins: number;
  samples: number;
  historyFrom: string;
  options: ModelOptions;
  horizons: Record<string, HorizonReport & { folds: number; firstTrainRows: number; lastTrainRows: number }>;
}

export interface TrackFile {
  generatedAt: string;
  /** The first and the newest night a forecast was logged. */
  since: string | null;
  latest: string | null;
  nights: number;
  horizons: Record<string, HorizonReport & { pending: number; firstResolves: string | null }>;
}

/** One line of the forecast log. */
export interface LogRow {
  date: string;
  coin: string;
  h: Horizon;
  logit: number;
  gbt: number;
  base: number;
  momentum: number;
  trendUp: boolean;
  mu: number;
  lo: number;
  hi: number;
}
