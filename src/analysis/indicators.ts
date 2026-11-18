/**
 * Technical indicators on a series of daily closes (oldest first).
 * Every output has the same length as the input; values that need more history are null.
 * Every value at index i uses only inputs 0..i (no peeking ahead), which the backtester relies on.
 */
import type { Series } from "./math";

/** Simple moving average over n values. */
export function sma(c: readonly number[], n: number): Series {
  const out: Series = new Array(c.length).fill(null);
  let s = 0;
  for (let i = 0; i < c.length; i++) {
    s += c[i];
    if (i >= n) s -= c[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/**
 * Exponential moving average, smoothing k = 2 / (n + 1), seeded with the simple average of the
 * first n values (the usual charting-platform definition). Leading nulls in the input are skipped,
 * so it can smooth another indicator (the MACD signal line is an EMA of the MACD line).
 */
export function ema(values: Series | readonly number[], n: number): Series {
  const out: Series = new Array(values.length).fill(null);
  const first = values.findIndex(v => v != null);
  if (first < 0 || values.length - first < n) return out;
  const k = 2 / (n + 1);
  let seed = 0;
  for (let i = first; i < first + n; i++) seed += values[i] as number;
  let prev = seed / n;
  out[first + n - 1] = prev;
  for (let i = first + n; i < values.length; i++) {
    const v = values[i];
    if (v == null) return out; // a gap ends the series; callers never pass one
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Relative Strength Index with Wilder's smoothing (period n, default 14). First value at index n.
 * A flat stretch with no gains and no losses reads 50, not 100.
 */
export function rsi(c: readonly number[], n = 14): Series {
  const out: Series = new Array(c.length).fill(null);
  if (c.length <= n) return out;
  const value = (g: number, l: number) => (g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l));
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  out[n] = value(g, l);
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = value(g, l);
  }
  return out;
}

export interface Macd { m: Series; sig: Series; hist: Series }

/** MACD (fast EMA minus slow EMA), its signal line (EMA of MACD) and the histogram (MACD minus signal). */
export function macd(c: readonly number[], fast = 12, slow = 26, signal = 9): Macd {
  const ef = ema(c, fast), es = ema(c, slow);
  const m: Series = ef.map((v, i) => (v == null || es[i] == null ? null : v - (es[i] as number)));
  const sig = ema(m, signal);
  const hist: Series = m.map((v, i) => (v == null || sig[i] == null ? null : v - (sig[i] as number)));
  return { m, sig, hist };
}

export interface Bands { mid: Series; up: Series; lo: Series }

/** Bollinger bands: n-day SMA plus/minus k population standard deviations of the same window. */
export function bollinger(c: readonly number[], n = 20, k = 2): Bands {
  const mid = sma(c, n), up: Series = [], lo: Series = [];
  for (let i = 0; i < c.length; i++) {
    const m = mid[i];
    if (m == null) { up.push(null); lo.push(null); continue; }
    let ss = 0;
    for (let j = i - n + 1; j <= i; j++) ss += (c[j] - m) ** 2;
    const sd = Math.sqrt(ss / n);
    up.push(m + k * sd); lo.push(m - k * sd);
  }
  return { mid, up, lo };
}

/** On-balance volume: running sum of volume, added on up days and subtracted on down days. */
export function obv(c: readonly number[], v: readonly number[]): number[] {
  const out = [0];
  for (let i = 1; i < c.length; i++) out.push(out[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0));
  return out;
}

/** Largest peak-to-trough fall, as a negative fraction (-0.5 means a 50% drop). 0 if it never fell. */
export function maxDrawdown(c: readonly number[]): number {
  let peak = c[0], mdd = 0;
  for (const x of c) { if (x > peak) peak = x; mdd = Math.min(mdd, x / peak - 1); }
  return mdd;
}
