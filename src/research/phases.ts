/**
 * The long-term test's scoring: the same scores as the nightly walk-forward test (`evaluate`), per market
 * phase, with a block bootstrap by week that says whether "better than the baseline" is more than luck.
 */
import { btcRegime, dayString, type Horizon } from "../model/features";
import type { History } from "../data/types";
import { quantile, spearman, type CalBin, type Verdict } from "../model/metrics";
import { evaluate, type BaselineKey, type ModelKey } from "../model/report";
import type { Tested } from "../model/walkforward";

/** Weeks run Monday to Sunday (day 0, 1 January 1970, was a Thursday). */
export const weekOf = (day: number) => Math.floor((day + 3) / 7);
export const yearOf = (day: number) => Number(dayString(day).slice(0, 4));

/** Fewer weeks than this and no range is given. */
export const MIN_WEEKS = 8;

export interface Boot {
  /** The statistic on the real data. */
  mean: number;
  /** The 95% range across the resamples; null with too few weeks. */
  lo: number | null;
  hi: number | null;
  /** The share of resamples in which the statistic was below zero. */
  below: number | null;
  weeks: number;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * A block bootstrap by week of the ratio sum(num) / sum(den) (den = 1 per row when left out, which makes
 * it a plain average). Rows are grouped into calendar weeks; each resample draws runs of `blockWeeks`
 * consecutive weeks, with replacement, until it has as many weeks as the data. Coins move together and
 * forecasts a few days apart share their outcome, so whole weeks, kept next to their neighbours, are the
 * unit that is redrawn, never single rows.
 */
export function bootstrapByWeek(day: readonly number[], num: readonly number[], den: readonly number[] | null, blockWeeks: number, rounds = 2000, seed = 1): Boot {
  const weeks = new Map<number, [number, number]>();
  let N = 0, D = 0;
  for (let i = 0; i < day.length; i++) {
    const w = weekOf(day[i]), d = den ? den[i] : 1;
    let s = weeks.get(w);
    if (!s) weeks.set(w, s = [0, 0]);
    s[0] += num[i]; s[1] += d; N += num[i]; D += d;
  }
  const list = [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]), W = list.length, mean = D ? N / D : 0;
  if (W < MIN_WEEKS) return { mean, lo: null, hi: null, below: null, weeks: W };
  const L = Math.max(1, Math.min(blockWeeks, W)), blocks = Math.ceil(W / L), rand = rng(seed), stats: number[] = [];
  for (let r = 0; r < rounds; r++) {
    let a = 0, b = 0;
    for (let k = 0; k < blocks; k++) {
      const s = Math.floor(rand() * W);
      for (let j = 0; j < L; j++) { const x = list[(s + j) % W]; a += x[0]; b += x[1]; }
    }
    stats.push(b ? a / b : 0);
  }
  return { mean, lo: quantile(stats, 0.025), hi: quantile(stats, 0.975), below: stats.filter(v => v < 0).length / rounds, weeks: W };
}

export interface ModelPhase {
  /** Share of forecasts on the right side of 50%. */
  accuracy: number;
  brier: number;
  auc: number;
  /** The average gap between the forecast chance and how often the rise happened. */
  calibrationError: number;
  /** Brier score minus the best baseline's (negative = the model is better), bootstrapped by week. */
  vsBest: Boot;
  /** Hit rate minus that of always saying the commoner outcome so far (positive = the model is better). */
  vsHit: Boot;
  /** Picking coins: the average daily rank correlation between forecast and outcome (0 = none). */
  rank: Boot;
  /**
   * What the ranking is worth: the h-day log return of the fifth of coins the model rated highest, minus that of
   * the average coin the same day (0.01 is about 1 percentage point; before any trading costs).
   */
  top: Boot;
  /** "better" or "worse" only when the whole 95% range of `vsBest` is on one side of zero. */
  verdict: Verdict;
}

export interface PhaseReport {
  key: string;
  label: string;
  n: number;
  coins: number;
  from: string | null;
  to: string | null;
  /** How often the price actually rose. */
  upShare: number;
  bestBaseline: BaselineKey;
  /** "Always up" and "simple momentum" as probabilities (the shares of rises seen so far). */
  base: { accuracy: number; brier: number };
  momentum: { accuracy: number; brier: number };
  logit: ModelPhase;
  gbt: ModelPhase;
}

const round = (x: number, d = 4) => { const k = 10 ** d; return Math.round(x * k) / k; };
const roundBoot = (b: Boot, d = 5): Boot => ({ mean: round(b.mean, d), lo: b.lo == null ? null : round(b.lo, d), hi: b.hi == null ? null : round(b.hi, d), below: b.below == null ? null : round(b.below, 3), weeks: b.weeks });

/** A block is two horizons long, as in the nightly test: 2 weeks for 7-day forecasts, 9 for 30-day. */
export const blockWeeksFor = (h: Horizon) => Math.ceil(2 * h / 7);

