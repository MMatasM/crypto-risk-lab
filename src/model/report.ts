/**
 * Scores a set of forecasts against what happened and against the baselines. Used twice with the same code:
 * for the walk-forward test on past data (validation.json) and for the live track record of the forecasts
 * logged every night (track.json).
 */
import { dayString, type Horizon } from "./features";
import { blockInterval, calibration, calibrationError, compareBrier, scoreProbs, spearman, type CalBin, type Comparison, type Interval, type Scores, type Verdict } from "./metrics";
import type { Tested } from "./walkforward";

export type ModelKey = "logit" | "gbt";
export type BaselineKey = "base" | "momentum" | "flip";

export const MODEL_NAMES: Record<ModelKey, string> = { logit: "Logistic regression", gbt: "Boosted trees" };
export const BASELINE_NAMES: Record<BaselineKey, string> = { base: "Always up", momentum: "Simple momentum", flip: "Coin flip (always 50%)" };

export interface HorizonReport {
  horizon: Horizon;
  /** Forecasts scored, the coins and the days they cover. */
  n: number;
  coins: number;
  from: string | null;
  to: string | null;
  days: number;
  /** How often the price actually rose. */
  upShare: number;
  logit: Scores;
  gbt: Scores;
  /** "Always up" as a probability: the share of rises seen so far. Its accuracy is that of always saying whichever was more common. */
  base: Scores;
  /** "Simple momentum" as a probability: the share of rises seen so far after a positive, or negative, 30-day return. */
  momentum: Scores;
  /** The two baselines as plain rules: always say "up", and say "up" when the last 30 days were up. */
  alwaysUpAccuracy: number;
  momentumRuleAccuracy: number;
  calibration: Record<ModelKey, CalBin[]>;
  calibrationError: Record<ModelKey, number>;
  /** Brier score, model minus baseline, with a 95% range (negative = the model is better). */
  versus: Record<ModelKey, Record<BaselineKey, Comparison>>;
  /** The baseline with the best (lowest) Brier score, and each model's verdict against it. */
  bestBaseline: BaselineKey;
  verdict: Record<ModelKey, Verdict>;
  /** Can the model tell tomorrow's winners from the losers? The average daily rank correlation, across coins, between the forecast and the return that followed. */
  rankSkill: Record<ModelKey, Interval>;
  /** The return estimate: skill against forecasting "no change" (1 = perfect, 0 = no better, negative = worse), and how often the 80% range held the outcome. */
  ret: { r2: number; coverage: number; rankSkill: Interval };
  /** Per coin: [forecasts, logistic accuracy, boosted-trees accuracy, share of rises]. */
  byCoin: Record<string, [number, number, number, number]>;
}

const round = (x: number, d = 4) => { const k = 10 ** d; return Math.round(x * k) / k; };
const roundScores = (s: Scores): Scores => ({ n: s.n, accuracy: round(s.accuracy), brier: round(s.brier, 5), logLoss: round(s.logLoss, 5), auc: round(s.auc) });
const roundInterval = <T extends Interval>(c: T): T => ({ ...c, mean: round(c.mean, 5), lo: c.lo == null ? null : round(c.lo, 5), hi: c.hi == null ? null : round(c.hi, 5) });

/** The average over days of the rank correlation, across coins, between a forecast and the realised return. */
function dailyRankSkill(rows: readonly Tested[], pick: (r: Tested) => number, blockDays: number): Interval {
  const byDay = new Map<number, Tested[]>();
  for (const r of rows) { let d = byDay.get(r.day); if (!d) byDay.set(r.day, d = []); d.push(r); }
  const days: number[] = [], ic: number[] = [];
  for (const [day, list] of byDay) if (list.length >= 10) { days.push(day); ic.push(spearman(list.map(pick), list.map(r => r.r))); }
  return roundInterval(blockInterval(ic, days, blockDays));
}

