import { clamp } from "../../analysis/math";
import type { Analysis } from "../../analysis/scoring";
import type { History } from "../../data/types";
import { priceChart } from "../charts";
import { big, cls, eur, pc, pcu } from "../format";

function meter(title: string, score: number, parts: [string, string][], goodHigh: boolean, note: string): string {
  const col = goodHigh
    ? (score >= 60 ? "var(--good)" : score >= 40 ? "var(--warn)" : "var(--bad)")
    : (score < 45 ? "var(--good)" : score < 70 ? "var(--warn)" : "var(--bad)");
  return `<div class="meter"><div class="row"><h3>${title}</h3><span class="num" style="font-size:1.2rem">${Math.round(score)}<span class="muted" style="font-size:.8rem">/100</span></span></div>
    <div class="bar"><i style="width:${clamp(score / 100) * 100}%;background:${col}"></i></div>
    <div class="parts">${parts.map(([k, v]) => `<div><span>${k}</span><span class="num">${v}</span></div>`).join("")}</div>
    <div class="note" style="margin-top:6px">${note}</div></div>`;
}

export function overview(a: Analysis, h: History): string {
  const tp = a.trendParts, rp = a.riskParts;
  return `<div class="verdict v-${a.cls.k}"><div class="label">Classification</div><h3>${a.cls.t}</h3><p>${a.cls.d}</p></div>
  <div class="meters">
    ${meter("Trend strength", a.trend, [["Above " + a.longN + "-day avg", tp.aboveLong.toFixed(0) + "/25"], ["50-day over " + a.longN + "-day", tp.cross.toFixed(0) + "/20"], ["90-day return", tp.ret90.toFixed(0) + "/25"], ["30-day return", tp.ret30.toFixed(0) + "/15"], ["Momentum (RSI)", tp.rsi.toFixed(0) + "/15"]], true, "Higher is a stronger uptrend.")}
    ${meter("Risk", a.risk, [["Volatility (40%)", rp.volatility.toFixed(0)], ["Worst drop in 1y (25%)", rp.drawdown.toFixed(0)], ["Small market cap (25%)", rp.size.toFixed(0)], ["Thin trading (10%)", rp.liquidity.toFixed(0)]], false, "Higher is riskier. Each factor scored 0–100.")}
    ${meter("Composite", a.composite, [["60% trend + 40% (100 − risk)", ""], ["Reward/risk, 30d history", a.rr == null ? "—" : a.rr.toFixed(2) + "×"]], true, "Reward/risk compares the best-10% 30-day gain with the worst-10% 30-day loss over the past year.")}
  </div>
  <div class="chart">${priceChart(h, a)}</div>
  <div class="legend"><span><i style="background:var(--ink)"></i>Price</span><span><i style="background:var(--c1)"></i>50-day avg</span><span><i style="background:var(--c2)"></i>${a.longN}-day avg</span><span><i style="background:var(--cone);height:10px"></i>Likely 30-day range (68%)</span><span><i style="background:var(--cone2);height:10px"></i>Wide range (95%)</span></div>
  <div class="grid">
    <div class="stat"><div class="label">Volatility</div><div class="v">${pcu(a.vol90)}</div><div class="n">Annualised, last 90 days</div></div>
    <div class="stat"><div class="label">From 1y high</div><div class="v ${cls(a.dd)}">${pc(a.dd)}</div><div class="n">High ${eur(a.high)}</div></div>
    <div class="stat"><div class="label">Worst drop in 1y</div><div class="v down">${pc(a.mdd)}</div><div class="n">Peak to trough</div></div>
    <div class="stat"><div class="label">Moves with BTC</div><div class="v">${a.corrBtc == null ? "—" : a.corrBtc.toFixed(2)}</div><div class="n">Correlation of daily moves, 90d</div></div>
    <div class="stat"><div class="label">Market cap</div><div class="v">${big(a.mcap)}</div><div class="n">24h volume ${big(a.v24)}</div></div>
  </div>`;
}
