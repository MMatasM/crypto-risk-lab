/** SVG charts, drawn as strings. Colours come from the CSS variables, so they follow light and dark mode. */
import type { Series } from "../analysis/math";
import type { Analysis } from "../analysis/scoring";
import type { Technicals } from "../analysis/technicals";
import type { History } from "../data/types";
import { eurShort, monthName } from "./format";

export interface Overlays { ema: boolean; bb: boolean; lv: boolean; fib: boolean }

function scaleY(vals: number[], H: number, pt: number, pb: number) {
  const finite = vals.filter(Number.isFinite);
  let lo = Math.min(...finite), hi = Math.max(...finite);
  const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.05 || 1;
  lo -= pad; hi += pad;
  const logS = lo > 0 && hi / lo > 4;
  const tf = (v: number) => (logS ? Math.log(v) : v);
  const ys = (v: number) => pt + (1 - (tf(v) - tf(lo)) / (tf(hi) - tf(lo))) * (H - pt - pb);
  const ticks: number[] = [];
  for (let k = 0; k <= 4; k++) ticks.push(logS ? Math.exp(tf(lo) + (tf(hi) - tf(lo)) * k / 4) : lo + (hi - lo) * k / 4);
  return { ys, ticks, lo, hi };
}

/** Left margin wide enough for the longest axis label (tiny prices have long labels). */
function leftPad(ticks: number[]): number {
  return Math.max(58, Math.ceil(Math.max(...ticks.map(v => eurShort(v).length)) * 6.6) + 10);
}

/** Values the technicals chart is scaled to (so the RSI and MACD charts under it can line up). */
function taValues(h: History, t: Technicals, show: Overlays): number[] {
  const vals = [...h.closes];
  if (show.bb) vals.push(...t.bb.up.filter((v): v is number => v != null), ...t.bb.lo.filter((v): v is number => v != null));
  return vals;
}

/** The technicals chart's left margin, for the charts drawn under it. */
export function taLeftPad(h: History, t: Technicals, show: Overlays): number {
  return leftPad(scaleY(taValues(h, t, show), 320, 12, 26).ticks);
}

function linePath(arr: Series | readonly number[], xs: (i: number) => number, ys: (v: number) => number): string {
  let d = "", on = false;
  arr.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) { on = false; return; }
    d += (on ? "L" : "M") + xs(i).toFixed(1) + " " + ys(v).toFixed(1);
    on = true;
  });
  return d;
}

function monthTicks(dates: readonly string[], xs: (i: number) => number, H: number): string {
  const out: number[] = [];
  let last = "";
  dates.forEach((d, i) => { const m = d.slice(0, 7); if (m !== last && d.slice(8) <= "07") { out.push(i); last = m; } });
  return out.filter((_, k) => k % 2 === 0)
    .map(i => `<text x="${xs(i)}" y="${H - 8}" text-anchor="middle" font-size="10.5" fill="var(--muted)">${monthName(dates[i])}</text>`).join("");
}

function yAxis(ticks: number[], ys: (v: number) => number, pl: number, W: number, pr: number, f: (v: number) => string): string {
  return ticks.map(v => `<line x1="${pl}" x2="${W - pr}" y1="${ys(v)}" y2="${ys(v)}" stroke="var(--line)"/><text x="${pl - 6}" y="${ys(v) + 4}" text-anchor="end" font-size="10.5" fill="var(--muted)" font-family="IBM Plex Mono,monospace">${f(v)}</text>`).join("");
}

