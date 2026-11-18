/** The Technicals tab: indicator readings, swing levels, Fibonacci levels and monthly returns. */
import type { History } from "../data/types";
import { mean, pct, slope } from "./math";
import { bollinger, ema, macd, obv } from "./indicators";
import type { Analysis, Tone } from "./scoring";

/** Swing points: index i is a high (low) if it is the max (min) of the 2k+1 closes around it. */
export function pivots(c: readonly number[], k = 5): { hi: number[]; lo: number[] } {
  const hi: number[] = [], lo: number[] = [];
  for (let i = k; i < c.length - k; i++) {
    const w = c.slice(i - k, i + k + 1);
    if (c[i] === Math.max(...w)) hi.push(i);
    if (c[i] === Math.min(...w)) lo.push(i);
  }
  return { hi, lo };
}

export interface Level { v: number; n: number; sum: number }

/** Support and resistance: swing points grouped when within 3% of each other; the 2 nearest on each side. */
export function levels(c: readonly number[], p: number) {
  const pv = pivots(c, 5);
  const pts = [...pv.hi, ...pv.lo].map(i => c[i]).sort((a, b) => a - b);
  const cl: Level[] = [];
  for (const x of pts) {
    const last = cl[cl.length - 1];
    if (last && x / last.v - 1 < 0.03) { last.n++; last.sum += x; last.v = last.sum / last.n; }
    else cl.push({ v: x, n: 1, sum: x });
  }
  const sup = cl.filter(l => l.v < p * 0.99).sort((a, b) => b.v - a.v).slice(0, 2);
  const res = cl.filter(l => l.v > p * 1.01).sort((a, b) => a.v - b.v).slice(0, 2);
  return { sup, res, pv };
}

export interface MonthReturn { m: string; r: number; partialStart?: boolean; partialEnd?: boolean }

/** Calendar-month returns, each from the previous month's last close (the first month from its first close). */
export function monthly(dates: readonly string[], c: readonly number[]): MonthReturn[] {
  const out: MonthReturn[] = [];
  let curM: string | null = null, prevClose: number | null = null, startClose: number | null = null, last = 0;
  dates.forEach((d, i) => {
    const m = d.slice(0, 7);
    if (m !== curM) {
      if (curM && startClose != null) out.push({ m: curM, r: last / startClose - 1, partialStart: out.length === 0 && dates[0].slice(8) !== "01" });
      startClose = prevClose ?? c[i];
      curM = m;
    }
    prevClose = c[i]; last = c[i];
  });
  if (curM && startClose != null) out.push({ m: curM, r: last / startClose - 1, partialEnd: true });
  return out;
}

export type Sig = "bull" | "bear" | "neutral";
export interface IndicatorRow { group: string; name: string; state: string; sig: Sig; why: string }

