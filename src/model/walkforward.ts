/**
 * Training, forecasting, and the walk-forward test that says how much the forecasts are worth.
 *
 * Walk-forward: stand at a day in the past, train only on rows whose 7- or 30-day outcome was already
 * known that day, forecast the following week, step a week forward, repeat. A training row for day t
 * with horizon h is used only when t + h is before the first test day, so no training outcome overlaps
 * the test period and nothing from the future is ever used.
 */
import { featureIndex, type Horizon, type Sample } from "./features";
import { fitGbt, gbtContributions, predictGbt, type GbtModel, type GbtOptions } from "./gbt";
import type { ModelKey } from "./report";
import { contributions, fitLogistic, fitRidge, predictLogistic, score, type LinearModel } from "./linear";
import { quantile } from "./metrics";

/** Fixed before any results were seen and not tuned afterwards. */
export interface ModelOptions {
  /** The L2 penalty of the logistic and ridge regressions. */
  lambda: number;
  gbt: Partial<GbtOptions>;
  /** Days of known outcomes needed before the first walk-forward forecast. */
  minTrainDays: number;
  /** Days between retrainings in the walk-forward test. */
  step: number;
}
export const MODEL_DEFAULTS: ModelOptions = { lambda: 0.01, gbt: {}, minTrainDays: 90, step: 7 };

const RET30 = featureIndex("ret30"), VOL30 = featureIndex("vol30");

/** Everything fitted for one horizon. */
export interface Fitted {
  horizon: Horizon;
  logit: LinearModel;
  gbt: GbtModel;
  /** Predicts the log return itself. */
  ridge: LinearModel;
  /** The 10th and 90th percentile of the ridge model's training errors, in units of the coin's own volatility. */
  q10: number;
  q90: number;
  /** Baselines: how often the price rose in the training rows, overall and after a positive / negative 30-day return. */
  base: number;
  afterUp: number;
  afterDown: number;
  rows: number;
  /** The first and last day trained on. */
  firstDay: number;
  lastDay: number;
}

/** The size of a typical h-day move for this coin: its daily volatility scaled to h days. */
const spread = (x: readonly number[], h: number) => Math.max(1e-4, x[VOL30]) * Math.sqrt(h);

export function fitModels(train: readonly Sample[], h: Horizon, o: ModelOptions = MODEL_DEFAULTS): Fitted {
  const X = train.map(s => s.x), r = train.map(s => s.fwd[h] as number), y = r.map(v => (v > 0 ? 1 : 0));
  const logit = fitLogistic(X, y, o.lambda), gbt = fitGbt(X, y, o.gbt), ridge = fitRidge(X, r, o.lambda);
  const z = train.map((s, i) => (r[i] - score(ridge, s.x)) / spread(s.x, h));
  // Add-one smoothing, so a small group can't claim 0% or 100%.
  const share = (rows: number[]) => (rows.reduce((s, i) => s + y[i], 0) + 1) / (rows.length + 2);
  const all = train.map((_, i) => i);
  return {
    horizon: h, logit, gbt, ridge, q10: quantile(z, 0.1), q90: quantile(z, 0.9),
    base: share(all), afterUp: share(all.filter(i => X[i][RET30] > 0)), afterDown: share(all.filter(i => X[i][RET30] <= 0)),
    rows: train.length, firstDay: train[0].day, lastDay: train[train.length - 1].day,
  };
}

export interface Forecast {
  /** The chance of a rise according to each model. */
  logit: number;
  gbt: number;
  /** Baselines: the share of rises so far ("always up" as a probability) and the same after a positive / negative 30-day return ("momentum"). */
  base: number;
  momentum: number;
  /** Whether the last 30 days were up (the plain momentum rule says "up" then). */
  trendUp: boolean;
  /** The middle estimate of the log return, and a range that held 80% of the time in training. */
  mu: number;
  lo: number;
  hi: number;
}

export function forecast(f: Fitted, x: readonly number[]): Forecast {
  const mu = score(f.ridge, x), s = spread(x, f.horizon);
  return {
    logit: predictLogistic(f.logit, x), gbt: predictGbt(f.gbt, x),
    base: f.base, momentum: x[RET30] > 0 ? f.afterUp : f.afterDown, trendUp: x[RET30] > 0,
    mu, lo: mu + f.q10 * s, hi: mu + f.q90 * s,
  };
}

/** How much each input pushed each model's forecast up or down, in log-odds. */
export const drivers = (f: Fitted, x: readonly number[]) => ({ logit: contributions(f.logit, x), gbt: gbtContributions(f.gbt, x) });

