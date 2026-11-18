/** Small statistics helpers. Pure functions, no DOM, no network. */

export type Series = (number | null)[];

export const clamp = (x: number, a = 0, b = 1): number => Math.min(b, Math.max(a, x));

export const mean = (a: readonly number[]): number => a.reduce((s, x) => s + x, 0) / a.length;

/** Sample standard deviation (divides by n - 1). NaN for fewer than 2 values. */
export function std(a: readonly number[]): number {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

/** Percentile with linear interpolation, p in [0, 1]. */
export function pct(a: readonly number[], p: number): number {
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** Daily log returns: ln(c[i] / c[i-1]). */
export function logrets(c: readonly number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
  return r;
}

/** Standard normal cumulative distribution (Abramowitz-Stegun approximation, error < 1e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Pearson correlation of the last min(len) values. Null when either side has no variation. */
export function corr(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  const x = a.slice(-n), y = b.slice(-n);
  const mx = mean(x), my = mean(y);
  let sxy = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
  const r = sxy / Math.sqrt(sx * sy);
  return Number.isFinite(r) ? r : null;
}

/** Least-squares slope of the values against their index. */
export function slope(a: readonly number[]): number {
  const n = a.length, xm = (n - 1) / 2, ym = mean(a);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xm) * (a[i] - ym); den += (i - xm) ** 2; }
  return den ? num / den : 0;
}