export function priceChart(h: History, a: Analysis): string {
  const c = h.closes, n = c.length, W = 760, H = 300, pr = 12, pt = 12, pb = 26, fwd = 30;
  const { ys, ticks } = scaleY([...c, a.model.lo95, a.model.hi95], H, pt, pb);
  const pl = leftPad(ticks);
  const xs = (i: number) => pl + (i / (n - 1 + fwd)) * (W - pl - pr);
  const x0 = xs(n - 1), x1 = xs(n - 1 + fwd), py = ys(a.p);
  const cone = (l: number, u: number) => `M${x0} ${py} L${x1} ${ys(u)} L${x1} ${ys(l)} Z`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price over the last year with averages and a 30-day range cone">
    ${yAxis(ticks, ys, pl, W, pr, eurShort)}${monthTicks(h.dates, xs, H)}
    <path d="${cone(a.model.lo95, a.model.hi95)}" fill="var(--cone2)"/><path d="${cone(a.model.lo68, a.model.hi68)}" fill="var(--cone)"/>
    <line x1="${x0}" x2="${x0}" y1="${pt}" y2="${H - pb}" stroke="var(--line)" stroke-dasharray="3 3"/>
    <path d="${linePath(a.s200, xs, ys)}" fill="none" stroke="var(--c2)" stroke-width="1.5"/>
    <path d="${linePath(a.s50, xs, ys)}" fill="none" stroke="var(--c1)" stroke-width="1.5"/>
    <path d="${linePath(c, xs, ys)}" fill="none" stroke="var(--ink)" stroke-width="1.8" stroke-linejoin="round"/>
    <circle cx="${x0}" cy="${py}" r="3.5" fill="var(--accent)"/>
    <text x="${x1 - 2}" y="${pt + 10}" text-anchor="end" font-size="10.5" fill="var(--muted)">next 30 days</text></svg>`;
}

export function taChart(h: History, t: Technicals, show: Overlays): string {
  const c = h.closes, n = c.length, W = 760, H = 320, pr = 70, pt = 12, pb = 26;
  const { ys, ticks, lo, hi } = scaleY(taValues(h, t, show), H, pt, pb);
  const pl = leftPad(ticks);
  const xs = (i: number) => pl + i / (n - 1) * (W - pl - pr);
  const inR = (v: number) => v >= lo && v <= hi;
  let o = "";
  if (show.bb) {
    const up = t.bb.up, lw = t.bb.lo;
    const idx = up.map((v, i) => (v == null ? -1 : i)).filter(i => i >= 0);
    if (idx.length) {
      const d = "M" + idx.map(i => xs(i).toFixed(1) + " " + ys(up[i]!).toFixed(1)).join("L") + "L" + [...idx].reverse().map(i => xs(i).toFixed(1) + " " + ys(lw[i]!).toFixed(1)).join("L") + "Z";
      o += `<path d="${d}" fill="var(--band)"/><path d="${linePath(t.bb.mid, xs, ys)}" fill="none" stroke="var(--c1)" stroke-width="1" stroke-dasharray="3 3"/>`;
    }
  }
  if (show.fib) o += t.fibs.filter(f => inR(f.v)).map(f => `<line x1="${pl}" x2="${W - pr}" y1="${ys(f.v)}" y2="${ys(f.v)}" stroke="var(--c3)" stroke-dasharray="2 4"/><text x="${W - pr + 4}" y="${ys(f.v) + 4}" font-size="10" fill="var(--c3)">Fib ${(f.f * 100).toFixed(1)}%</text>`).join("");
  if (show.lv) {
    o += t.lv.sup.filter(l => inR(l.v)).map(l => `<line x1="${pl}" x2="${W - pr}" y1="${ys(l.v)}" y2="${ys(l.v)}" stroke="var(--good)" stroke-width="1.2" stroke-dasharray="6 3"/><text x="${W - pr + 4}" y="${ys(l.v) + 4}" font-size="10" fill="var(--good)">Support</text>`).join("");
    o += t.lv.res.filter(l => inR(l.v)).map(l => `<line x1="${pl}" x2="${W - pr}" y1="${ys(l.v)}" y2="${ys(l.v)}" stroke="var(--bad)" stroke-width="1.2" stroke-dasharray="6 3"/><text x="${W - pr + 4}" y="${ys(l.v) + 4}" font-size="10" fill="var(--bad)">Resistance</text>`).join("");
  }
  if (show.ema) {
    o += `<path d="${linePath(t.e20, xs, ys)}" fill="none" stroke="var(--c3)" stroke-width="1.3"/><path d="${linePath(t.e50, xs, ys)}" fill="none" stroke="var(--c1)" stroke-width="1.4"/>`;
    if (t.e200) o += `<path d="${linePath(t.e200, xs, ys)}" fill="none" stroke="var(--c2)" stroke-width="1.5"/>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price chart with technical overlays">${yAxis(ticks, ys, pl, W, pr, eurShort)}${monthTicks(h.dates, xs, H)}${o}
    <path d="${linePath(c, xs, ys)}" fill="none" stroke="var(--ink)" stroke-width="1.7" stroke-linejoin="round"/><circle cx="${xs(n - 1)}" cy="${ys(c[n - 1])}" r="3.5" fill="var(--accent)"/></svg>`;
}

export function subChart(kind: "rsi" | "macd", h: History, t: Technicals, a: Analysis, pl = 58): string {
  const n = h.closes.length, W = 760, H = 130, pr = 70, pt = 10, pb = 20;
  const xs = (i: number) => pl + i / (n - 1) * (W - pl - pr);
  if (kind === "rsi") {
    const ys = (v: number) => pt + (1 - v / 100) * (H - pt - pb);
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="RSI 14">
      <rect x="${pl}" y="${ys(70)}" width="${W - pl - pr}" height="${ys(30) - ys(70)}" fill="var(--band)"/>
      ${[30, 50, 70].map(v => `<line x1="${pl}" x2="${W - pr}" y1="${ys(v)}" y2="${ys(v)}" stroke="var(--line)"/><text x="${pl - 6}" y="${ys(v) + 4}" text-anchor="end" font-size="10.5" fill="var(--muted)" font-family="IBM Plex Mono,monospace">${v}</text>`).join("")}
      <path d="${linePath(a.rsi, xs, ys)}" fill="none" stroke="var(--c2)" stroke-width="1.5"/>
      <text x="${W - pr + 4}" y="${ys(a.R) + 4}" font-size="10.5" fill="var(--c2)">RSI ${a.R.toFixed(0)}</text></svg>`;
  }
  const m = t.md;
  const vals = [...m.m, ...m.sig, ...m.hist].filter((v): v is number => v != null && Number.isFinite(v));
  const mx = Math.max(...vals.map(Math.abs), 1e-12) * 1.1;
  const ys = (v: number) => pt + (1 - (v + mx) / (2 * mx)) * (H - pt - pb);
  const bw = (W - pl - pr) / n * 0.8;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="MACD">
    <line x1="${pl}" x2="${W - pr}" y1="${ys(0)}" y2="${ys(0)}" stroke="var(--line)"/><text x="${pl - 6}" y="${ys(0) + 4}" text-anchor="end" font-size="10.5" fill="var(--muted)">0</text>
    ${m.hist.map((v, i) => (v == null ? "" : `<rect x="${(xs(i) - bw / 2).toFixed(1)}" y="${Math.min(ys(v), ys(0)).toFixed(1)}" width="${bw.toFixed(2)}" height="${Math.abs(ys(v) - ys(0)).toFixed(1)}" fill="${v >= 0 ? "var(--good)" : "var(--bad)"}" opacity=".5"/>`)).join("")}
    <path d="${linePath(m.m, xs, ys)}" fill="none" stroke="var(--c1)" stroke-width="1.4"/><path d="${linePath(m.sig, xs, ys)}" fill="none" stroke="var(--accent)" stroke-width="1.2"/>
    <text x="${W - pr + 4}" y="${pt + 10}" font-size="10.5" fill="var(--muted)">MACD</text></svg>`;
}

/**
 * Value over time of several strategies. `dates` covers the whole chart; a series that starts later
 * gives `from`, its first index in `dates`. `base` is the starting money (the dashed line).
 */
export function equityChart(series: { eq: number[]; color: string; w?: number; from?: number; dash?: string; op?: number }[], dates: readonly string[], base = 1000): string {
  const W = 760, H = 240, pl = 52, pr = 12, pt = 10, pb = 24, n = dates.length;
  const all = series.flatMap(s => s.eq);
  let lo = Math.min(...all, base), hi = Math.max(...all, base);
  const pad = (hi - lo) * 0.08 || base * 0.05;
  lo -= pad; hi += pad;
  const xs = (i: number) => pl + i / Math.max(1, n - 1) * (W - pl - pr), ys = (v: number) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Value of €${base.toLocaleString("en-IE")} under each strategy">
    ${yAxis([0, 1, 2, 3].map(k => lo + (hi - lo) * k / 3), ys, pl, W, pr, v => "€" + Math.round(v))}
    <line x1="${pl}" x2="${W - pr}" y1="${ys(base)}" y2="${ys(base)}" stroke="var(--muted)" stroke-dasharray="4 4"/>
    <text x="${pl}" y="${H - 7}" font-size="10.5" fill="var(--muted)">${dates[0]}</text><text x="${W - pr}" y="${H - 7}" text-anchor="end" font-size="10.5" fill="var(--muted)">${dates[dates.length - 1]}</text>
    ${series.map(s => `<path d="${s.eq.map((v, i) => (i ? "L" : "M") + xs(i + (s.from ?? 0)).toFixed(1) + " " + ys(v).toFixed(1)).join("")}" fill="none" stroke="${s.color}" stroke-width="${s.w || 1.8}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}${s.op != null ? ` opacity="${s.op}"` : ""} stroke-linejoin="round"/>`).join("")}</svg>`;
}

