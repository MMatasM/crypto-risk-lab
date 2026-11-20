/**
 * How good a set of probability forecasts was: accuracy, Brier score, calibration, and whether a difference
 * from a baseline is bigger than luck would explain.
 */

export interface Scores {
  n: number;
  /** Share of forecasts on the right side of 50%. */
  accuracy: number;
  /** Mean squared gap between the forecast probability and what happened (0 or 1). Lower is better; always saying 50% scores 0.25. */
  brier: number;
  logLoss: number;
  /** Area under the ROC curve: the chance a rise got a higher probability than a fall. 0.5 = no skill at telling them apart. */
  auc: number;
}

export function auc(p: readonly number[], y: readonly number[]): number {
  const idx = p.map((_, i) => i).sort((a, b) => p[a] - p[b]);
  let rankSum = 0, pos = 0;
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j < idx.length && p[idx[j]] === p[idx[i]]) j++;
    const avg = (i + j + 1) / 2; // the average rank of a tied group (ranks start at 1)
    for (let k = i; k < j; k++) if (y[idx[k]] === 1) { rankSum += avg; pos++; }
    i = j;
  }
  const neg = p.length - pos;
  return pos && neg ? (rankSum - pos * (pos + 1) / 2) / (pos * neg) : 0.5;
}

export function scoreProbs(p: readonly number[], y: readonly number[]): Scores {
  const n = p.length;
  let hit = 0, b = 0, ll = 0;
  for (let i = 0; i < n; i++) {
    if ((p[i] > 0.5 ? 1 : 0) === y[i]) hit++;
    b += (p[i] - y[i]) ** 2;
    const q = Math.min(1 - 1e-12, Math.max(1e-12, p[i]));
    ll -= y[i] ? Math.log(q) : Math.log(1 - q);
  }
  return { n, accuracy: n ? hit / n : 0, brier: n ? b / n : 0, logLoss: n ? ll / n : 0, auc: auc(p, y) };
}

export interface CalBin {
  /** The bin's range of forecast probabilities. */
  lo: number;
  hi: number;
  n: number;
  /** The average forecast in the bin, and how often the rise actually happened. Calibrated forecasts have these equal. */
  predicted: number;
  observed: number;
}

/** Forecasts grouped into ten equal-width probability bins (empty bins left out). */
export function calibration(p: readonly number[], y: readonly number[], bins = 10): CalBin[] {
  const out: CalBin[] = Array.from({ length: bins }, (_, k) => ({ lo: k / bins, hi: (k + 1) / bins, n: 0, predicted: 0, observed: 0 }));
  for (let i = 0; i < p.length; i++) { const b = out[Math.min(bins - 1, Math.floor(p[i] * bins))]; b.n++; b.predicted += p[i]; b.observed += y[i]; }
  return out.filter(b => b.n).map(b => ({ ...b, predicted: b.predicted / b.n, observed: b.observed / b.n }));
}

/** Expected calibration error: the average gap between forecast and outcome frequency, weighted by bin size. */
export function calibrationError(bins: readonly CalBin[]): number {
  const n = bins.reduce((s, b) => s + b.n, 0);
  return n ? bins.reduce((s, b) => s + b.n * Math.abs(b.predicted - b.observed), 0) / n : 0;
}

/** Two-sided 95% critical values of Student's t for 1 to 30 degrees of freedom. */
const T95 = [12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.20, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.10, 2.09, 2.09, 2.08, 2.07, 2.07, 2.06, 2.06, 2.06, 2.05, 2.05, 2.05, 2.04];

/** Fewer independent periods than this and no verdict is given at all. */
export const MIN_BLOCKS = 4;

export interface Interval {
  mean: number;
  /** A 95% range for the true mean; null when there are too few independent periods to say. */
  lo: number | null;
  hi: number | null;
  /** Independent periods the range is based on. */
  blocks: number;
}

/**
 * The mean of `value` with an honest 95% range. Crypto coins move together and forecasts for overlapping
 * windows share most of their outcome, so thousands of rows are worth far fewer independent observations.
 * Rows are therefore grouped into blocks of `blockDays` days, each block counts once, and the range comes
 * from how much the block averages differ.
 */
export function blockInterval(value: readonly number[], day: readonly number[], blockDays: number): Interval {
  const n = value.length;
  if (!n) return { mean: 0, lo: null, hi: null, blocks: 0 };
  let first = Infinity;
  for (const d of day) if (d < first) first = d;
  const sum = new Map<number, [number, number]>();
  let total = 0;
  for (let i = 0; i < n; i++) {
    const k = Math.floor((day[i] - first) / blockDays), s = sum.get(k) ?? [0, 0];
    s[0] += value[i]; s[1]++; sum.set(k, s); total += value[i];
  }
  const means = [...sum.values()].map(s => s[0] / s[1]), B = means.length, mean = total / n;
  if (B < MIN_BLOCKS) return { mean, lo: null, hi: null, blocks: B };
  const m = means.reduce((s, v) => s + v, 0) / B;
  const se = Math.sqrt(means.reduce((s, v) => s + (v - m) ** 2, 0) / (B - 1) / B);
  const t = T95[B - 2] ?? 1.96;
  return { mean, lo: m - t * se, hi: m + t * se, blocks: B };
}

export type Verdict = "better" | "worse" | "same" | "unknown";

export interface Comparison extends Interval { verdict: Verdict }

/**
 * Model against baseline on the Brier score: `mean` is model minus baseline (negative = the model is better).
 * "better" or "worse" only when the whole 95% range is on one side of zero; "unknown" when there are too
 * few independent periods to say anything.
 */
export function compareBrier(pModel: readonly number[], pBase: readonly number[], y: readonly number[], day: readonly number[], blockDays: number): Comparison {
  const d = pModel.map((p, i) => (p - y[i]) ** 2 - (pBase[i] - y[i]) ** 2);
  const iv = blockInterval(d, day, blockDays);
  const verdict: Verdict = iv.lo == null || iv.hi == null ? "unknown" : iv.hi < 0 ? "better" : iv.lo > 0 ? "worse" : "same";
  return { ...iv, verdict };
}

/** Spearman rank correlation. */
export function spearman(a: readonly number[], b: readonly number[]): number {
  const ranks = (v: readonly number[]) => {
    const idx = v.map((_, i) => i).sort((i, j) => v[i] - v[j]), r = new Array<number>(v.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j < idx.length && v[idx[j]] === v[idx[i]]) j++;
      for (let k = i; k < j; k++) r[idx[k]] = (i + j - 1) / 2;
      i = j;
    }
    return r;
  };
  const ra = ranks(a), rb = ranks(b), n = a.length, m = (n - 1) / 2;
  let sab = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sab += (ra[i] - m) * (rb[i] - m); sa += (ra[i] - m) ** 2; sb += (rb[i] - m) ** 2; }
  return sa && sb ? sab / Math.sqrt(sa * sb) : 0;
}

/** Linear-interpolated quantile, q in [0, 1]. */
export function quantile(v: readonly number[], q: number): number {
  const s = [...v].sort((a, b) => a - b), i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
