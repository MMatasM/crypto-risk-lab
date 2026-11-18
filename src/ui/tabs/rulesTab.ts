import type { Analysis, Tone } from "../../analysis/scoring";
import { pc, pcu, pill } from "../format";

export function signals(a: Analysis): string {
  const rows: [string, string, Tone, string][] = [
    ["Trend filter", a.up === null ? "—" : a.up ? `Above ${a.longN}-day average` : `Below ${a.longN}-day average`, a.up === null ? "neutral" : a.up ? "good" : "bad", "Trend-following rules hold only when price is above its long average."],
    ["Average crossover", a.lastCross ? `50-day crossed ${a.lastCross.golden ? "above" : "below"} ${a.longN}-day, ${a.lastCross.days} days ago` : "No crossover in the data", a.lastCross ? (a.lastCross.golden ? "good" : "bad") : "neutral", "Slow but filters noise. Often late at turning points."],
    ["Momentum (RSI 14)", a.R.toFixed(0) + (a.R > 70 ? ", overbought" : a.R < 30 ? ", oversold" : ", normal"), a.R > 70 || a.R < 30 ? "warn" : "good", "Extremes tend to snap back short-term."],
    ["Distance from 1y high", pc(a.dd), a.dd < -0.5 ? "bad" : a.dd < -0.25 ? "warn" : "good", "A deep discount can be a bargain or a broken coin. The trend filter decides which."],
    ["Volatility regime", `${pcu(a.vol30)} now vs ${pcu(a.volAll)} 1y`, a.vol30 > a.volAll * 1.5 ? "warn" : "good", "Spikes come with big moves both ways. Smaller positions."],
  ];
  return `<div class="verdict v-${a.lean.k}"><div class="label">What the rules say today</div><h3>${a.lean.t}</h3><p>${a.lean.d}</p></div>
  <div class="tablewrap"><table><tr><th>Rule</th><th>State now</th><th>How to read it</th></tr>
  ${rows.map(([k, s, c, d]) => `<tr><td><b>${k}</b></td><td>${pill(c, s)}</td><td class="muted">${d}</td></tr>`).join("")}</table></div>
  <p class="note">These rules are public and simple on purpose. Check them in the Backtest tab before trusting any of them with money.</p>`;
}
