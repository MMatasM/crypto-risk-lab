import type { Analysis } from "../../analysis/scoring";
import { cls, eur, pc, pcu } from "../format";

export function ranges(a: Analysis): string {
  const md = a.model, e = a.emp;
  return `<p class="note" style="margin-top:0">Ranges, not targets. The first table assumes moves stay as volatile as the last 90 days, with no up or down bias. The second shows what actually happened in every 30-day window of the past year.</p>
  <div class="section"><h3>If volatility stays like the last 90 days</h3><div class="tablewrap"><table>
    <tr><th>Range</th><th class="r">Low</th><th class="r">High</th><th class="r">Move</th></tr>
    <tr><td>Likely (68% of the time)</td><td class="r num">${eur(md.lo68)}</td><td class="r num">${eur(md.hi68)}</td><td class="r num">${pc(md.lo68 / a.p - 1)} / ${pc(md.hi68 / a.p - 1)}</td></tr>
    <tr><td>Wide (95% of the time)</td><td class="r num">${eur(md.lo95)}</td><td class="r num">${eur(md.hi95)}</td><td class="r num">${pc(md.lo95 / a.p - 1)} / ${pc(md.hi95 / a.p - 1)}</td></tr></table></div>
  <div class="grid" style="margin-top:12px">
    <div class="stat"><div class="label">Chance of a 20%+ drop</div><div class="v down">${pcu(md.pDrop20)}</div><div class="n">Within 30 days, volatility model</div></div>
    <div class="stat"><div class="label">Chance of a 20%+ rise</div><div class="v up">${pcu(md.pRise20)}</div><div class="n">Within 30 days, volatility model</div></div></div></div>
  ${e ? `<div class="section"><h3>What 30-day windows did over the past year</h3><div class="tablewrap"><table>
    <tr><th>Outcome</th><th class="r">30-day return</th><th class="r">Price if repeated now</th></tr>
    ${([["Worst 5%", e.p5], ["Bad (25th percentile)", e.p25], ["Typical (median)", e.p50], ["Good (75th percentile)", e.p75], ["Best 5%", e.p95]] as [string, number][]).map(([k, v]) => `<tr><td>${k}</td><td class="r num ${cls(v)}">${pc(v)}</td><td class="r num">${eur(a.p * (1 + v))}</td></tr>`).join("")}</table></div>
  <p class="note">In the past year, ${pcu(e.share20down)} of 30-day windows fell 20% or more and ${pcu(e.share20up)} rose 20% or more.</p></div>` : ""}`;
}