/** One forecast made in the walk-forward test, with what then happened. */
export interface Tested extends Forecast {
  coin: string;
  day: number;
  /** The log return that followed, and whether it was a rise. */
  r: number;
  y: 0 | 1;
}

export interface WalkForward {
  rows: Tested[];
  folds: number;
  firstTrainRows: number;
  lastTrainRows: number;
  /** Each step: the first day forecast and the last day trained on (always more than h days earlier). */
  steps: { start: number; trainedThrough: number }[];
}

/** The rows whose h-day outcome was fully known before `day`. */
export const knownBefore = (samples: readonly Sample[], h: Horizon, day: number) => samples.filter(s => s.fwd[h] != null && s.day + h < day);

/** The first day of every step of the walk-forward test: one every `o.step` days once `o.minTrainDays` days of outcomes are known. */
export function walkForwardStarts(labelled: readonly Sample[], h: Horizon, o: ModelOptions = MODEL_DEFAULTS): number[] {
  const days = [...new Set(labelled.map(s => s.day))].sort((a, b) => a - b), out: number[] = [];
  if (days.length <= o.minTrainDays) return out;
  for (let start = days[o.minTrainDays - 1] + h + 1; start <= days[days.length - 1]; start += o.step) out.push(start);
  return out;
}

/**
 * One step: train on the outcomes fully known before `start`, forecast the `o.step` days from `start` on.
 * `labelled` holds only rows whose h-day outcome exists. Null when the step has no days to forecast.
 */
export function walkForwardStep(labelled: readonly Sample[], h: Horizon, start: number, o: ModelOptions = MODEL_DEFAULTS): { rows: Tested[]; trainRows: number; trainedThrough: number } | null {
  const test = labelled.filter(s => s.day >= start && s.day < start + o.step);
  if (!test.length) return null;
  const train = knownBefore(labelled, h, start);
  const f = fitModels(train, h, o);
  return { rows: test.map(s => { const r = s.fwd[h] as number; return { coin: s.coin, day: s.day, r, y: r > 0 ? 1 : 0, ...forecast(f, s.x) }; }), trainRows: train.length, trainedThrough: f.lastDay };
}

export function walkForward(samples: readonly Sample[], h: Horizon, o: ModelOptions = MODEL_DEFAULTS): WalkForward {
  const labelled = samples.filter(s => s.fwd[h] != null);
  const out: WalkForward = { rows: [], folds: 0, firstTrainRows: 0, lastTrainRows: 0, steps: [] };
  for (const start of walkForwardStarts(labelled, h, o)) {
    const step = walkForwardStep(labelled, h, start, o);
    if (!step) continue;
    out.rows.push(...step.rows);
    if (!out.folds++) out.firstTrainRows = step.trainRows;
    out.lastTrainRows = step.trainRows;
    out.steps.push({ start, trainedThrough: step.trainedThrough });
  }
  return out;
}

/**
 * How much a model's probability would move if history had dealt a slightly different sample:
 * the model is refitted `rounds` times on resampled training data (whole blocks of days drawn with
 * replacement, because coins move together and neighbouring days overlap), and the 10th to 90th percentile
 * of the refits' forecasts is returned for each row of `X`.
 */
export function probabilityBands(train: readonly Sample[], h: Horizon, X: readonly (readonly number[])[], o: ModelOptions = MODEL_DEFAULTS, rounds = 30, seed = 7, model: ModelKey = "logit"): [number, number][] {
  const blockDays = Math.max(7, h), first = train[0].day;
  const blocks = new Map<number, Sample[]>();
  for (const s of train) { const k = Math.floor((s.day - first) / blockDays); let b = blocks.get(k); if (!b) blocks.set(k, b = []); b.push(s); }
  const list = [...blocks.values()];
  let a = seed >>> 0;
  const rand = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
  const preds: number[][] = X.map(() => []);
  for (let b = 0; b < rounds; b++) {
    const pick: Sample[] = [];
    for (let k = 0; k < list.length; k++) pick.push(...list[Math.floor(rand() * list.length)]);
    const px = pick.map(s => s.x), py = pick.map(s => ((s.fwd[h] as number) > 0 ? 1 : 0));
    if (model === "gbt") { const m = fitGbt(px, py, { ...o.gbt, seed: seed + b }); X.forEach((x, i) => preds[i].push(predictGbt(m, x))); }
    else { const m = fitLogistic(px, py, o.lambda); X.forEach((x, i) => preds[i].push(predictLogistic(m, x))); }
  }
  return preds.map(p => [quantile(p, 0.1), quantile(p, 0.9)]);
}