export function evaluate(rows: readonly Tested[], h: Horizon): HorizonReport {
  const y = rows.map(r => r.y), day = rows.map(r => r.day), n = rows.length;
  // Forecasts for overlapping windows share most of their outcome, so a block is two horizons long.
  const blockDays = 2 * h;
  const p: Record<ModelKey | BaselineKey, number[]> = { logit: rows.map(r => r.logit), gbt: rows.map(r => r.gbt), base: rows.map(r => r.base), momentum: rows.map(r => r.momentum), flip: rows.map(() => 0.5) };
  const up = y.reduce((s: number, v) => s + v, 0);
  const scores = { logit: scoreProbs(p.logit, y), gbt: scoreProbs(p.gbt, y), base: scoreProbs(p.base, y), momentum: scoreProbs(p.momentum, y) };
  const versus = {} as HorizonReport["versus"];
  for (const m of ["logit", "gbt"] as const) {
    versus[m] = {} as Record<BaselineKey, Comparison>;
    for (const b of ["base", "momentum", "flip"] as const) versus[m][b] = roundInterval(compareBrier(p[m], p[b], y, day, blockDays));
  }
  const brier: Record<BaselineKey, number> = { base: scores.base.brier, momentum: scores.momentum.brier, flip: 0.25 };
  const bestBaseline = (["base", "momentum", "flip"] as const).reduce((a, b) => (brier[b] < brier[a] ? b : a));
  const cal = { logit: calibration(p.logit, y), gbt: calibration(p.gbt, y) };
  const byCoin: HorizonReport["byCoin"] = {};
  const tally = new Map<string, [number, number, number, number]>();
  for (const r of rows) {
    let t = tally.get(r.coin);
    if (!t) tally.set(r.coin, t = [0, 0, 0, 0]);
    t[0]++; if ((r.logit > 0.5 ? 1 : 0) === r.y) t[1]++; if ((r.gbt > 0.5 ? 1 : 0) === r.y) t[2]++; t[3] += r.y;
  }
  for (const [coin, t] of [...tally].sort((a, b) => (a[0] < b[0] ? -1 : 1))) byCoin[coin] = [t[0], round(t[1] / t[0], 3), round(t[2] / t[0], 3), round(t[3] / t[0], 3)];
  let sse = 0, ss0 = 0, inside = 0;
  for (const r of rows) { sse += (r.r - r.mu) ** 2; ss0 += r.r ** 2; if (r.r >= r.lo && r.r <= r.hi) inside++; }
  const days = new Set(day);
  let first = Infinity, last = -Infinity;
  for (const d of days) { if (d < first) first = d; if (d > last) last = d; }
  return {
    horizon: h, n, coins: tally.size, from: n ? dayString(first) : null, to: n ? dayString(last) : null, days: days.size,
    upShare: n ? round(up / n) : 0,
    logit: roundScores(scores.logit), gbt: roundScores(scores.gbt), base: roundScores(scores.base), momentum: roundScores(scores.momentum),
    alwaysUpAccuracy: n ? round(up / n) : 0,
    momentumRuleAccuracy: n ? round(rows.filter(r => (r.trendUp ? 1 : 0) === r.y).length / n) : 0,
    calibration: { logit: cal.logit.map(roundBin), gbt: cal.gbt.map(roundBin) },
    calibrationError: { logit: round(calibrationError(cal.logit)), gbt: round(calibrationError(cal.gbt)) },
    versus, bestBaseline, verdict: { logit: versus.logit[bestBaseline].verdict, gbt: versus.gbt[bestBaseline].verdict },
    rankSkill: { logit: dailyRankSkill(rows, r => r.logit, blockDays), gbt: dailyRankSkill(rows, r => r.gbt, blockDays) },
    ret: { r2: ss0 ? round(1 - sse / ss0) : 0, coverage: n ? round(inside / n) : 0, rankSkill: dailyRankSkill(rows, r => r.mu, blockDays) },
    byCoin,
  };
}

const roundBin = (b: CalBin): CalBin => ({ lo: b.lo, hi: b.hi, n: b.n, predicted: round(b.predicted), observed: round(b.observed) });

/** The verdict in plain words, for the app and the nightly report. */
export function verdictText(r: HorizonReport, m: ModelKey): string {
  const c = r.versus[m][r.bestBaseline], base = BASELINE_NAMES[r.bestBaseline].toLowerCase(), name = MODEL_NAMES[m];
  if (!r.n) return "No forecasts have been scored yet.";
  if (c.verdict === "unknown") return `Too little history to say: only ${c.blocks} independent ${2 * r.horizon}-day period${c.blocks === 1 ? "" : "s"} could be tested (at least 4 are needed).`;
  if (c.verdict === "better") return `${name} beat the best baseline (${base}) by more than luck would explain.`;
  if (c.verdict === "worse") return `${name} was worse than the best baseline (${base}). Don't rely on it.`;
  return `${name} did not beat the best baseline (${base}): the difference is within what luck would explain.`;
}