/**
 * Growth of the starting money over years, on a logarithmic scale (equal distances are equal percentage
 * moves, so a 90% fall and a tenfold rise are the same size). `eq` values are multiples of the start (1 = the start).
 */
export function growthChart(series: { eq: number[]; color: string; w?: number; dash?: string }[], dates: readonly string[]): string {
  const W = 760, H = 300, pl = 52, pr = 12, pt = 10, pb = 24, n = dates.length;
  const all = series.flatMap(s => s.eq).filter(v => v > 0);
  const lo = Math.log10(Math.min(...all, 1)) - 0.05, hi = Math.log10(Math.max(...all, 1)) + 0.05;
  const xs = (i: number) => pl + i / Math.max(1, n - 1) * (W - pl - pr), ys = (v: number) => pt + (1 - (Math.log10(v) - lo) / (hi - lo)) * (H - pt - pb);
  const ticks: number[] = [];
  for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) for (const k of hi - lo > 2.5 ? [1] : [1, 2, 5]) { const v = k * 10 ** e; if (Math.log10(v) >= lo && Math.log10(v) <= hi) ticks.push(v); }
  const label = (v: number) => "×" + (v >= 1 ? String(Math.round(v)) : String(Number(v.toPrecision(1))));
  const years = dates.map((d, i) => (i > 0 && d.slice(0, 4) !== dates[i - 1].slice(0, 4) ? i : -1)).filter(i => i >= 0);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Growth of the starting money under each strategy, logarithmic scale">
    ${yAxis(ticks, ys, pl, W, pr, label)}
    ${years.map(i => `<line x1="${xs(i).toFixed(1)}" x2="${xs(i).toFixed(1)}" y1="${pt}" y2="${H - pb}" stroke="var(--line)"/><text x="${xs(i).toFixed(1)}" y="${H - 7}" text-anchor="middle" font-size="10.5" fill="var(--muted)">${dates[i].slice(0, 4)}</text>`).join("")}
    <line x1="${pl}" x2="${W - pr}" y1="${ys(1)}" y2="${ys(1)}" stroke="var(--muted)" stroke-dasharray="4 4"/>
    ${series.map(s => `<path d="${s.eq.map((v, i) => (i ? "L" : "M") + xs(i).toFixed(1) + " " + ys(Math.max(v, 1e-6)).toFixed(1)).join("")}" fill="none" stroke="${s.color}" stroke-width="${s.w || 1.6}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""} stroke-linejoin="round"/>`).join("")}</svg>`;
}
