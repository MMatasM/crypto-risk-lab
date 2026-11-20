/** The coin page's Forecast tab: tonight's chances, what drove them, and how the model has done on this coin. */
import { FEATURES } from "../../model/features";
import { MODEL_NAMES, type ModelKey } from "../../model/report";
import type { HorizonForecast } from "../../model/types";
import { esc, pc, pcu, pill } from "../format";
import { day, modelDetails, modelVerdict } from "../signals";
import type { SignalsData, SignalsViewState } from "../state";

function card(h: 7 | 30, f: HorizonForecast, primary: ModelKey): string {
  const other: ModelKey = primary === "logit" ? "gbt" : "logit";
  const x = (v: number) => (Math.min(1, Math.max(0, v)) * 100).toFixed(1);
  return `<div class="meter"><div class="row"><h3>${h} days</h3><span class="num" style="font-size:1.5rem">${pcu(f.p)}</span></div>
    <div class="gauge" role="img" aria-label="Chance of a rise ${pcu(f.p)}, range ${pcu(f.band[0])} to ${pcu(f.band[1])}">
      <i class="range" style="left:${x(f.band[0])}%;width:${(Math.max(0.01, f.band[1] - f.band[0]) * 100).toFixed(1)}%"></i><i class="half"></i><i class="dot" style="left:${x(f.p)}%"></i></div>
    <div class="parts">
      <div><span>Chance the price is higher in ${h} days</span><span class="num">${pcu(f.p)}</span></div>
      ${f.was != null ? `<div><span>The night before</span><span class="num">${pcu(f.was)}</span></div>` : ""}
      <div><span>Range when the model is refitted on resampled history</span><span class="num">${pcu(f.band[0])} to ${pcu(f.band[1])}</span></div>
      <div><span>${MODEL_NAMES[other]} (the second model) says</span><span class="num">${pcu(f[other])}</span></div>
      <div><span>Middle estimate of the ${h}-day return</span><span class="num">${pc(f.ret[1])}</span></div>
      <div><span>Range that held 80% of the time in training</span><span class="num">${pc(f.ret[0], 0)} to ${pc(f.ret[2], 0)}</span></div>
    </div></div>`;
}

function driversTable(f: HorizonForecast, h: number): string {
  const biggest = Math.max(...f.why.map(w => Math.abs(w[1])), 1e-9);
  return `<div class="tablewrap"><table><tr><th>What moved the ${h}-day forecast most</th><th>Direction</th><th>Strength</th></tr>
    ${f.why.map(([i, c]) => `<tr><td>${esc(FEATURES[i]?.name ?? "Input " + i)}</td><td>${Math.abs(c) < 0.005 ? pill("neutral", "No effect") : c > 0 ? pill("good", "Raises the chance") : pill("bad", "Lowers the chance")}</td>
      <td style="min-width:120px"><div class="bar" style="margin:0"><i style="width:${(Math.abs(c) / biggest * 100).toFixed(0)}%;background:${c > 0 ? "var(--good)" : "var(--bad)"}"></i></div></td></tr>`).join("")}</table></div>`;
}

export function forecastTab(id: string, name: string, sv: SignalsViewState): string {
  const d: SignalsData | null = sv.data;
  if (!d?.model) return `<div class="empty">${sv.loading ? "Loading tonight's forecasts…" : sv.err ? esc(sv.err) : "No forecasts yet. The nightly run on GitHub creates them."}</div>`;
  const f = d.model.coins.find(c => c.id === id), primary = d.model.primary, scan = d.scan?.coins.find(c => c.id === id);
  if (!f) {
    return modelVerdict(d) + `<div class="empty">${esc(name)} has no forecast: it isn't in the nightly scan, or has less than 100 days of price history there.<br><br>
      The scan covers the top ${d.config?.topN ?? 150} coins by market cap plus the watchlist in <span class="num">public/data/scan/config.json</span>. Add <span class="num">"${esc(id)}"</span> to that watchlist to have it scanned and forecast every night.</div>`;
  }
  const past = (["7", "30"] as const).map(h => {
    const wf = d.validation?.horizons[h].byCoin[id], live = d.track?.horizons[h].byCoin[id];
    const cell = (v: [number, number, number, number] | undefined, i: number) => (v ? pcu(v[i], 0) : "—");
    return `<tr><td style="white-space:nowrap">${h}-day, walk-forward test</td><td class="r num">${wf ? wf[0] : 0}</td><td class="r num">${cell(wf, primary === "logit" ? 1 : 2)}</td><td class="r num">${cell(wf, primary === "logit" ? 2 : 1)}</td><td class="r num">${wf ? pcu(Math.max(wf[3], 1 - wf[3]), 0) : "—"}</td></tr>
      <tr><td style="white-space:nowrap">${h}-day, live since ${day(d.track?.since)}</td><td class="r num">${live ? live[0] : 0}</td><td class="r num">${cell(live, primary === "logit" ? 1 : 2)}</td><td class="r num">${cell(live, primary === "logit" ? 2 : 1)}</td><td class="r num">${live ? pcu(Math.max(live[3], 1 - live[3]), 0) : "—"}</td></tr>`;
  }).join("");
  return modelVerdict(d)
    + `<p class="note" style="margin:0 0 10px">Forecast made from the close of ${day(d.model.date)} by ${MODEL_NAMES[primary].toLowerCase()}, retrained every night on every outcome known so far.${scan ? ` In tonight's scan ${esc(name)} ranks ${scan.rank} of ${d.scan!.coins.length} on composite score.` : ""}</p>
    <div class="meters">${card(7, f.h7, primary)}${card(30, f.h30, primary)}</div>
    <div class="section"><h3>What drove it</h3>${driversTable(f.h7, 7)}<div style="height:10px"></div>${driversTable(f.h30, 30)}
      <p class="note">Each row is one of the model's ${FEATURES.length} inputs: how far this coin's value is from the average coin-day, times the weight the model gives that input. It describes the model's arithmetic, not a cause in the market.</p></div>
    <div class="section"><h3>How the model has done on ${esc(name)}</h3>
      <div class="tablewrap"><table><tr><th>Forecasts</th><th class="r">Scored</th><th class="r">${MODEL_NAMES[primary]} right</th><th class="r">${MODEL_NAMES[primary === "logit" ? "gbt" : "logit"]} right</th><th class="r">Always guessing the commoner outcome</th></tr>${past}</table></div>
      <p class="note">"Right" means the forecast was on the correct side of 50%. Forecasts a day apart share most of their 7 or 30 days, so a hundred of them are worth far fewer independent tries; one coin's record is mostly noise. The last column is what you would score by always saying whichever of up or down turned out more common, knowing it in advance.</p></div>
    ${modelDetails(d)}`;
}