export function technicals(h: History, a: Analysis) {
  const c = h.closes, n = c.length, p = c[n - 1], v = h.volumes || [];
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = n >= 200 ? ema(c, 200) : null;
  const bb = bollinger(c), md = macd(c), R = a.R;
  const bw = bb.up.map((u, i) => (u == null ? null : (u - (bb.lo[i] as number)) / (bb.mid[i] as number)));
  const bwRecent = bw.slice(-180).filter((x): x is number => x != null);
  const bwNow = bw[n - 1];
  const squeeze = bwRecent.length > 60 && bwNow != null && bwNow > 0 && bwNow <= pct(bwRecent, 0.15);
  const bUp = bb.up[n - 1] as number, bLo = bb.lo[n - 1] as number;
  const pB = bUp > bLo ? (p - bLo) / (bUp - bLo) : 0.5; // a perfectly flat price has zero-width bands

  const last = (s: (number | null)[]) => s[n - 1] as number;
  let macdCross: { days: number; up: boolean } | null = null;
  for (let i = n - 1; i > n - 11 && i > 34; i--) {
    const m1 = md.m[i], s1 = md.sig[i], m0 = md.m[i - 1], s0 = md.sig[i - 1];
    if (m1 == null || s1 == null || m0 == null || s0 == null) break;
    if ((m1 > s1) !== (m0 > s0)) { macdCross = { days: n - 1 - i, up: m1 > s1 }; break; }
  }

  const hasVol = v.length === n && v.some(x => x > 0);
  const obvLine = hasVol ? obv(c, v) : null;
  const obvS = obvLine ? slope(obvLine.slice(-30)) : 0, pxS = slope(c.slice(-30));
  const v90 = hasVol ? mean(v.slice(-90)) : 0;
  const volTrend = hasVol && v90 > 0 ? mean(v.slice(-20)) / v90 - 1 : null;

  let path = 0;
  for (let i = n - 30; i < n; i++) path += Math.abs(c[i] - c[i - 1]);
  const er = path > 0 ? Math.abs(c[n - 1] - c[n - 31]) / path : 0;

  const lv = levels(c, p);
  const hiI = lv.pv.hi.slice(-2), loI = lv.pv.lo.slice(-2);
  let structure = "Range-bound";
  if (hiI.length === 2 && loI.length === 2) {
    const hh = c[hiI[1]] > c[hiI[0]], hl = c[loI[1]] > c[loI[0]];
    if (hh && hl) structure = "Higher highs and higher lows";
    else if (!hh && !hl) structure = "Lower highs and lower lows";
  }
  const lo1 = Math.min(...c), hi1 = Math.max(...c);
  const fibs = [0.236, 0.382, 0.5, 0.618, 0.786].map(f => ({ f, v: hi1 - (hi1 - lo1) * f }));
  const pos = hi1 > lo1 ? (p - lo1) / (hi1 - lo1) : 0.5;

  const B: Sig = "bull", S: Sig = "bear", N: Sig = "neutral";
  const rows: IndicatorRow[] = [];
  const add = (group: string, name: string, state: string, sig: Sig, why: string) => rows.push({ group, name, state, sig, why });
  const E20 = last(e20), E50 = last(e50), M = last(md.m), MS = last(md.sig);
  add("Trend", "Price vs 20-day EMA", p > E20 ? "Above" : "Below", p > E20 ? B : S, "Short-term direction.");
  add("Trend", "20-day vs 50-day EMA", E20 > E50 ? "20 above 50" : "20 below 50", E20 > E50 ? B : S, "Medium-term direction.");
  if (e200) { const E200 = last(e200); add("Trend", "Price vs 200-day EMA", p > E200 ? "Above" : "Below", p > E200 ? B : S, "The big-picture regime most traders watch."); }
  add("Trend", "Market structure", structure, structure.startsWith("Higher") ? B : structure.startsWith("Lower") ? S : N, "Compares the last two swing highs and lows.");
  add("Trend", "Trend efficiency (30d)", er.toFixed(2) + (er > 0.4 ? " strong" : er < 0.2 ? " choppy" : " moderate"), N, "1.0 means a straight line, near 0 means noise. Trend signals work better when this is high.");
  add("Momentum", "MACD vs signal", (M > MS ? "Above" : "Below") + (macdCross ? `, crossed ${macdCross.days}d ago` : ""), M > MS ? B : S, "Momentum turning up or down.");
  add("Momentum", "MACD vs zero", M > 0 ? "Positive" : "Negative", M > 0 ? B : S, "Positive means the 12-day trend is above the 26-day.");
  add("Momentum", "RSI (14)", R.toFixed(0), R > 70 ? S : R < 30 ? B : R >= 55 ? B : R <= 45 ? S : N, "Over 70 overbought (pullback risk), under 30 oversold (bounce chance).");
  const r30 = a.ret30 ?? 0;
  add("Momentum", "30-day change", (r30 * 100).toFixed(1) + "%", r30 > 0.05 ? B : r30 < -0.05 ? S : N, "Plain rate of change.");
  add("Volatility", "Bollinger %B", (pB * 100).toFixed(0) + "%", pB > 1 ? S : pB < 0 ? B : N, "Above 100% is outside the upper band (stretched), below 0% outside the lower band.");
  add("Volatility", "Bollinger squeeze", squeeze ? "Yes, bands very tight" : "No", N, "Tight bands often come before a big move. Direction unknown.");
  if (hasVol) {
    add("Volume", "On-balance volume (30d)", obvS > 0 ? "Rising" : "Falling", obvS > 0 ? B : S, "Is volume flowing in on up days or down days?");
    add("Volume", "Price/volume agreement", (obvS > 0) === (pxS > 0) ? "Agree" : "Divergence", (obvS > 0) === (pxS > 0) ? N : (obvS > 0 ? B : S), "A divergence warns the price move may not last.");
    if (volTrend != null) add("Volume", "Volume, 20d vs 90d avg", (volTrend > 0 ? "+" : "") + (volTrend * 100).toFixed(0) + "%", N, "Rising volume confirms whichever direction price is going.");
  }
  add("Levels", "Position in 1-year range", (pos * 100).toFixed(0) + "%", N, "0% is the 1-year low, 100% the high.");

  const bull = rows.filter(r => r.sig === B).length, bear = rows.filter(r => r.sig === S).length, neu = rows.length - bull - bear;
  const net = (bull - bear) / (bull + bear || 1);
  let cons: { k: Tone; t: string };
  if (net > 0.5) cons = { k: "good", t: "Technicals: mostly bullish" };
  else if (net > 0.15) cons = { k: "good", t: "Technicals: leaning bullish" };
  else if (net < -0.5) cons = { k: "bad", t: "Technicals: mostly bearish" };
  else if (net < -0.15) cons = { k: "bad", t: "Technicals: leaning bearish" };
  else cons = { k: "neutral", t: "Technicals: mixed" };

  return { e20, e50, e200, bb, md, obv: obvLine, rows, bull, bear, neu, cons, lv, fibs, lo1, hi1, pos, structure, er, squeeze, macdCross, months: monthly(h.dates, c) };
}

export type Technicals = ReturnType<typeof technicals>;
