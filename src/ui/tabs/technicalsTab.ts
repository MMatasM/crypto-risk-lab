import type { Analysis } from "../../analysis/scoring";
import type { Level, Sig, Technicals } from "../../analysis/technicals";
import type { History } from "../../data/types";
import { subChart, taChart, type Overlays } from "../charts";
import { cls, esc, eur, pc, pill } from "../format";

export function techTab(a: Analysis, h: History, t: Technicals, show: Overlays): string {
  const groups = ["Trend", "Momentum", "Volatility", "Volume", "Levels"];
  const tot = t.rows.length;
  const sig = (s: Sig) => (s === "bull" ? pill("good", "Bullish") : s === "bear" ? pill("bad", "Bearish") : pill("neutral", "Neutral"));
  const lvRow = (l: Level, k: string) => `<tr><td>${k}</td><td class="r num">${eur(l.v)}</td><td class="r num ${cls(l.v / a.p - 1)}">${pc(l.v / a.p - 1)}</td><td class="r num">${l.n}</td></tr>`;
  return `<div class="verdict v-${t.cons.k}"><div class="label">${tot} indicators</div><h3>${t.cons.t}</h3>
    <div class="tally" aria-hidden="true"><i style="flex:${t.bull};background:var(--good)"></i><i style="flex:${t.neu};background:var(--muted);opacity:.4"></i><i style="flex:${t.bear};background:var(--bad)"></i></div>
    <p class="num" style="font-size:.85rem">${t.bull} bullish · ${t.neu} neutral · ${t.bear} bearish</p></div>
  <div class="toggles" role="group" aria-label="Chart overlays">
    ${([["ema", "Moving averages"], ["bb", "Bollinger bands"], ["lv", "Support / resistance"], ["fib", "Fibonacci"]] as [keyof Overlays, string][]).map(([k, l]) => `<button type="button" data-ov="${k}" aria-pressed="${!!show[k]}">${l}</button>`).join("")}</div>
  <div class="chart">${taChart(h, t, show)}</div>
  <div class="legend"><span><i style="background:var(--ink)"></i>Price</span>${show.ema ? `<span><i style="background:var(--c3)"></i>EMA 20</span><span><i style="background:var(--c1)"></i>EMA 50</span>${t.e200 ? `<span><i style="background:var(--c2)"></i>EMA 200</span>` : ""}` : ""}${show.bb ? `<span><i style="background:var(--band);height:10px"></i>Bollinger (20, 2)</span>` : ""}</div>
  <div class="chart">${subChart("rsi", h, t, a)}</div>
  <div class="chart" style="margin-top:4px">${subChart("macd", h, t, a)}</div>
  <div class="legend"><span><i style="background:var(--c1)"></i>MACD (12, 26)</span><span><i style="background:var(--accent)"></i>Signal (9)</span><span><i style="background:var(--good);opacity:.5;height:8px"></i>Histogram</span></div>
  ${groups.map(g => {
    const rs = t.rows.filter(r => r.group === g);
    if (!rs.length) return "";
    return `<div class="section"><h3>${g}</h3><div class="tablewrap"><table>
    <tr><th>Indicator</th><th>Reading</th><th>Signal</th><th>What it means</th></tr>
    ${rs.map(r => `<tr><td><b>${r.name}</b></td><td class="num">${esc(r.state)}</td><td>${sig(r.sig)}</td><td class="muted">${r.why}</td></tr>`).join("")}</table></div></div>`;
  }).join("")}
  <div class="section"><h3>Key price levels</h3><div class="tablewrap"><table><tr><th>Level</th><th class="r">Price</th><th class="r">From now</th><th class="r">Touches</th></tr>
    ${t.lv.res.slice().reverse().map(l => lvRow(l, "Resistance")).join("")}<tr><td><b>Current price</b></td><td class="r num"><b>${eur(a.p)}</b></td><td></td><td></td></tr>${t.lv.sup.map(l => lvRow(l, "Support")).join("")}
    ${!t.lv.res.length ? `<tr><td colspan="4" class="muted">No resistance in the last year. Price is near or above its 1-year highs.</td></tr>` : ""}
    ${!t.lv.sup.length ? `<tr><td colspan="4" class="muted">No support in the last year. Price is near or below its 1-year lows.</td></tr>` : ""}</table></div>
  <p class="note">Levels come from swing highs and lows in the last year, grouped when within 3% of each other. More touches means more traders likely watch that price.</p></div>
  <div class="section"><h3>Fibonacci retracements, 1-year range</h3><div class="tablewrap"><table><tr><th>Level</th><th class="r">Price</th><th class="r">From now</th></tr>
    <tr><td>1-year high</td><td class="r num">${eur(t.hi1)}</td><td class="r num">${pc(t.hi1 / a.p - 1)}</td></tr>
    ${t.fibs.map(f => `<tr><td>${(f.f * 100).toFixed(1)}% retracement</td><td class="r num">${eur(f.v)}</td><td class="r num ${cls(f.v / a.p - 1)}">${pc(f.v / a.p - 1)}</td></tr>`).join("")}
    <tr><td>1-year low</td><td class="r num">${eur(t.lo1)}</td><td class="r num">${pc(t.lo1 / a.p - 1)}</td></tr></table></div>
  <p class="note">Based on daily closes, so wicks are not included. Indicators describe what price has been doing. They often contradict each other, and none of them knows the news.</p></div>`;
}