/** One phase's scores. `rows` are the walk-forward forecasts that fall in the phase. Null when there are none. */
export function phaseReport(key: string, label: string, rows: readonly Tested[], h: Horizon, rounds = 2000): PhaseReport | null {
  if (!rows.length) return null;
  const e = evaluate(rows, h), L = blockWeeksFor(h);
  const day = rows.map(r => r.day);
  const bestP = (r: Tested) => (e.bestBaseline === "base" ? r.base : e.bestBaseline === "momentum" ? r.momentum : 0.5);
  const byDay = new Map<number, Tested[]>();
  for (const r of rows) { let d = byDay.get(r.day); if (!d) byDay.set(r.day, d = []); d.push(r); }
  const icDays = [...byDay].filter(([, list]) => list.length >= 10);
  const mean = (list: readonly Tested[]) => list.reduce((s, r) => s + r.r, 0) / list.length;
  const model = (m: ModelKey): ModelPhase => {
    const vsBest = bootstrapByWeek(day, rows.map(r => (r[m] - r.y) ** 2 - (bestP(r) - r.y) ** 2), null, L, rounds);
    const hit = (p: number, y: number) => ((p > 0.5 ? 1 : 0) === y ? 1 : 0);
    const vsHit = bootstrapByWeek(day, rows.map(r => hit(r[m], r.y) - hit(r.base, r.y)), null, L, rounds);
    const rank = bootstrapByWeek(icDays.map(d => d[0]), icDays.map(([, list]) => spearman(list.map(r => r[m]), list.map(r => r.r))), null, L, rounds);
    const top = bootstrapByWeek(icDays.map(d => d[0]), icDays.map(([, list]) => mean([...list].sort((a, b) => b[m] - a[m] || (a.coin < b.coin ? -1 : 1)).slice(0, Math.ceil(list.length / 5))) - mean(list)), null, L, rounds);
    const verdict: Verdict = vsBest.lo == null || vsBest.hi == null ? "unknown" : vsBest.hi < 0 ? "better" : vsBest.lo > 0 ? "worse" : "same";
    return { accuracy: e[m].accuracy, brier: e[m].brier, auc: e[m].auc, calibrationError: e.calibrationError[m], vsBest: roundBoot(vsBest), vsHit: roundBoot(vsHit, 4), rank: roundBoot(rank, 4), top: roundBoot(top, 5), verdict };
  };
  return {
    key, label, n: e.n, coins: e.coins, from: e.from, to: e.to, upShare: e.upShare, bestBaseline: e.bestBaseline,
    base: { accuracy: e.base.accuracy, brier: e.base.brier }, momentum: { accuracy: e.momentum.accuracy, brier: e.momentum.brier },
    logit: model("logit"), gbt: model("gbt"),
  };
}

/** The calibration tables of a set of forecasts (the nightly test's own). */
export const calibrationOf = (rows: readonly Tested[], h: Horizon): Record<ModelKey, CalBin[]> => evaluate(rows, h).calibration;

/**
 * Whether Bitcoin closed above its 200-day average on each day (the average of all its history until it
 * has 200 days: the same definition as the model's own "market mood" input).
 */
export function btcAboveLong(btc: History): Map<number, boolean> {
  const out = new Map<number, boolean>();
  for (const [day, r] of btcRegime(btc)) out.set(day, r[2] > 0);
  return out;
}

export interface Phases {
  overall: PhaseReport;
  years: PhaseReport[];
  regimes: PhaseReport[];
  groups: PhaseReport[];
  /** Boosted trees' Brier score minus logistic regression's over all years (negative = the trees were better), bootstrapped by week. */
  gbtVsLogit: Boot;
}

/**
 * Every phase of the long-term test: overall, each calendar year (by the day the forecast was made), Bitcoin
 * above or below its 200-day average on that day, and today's scanned coins against all the others.
 */
export function allPhases(rows: readonly Tested[], h: Horizon, above: ReadonlyMap<number, boolean>, scanCoins: ReadonlySet<string>, rounds = 2000): Phases {
  const overall = phaseReport("all", "All years", rows, h, rounds);
  if (!overall) throw new Error("no forecasts to score");
  const keep = (list: (PhaseReport | null)[]) => list.filter((p): p is PhaseReport => p != null);
  const years = [...new Set(rows.map(r => yearOf(r.day)))].sort((a, b) => a - b);
  return {
    overall,
    gbtVsLogit: roundBoot(bootstrapByWeek(rows.map(r => r.day), rows.map(r => (r.gbt - r.y) ** 2 - (r.logit - r.y) ** 2), null, blockWeeksFor(h), rounds)),
    years: keep(years.map(y => phaseReport(String(y), String(y), rows.filter(r => yearOf(r.day) === y), h, rounds))),
    regimes: keep([
      phaseReport("above", "Bitcoin above its 200-day average", rows.filter(r => above.get(r.day) === true), h, rounds),
      phaseReport("below", "Bitcoin below its 200-day average", rows.filter(r => above.get(r.day) === false), h, rounds),
    ]),
    groups: keep([
      phaseReport("scan", "Coins in today's top-coin scan", rows.filter(r => scanCoins.has(r.coin)), h, rounds),
      phaseReport("rest", "All other coins", rows.filter(r => !scanCoins.has(r.coin)), h, rounds),
    ]),
  };
}
