import type { Analysis } from "../../analysis/scoring";
import type { Technicals } from "../../analysis/technicals";
import type { MarketCoin } from "../../data/types";
import { cls, eur, monthName, pc } from "../format";

function cycleText(m: MarketCoin | undefined, t: Technicals): string {
  const ath = m?.ath_change_percentage != null ? m.ath_change_percentage / 100 : null;
  const parts: string[] = [];
  const below = (x: number) => pc(-x, 0).replace("+", "");
  if (ath != null) {
    if (ath > -0.1) parts.push("It's trading near its all-time high, which usually means strong demand but little historical resistance to guide you.");
    else if (ath > -0.5) parts.push(`It's ${below(ath)} below its all-time high, a normal pullback range for crypto.`);
    else if (ath > -0.85) parts.push(`It's ${below(ath)} below its all-time high. Deep, but many coins have recovered from this range in past cycles.`);
    else parts.push(`It's more than 85% below its all-time high. Coins this far down often never return, so treat any rebound as speculative.`);
  }
  parts.push(`Within the last year it sits at ${(t.pos * 100).toFixed(0)}% of its range, with ${t.structure.toLowerCase()}.`);
  return parts.join(" ");
}

export function historyTab(a: Analysis, m: MarketCoin | undefined, t: Technicals): string {
  const ms = t.months;
  const mx = Math.max(...ms.map(x => Math.abs(x.r)), 0.01);
  const bg = (r: number) => { const o = 0.15 + 0.6 * Math.min(1, Math.abs(r) / mx); return r >= 0 ? `rgba(23,128,61,${o.toFixed(2)})` : `rgba(180,35,24,${o.toFixed(2)})`; };
  const up = ms.filter(x => x.r > 0).length;
  const athDays = m?.ath_date ? Math.round((Date.now() - new Date(m.ath_date).getTime()) / 864e5) : null;
  const athPct = m?.ath_change_percentage;
  const atlPct = m?.atl_change_percentage;
  return `<div class="grid">
    <div class="stat"><div class="label">All-time high</div><div class="v">${eur(m?.ath)}</div><div class="n">${m?.ath_date ? new Date(m.ath_date).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" }) + " · " + athDays + " days ago" : "—"}</div></div>
    <div class="stat"><div class="label">Below all-time high</div><div class="v ${cls(athPct)}">${athPct != null ? pc(athPct / 100) : "—"}</div><div class="n">Needs ${athPct != null && athPct > -100 ? pc(1 / (1 + athPct / 100) - 1, 0) : "—"} to get back</div></div>
    <div class="stat"><div class="label">All-time low</div><div class="v">${eur(m?.atl)}</div><div class="n">${m?.atl_date ? new Date(m.atl_date).getFullYear() + " · " : ""}now ${atlPct != null ? pc(atlPct / 100, 0) : "—"} above</div></div>
    <div class="stat"><div class="label">1-year return</div><div class="v ${cls(a.retAll)}">${pc(a.retAll)}</div><div class="n">${up} of ${ms.length} months up</div></div>
  </div>
  <div class="section"><h3>Month by month</h3><div class="months">
    ${ms.map(x => `<div class="month" style="background:${bg(x.r)}"><div class="m">${monthName(x.m, true)}${x.partialEnd ? " (so far)" : x.partialStart ? " (part)" : ""}</div><div class="num" style="font-weight:600">${pc(x.r)}</div></div>`).join("")}</div>
  <p class="note">The free data gives one year of daily prices, so this shows one cycle phase. All-time high and low come from CoinGecko's full history.</p></div>
  <div class="section"><h3>Where it sits in its cycle</h3><p class="note" style="margin-top:0">${cycleText(m, t)}</p></div>`;
}
