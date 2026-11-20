/**
 * The Signals view: the nightly scan's ranked list with each coin's forecast, what changed since the scan
 * before, and how the forecasting model has actually done (walk-forward test and live record), stated plainly.
 */
import type { Tone } from "../analysis/scoring";
import { BASELINE_NAMES, MODEL_NAMES, verdictText, type HorizonReport, type ModelKey } from "../model/report";
import type { CoinForecast, HorizonForecast } from "../model/types";
import { SECTORS, type ScanCoin } from "../scan/types";
import { cls, esc, eur, pc, pcu, pill, stamp } from "./format";
import type { Actions, AppState, SigSort, SignalsData } from "./state";

const TIERS: [string, string][] = [["all", "All sizes"], ["mega", "Mega (€50B+)"], ["large", "Large (€10–50B)"], ["mid", "Mid (€1–10B)"], ["small", "Small (€100M–1B)"], ["micro", "Micro (<€100M)"]];
const RISKS: [string, string][] = [["all", "Any risk"], ["low", "Lower (under 45)"], ["mid", "Medium (45–70)"], ["high", "High (70+)"]];
const SORTS: [SigSort, string][] = [["rank", "Composite score"], ["p7", "7-day chance of a rise"], ["p30", "30-day chance of a rise"], ["risk", "Lowest risk"], ["trend", "Strongest trend"], ["ret7", "7-day change"], ["mcap", "Market cap"]];
const CHANGES_SHOWN = 8;

export const day = (d: string | null | undefined) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
const coinLogo = (c: ScanCoin) => (c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" width="20" height="20">` : "");
export const star = (id: string, on: boolean) => `<button class="star" type="button" data-track="${esc(id)}" aria-pressed="${on}" title="${on ? "Tracked: click to stop tracking" : "Track this coin"}">${on ? "★" : "☆"}<span class="sr">${on ? "Tracked" : "Track"}</span></button>`;

/** A chance of a rise, coloured only when it is clearly on one side, with the range it moves in under resampling. */
export function chance(f: HorizonForecast | undefined): string {
  if (!f) return `<span class="muted">—</span>`;
  const k = f.p >= 0.55 ? "up" : f.p <= 0.45 ? "down" : "";
  return `<span class="num ${k}">${pcu(f.p)}</span> <span class="num muted band">${(f.band[0] * 100).toFixed(0)}–${(f.band[1] * 100).toFixed(0)}</span>`;
}

/** How the model did against the baselines, in one honest block. Used on the Signals view and the Forecast tab. */
export function modelVerdict(d: SignalsData): string {
  const v = d.validation, primary: ModelKey = d.model?.primary ?? "logit";
  if (!v) return "";
  const r7 = v.horizons["7"], r30 = v.horizons["30"], verdict = r7.verdict[primary];
  const tone: Tone = verdict === "better" ? "good" : verdict === "worse" ? "bad" : "warn";
  const head = verdict === "better" ? "The 7-day forecast beat the simple baselines in testing"
    : verdict === "worse" ? "The forecast did worse than the simple baselines. Don't rely on it."
    : verdict === "same" ? "The forecast has not beaten the simple baselines"
    : "Too little history to say whether the forecast works";
  const nums = (r: HorizonReport) => r.n
    ? `${r.horizon}-day: right ${pcu(r[primary].accuracy, 1)} of the time, Brier score ${r[primary].brier.toFixed(3)} against ${Math.min(r.base.brier, r.momentum.brier, 0.25).toFixed(3)} for the best baseline (lower is better; a coin flip scores 0.250).`
    : `${r.horizon}-day: not tested yet.`;
  return `<div class="verdict v-${tone}"><div class="label">Forecasting model · walk-forward test on ${v.coins} coins, history from ${day(v.historyFrom)}</div>
    <h3>${head}</h3>
    <p>${esc(verdictText(r7, primary))} ${esc(nums(r7))}</p>
    <p>${r30.verdict[primary] === "unknown" ? `30-day forecasts: ${esc(verdictText(r30, primary).replace(/^Too little history to say: /, "too little history to say; "))}` : esc(verdictText(r30, primary)) + " " + esc(nums(r30))}</p>
    ${liveLine(d, primary)}
    <p>Treat every chance shown here as an experiment being scored in public, not as a signal to trade on.</p></div>`;
}

/** The live record in one sentence. */
function liveLine(d: SignalsData, primary: ModelKey): string {
  const t = d.track, r = t?.horizons["7"];
  if (!t?.since || !r) return "";
  return `<p><b>Live record</b> since ${day(t.since)}: ${r.n ? `${r.n.toLocaleString("en-IE")} seven-day forecasts scored so far, ${pcu(r[primary].accuracy, 1)} on the right side of 50% (always saying the commoner outcome: ${pcu(Math.max(r.upShare, 1 - r.upShare), 1)}).` : `no forecast is old enough to score yet; the first 7-day outcomes arrive on ${day(r.firstResolves)}.`}</p>`;
}

function scoreTable(r: HorizonReport, primary: ModelKey): string {
  const row = (name: string, s: { accuracy: number; brier: number; auc: number }, strong = false) => `<tr><td>${strong ? `<b>${esc(name)}</b>` : esc(name)}</td><td class="r num">${pcu(s.accuracy, 1)}</td><td class="r num">${s.brier.toFixed(4)}</td><td class="r num">${s.auc.toFixed(3)}</td></tr>`;
  const vs = (m: ModelKey) => { const c = r.versus[m][r.bestBaseline]; return c.lo == null || c.hi == null ? "too little history to say" : `${c.mean > 0 ? "+" : ""}${c.mean.toFixed(4)} (95% range ${c.lo.toFixed(4)} to ${c.hi.toFixed(4)}, ${c.blocks} independent periods)`; };
  if (!r.n) return `<p class="note">No ${r.horizon}-day forecasts have been scored yet.</p>`;
  return `<div class="tablewrap"><table><tr><th>${r.horizon}-day forecasts · ${r.n.toLocaleString("en-IE")} scored, ${day(r.from)} to ${day(r.to)}</th><th class="r">Right side of 50%</th><th class="r">Brier score</th><th class="r">AUC</th></tr>
    ${row(MODEL_NAMES.logit + (primary === "logit" ? " (shown in the app)" : ""), r.logit, primary === "logit")}${row(MODEL_NAMES.gbt + (primary === "gbt" ? " (shown in the app)" : ""), r.gbt, primary === "gbt")}
    ${row('Baseline: "always up" as a probability (the share of rises so far)', r.base)}${row("Baseline: simple momentum as a probability (the share of rises after an up, or down, month)", r.momentum)}
    <tr><td>Baseline: coin flip (always 50%)</td><td class="r num">50.0%</td><td class="r num">0.2500</td><td class="r num">0.500</td></tr></table></div>
    <p class="note">The price rose in ${pcu(r.upShare, 1)} of these cases, so always saying "up" was right ${pcu(r.alwaysUpAccuracy, 1)} of the time and "up if the last 30 days were up" ${pcu(r.momentumRuleAccuracy, 1)}.
      Best baseline by Brier score: ${esc(BASELINE_NAMES[r.bestBaseline].toLowerCase())}. Difference from it (negative = model better): ${esc(MODEL_NAMES.logit)} ${vs("logit")}; ${esc(MODEL_NAMES.gbt)} ${vs("gbt")}.
      Picking winners among coins (average daily rank correlation between forecast and outcome, 0 = none): ${r.rankSkill.logit.mean.toFixed(3)} and ${r.rankSkill.gbt.mean.toFixed(3)}.
      Return estimate: skill against "no change" ${r.ret.r2.toFixed(3)} (0 = no better); its 80% range held the outcome ${pcu(r.ret.coverage, 0)} of the time.</p>`;
}

function calibrationTable(r: HorizonReport, primary: ModelKey): string {
  const bins = r.calibration[primary];
  if (!bins.length) return "";
  return `<div class="tablewrap"><table style="max-width:520px"><tr><th>When the model said (${r.horizon}-day)</th><th class="r">Cases</th><th class="r">Average forecast</th><th class="r">Actually rose</th></tr>
    ${bins.map(b => `<tr><td class="num">${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}%</td><td class="r num">${b.n.toLocaleString("en-IE")}</td><td class="r num">${pcu(b.predicted, 0)}</td><td class="r num ${Math.abs(b.predicted - b.observed) > 0.1 ? "down" : ""}">${pcu(b.observed, 0)}</td></tr>`).join("")}</table></div>
    <p class="note">Calibration: a forecast you can take at face value has the last two columns roughly equal. Average gap here: ${(r.calibrationError[primary] * 100).toFixed(1)} percentage points.</p>`;
}

/** The full report behind the verdict: the walk-forward test and the live record. */
export function modelDetails(d: SignalsData): string {
  const v = d.validation, t = d.track, primary: ModelKey = d.model?.primary ?? "logit";
  if (!v) return "";
  const live = t ? (["7", "30"] as const).map(h => {
    const r = t.horizons[h];
    return r.n ? `<h4>Live, ${h}-day</h4>${scoreTable(r, primary)}<p class="note">${esc(verdictText(r, primary))} ${r.pending} more forecasts are waiting for their outcome.</p>`
      : `<p class="note"><b>${h}-day:</b> none scored yet. ${r.pending} forecasts are waiting; the first outcomes arrive on ${day(r.firstResolves)}.</p>`;
  }).join("") : "";
  return `<details class="more"><summary>How the model was tested, and its live record</summary>
    <div class="section"><h3>Live record</h3>
      <p class="note">${t?.since ? `Every night since ${day(t.since)} (${t.nights} night${t.nights === 1 ? "" : "s"} so far) the forecasts are written to a log that is never edited, and scored once the 7 or 30 days have passed. This is the record that matters: it can't have been fitted to the past.` : "The forecasts are logged every night and scored once their 7 or 30 days have passed."}</p>${live}</div>
    <div class="section"><h3>Walk-forward test on past data</h3>
      <p class="note">For each week in the past, the models were trained only on outcomes already known before that week (with a gap of the full 7 or 30 days, so no training outcome overlaps the week being forecast), then scored on that week. ${v.horizons["7"].folds} weekly steps for 7-day forecasts, ${v.horizons["30"].folds} for 30-day. Settings were fixed in advance and not tuned to these results.</p>
      ${d.model?.primaryNote ? `<p class="note"><b>Which model the app shows:</b> ${esc(MODEL_NAMES[primary])}. ${esc(d.model.primaryNote)}</p>` : ""}
      ${scoreTable(v.horizons["7"], primary)}${calibrationTable(v.horizons["7"], primary)}
      ${scoreTable(v.horizons["30"], primary)}${calibrationTable(v.horizons["30"], primary)}</div>
    <div class="section"><h3>Why to stay sceptical</h3>
      <ul class="note"><li>One year of history is one market phase. Coins move together, so thousands of rows amount to a few dozen independent weeks; the "95% range" above counts them that way.</li>
      <li>The test uses today's top coins. Coins that collapsed and left the list are missing, which flatters every number here, baselines included. The live record doesn't have this problem.</li>
      <li>Accuracy near 50% with a Brier score near 0.25 means no better than a coin flip, however confident a single number looks.</li>
      <li>Inputs are prices and volumes only. The model knows nothing about news, listings, hacks or regulation.</li></ul></div></details>`;
}

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const riskBand = (r: number) => (r < 45 ? "low" : r < 70 ? "mid" : "high");
const riskTone = (r: number): Tone => (r < 45 ? "good" : r < 70 ? "warn" : "bad");

export function renderSignals(st: AppState, act: Actions) {
  const el = document.getElementById("signals")!;
  const sv = st.signals, d = sv.data;
  const head = (sub: string) => `<div class="disc-head"><div><h2>Signals${sv.stale && sv.at ? ` <span class="offline">Offline copy from ${stamp(sv.at)}</span>` : ""}</h2><div class="note">${sub}</div></div></div>`;
  const err = sv.err ? `<div class="err">${esc(sv.err)}</div>` : "";
  if (!d?.scan) {
    el.innerHTML = head("The nightly scan of the top coins, with each coin's forecast.") + err + `<div class="empty">${sv.loading ? "Loading the nightly scan…" : "No scan results yet. The nightly run on GitHub creates them."}</div>`;
    return;
  }
  const scan = d.scan, fc = new Map<string, CoinForecast>((d.model?.date === scan.date ? d.model.coins : []).map(c => [c.id, c]));
  const tracked = new Set(st.tracked), isTracked = (c: ScanCoin) => tracked.has(c.id);
  const unproven = !!d.model && d.validation?.horizons["7"].verdict[d.model.primary] !== "better";

  let rows = scan.coins.slice();
  if (sv.tier !== "all") rows = rows.filter(c => c.tier === sv.tier);
  if (sv.sector) rows = rows.filter(c => c.sectors.includes(sv.sector));
  if (sv.risk !== "all") rows = rows.filter(c => riskBand(c.risk) === sv.risk);
  if (sv.trackedOnly) rows = rows.filter(isTracked);
  const p = (c: ScanCoin, h: "h7" | "h30") => fc.get(c.id)?.[h]?.p ?? -1;
  const sorters: Record<SigSort, (a: ScanCoin, b: ScanCoin) => number> = {
    rank: (a, b) => a.rank - b.rank, p7: (a, b) => p(b, "h7") - p(a, "h7"), p30: (a, b) => p(b, "h30") - p(a, "h30"),
    risk: (a, b) => a.risk - b.risk, trend: (a, b) => b.trend - a.trend, ret7: (a, b) => (b.ret7 ?? -9) - (a.ret7 ?? -9), mcap: (a, b) => (b.mcap ?? 0) - (a.mcap ?? 0),
  };
  rows.sort(sorters[sv.sort]);

  // What changed: tracked coins first (the file marks the nightly watchlist; this device's tracked coins count too).
  const changes = scan.changes.slice().sort((a, b) => Number(tracked.has(b.id) || b.watch) - Number(tracked.has(a.id) || a.watch));
  const shown = sv.allChanges ? changes : changes.slice(0, CHANGES_SHOWN);
  const changesHtml = `<div class="section"><h3>What changed since ${scan.previousDate ? day(scan.previousDate) : "the scan before"}</h3>
    ${!scan.previousDate ? `<p class="note">This is the first scan, so there is nothing to compare it with yet${changes.length ? "; unusual one-day moves are listed" : ""}.</p>` : ""}
    ${changes.length ? `<ul class="changes">${shown.map(c => `<li class="${tracked.has(c.id) || c.watch ? "on" : ""}"><span class="dotk k-${c.k}"></span><button class="rm" type="button" data-open="${esc(c.id)}" style="text-decoration:none;color:var(--ink);font-size:inherit"><b>${esc(c.name)}</b></button> <span class="muted">${esc(c.text)}</span></li>`).join("")}</ul>
      ${changes.length > shown.length ? `<button class="btn sm" type="button" id="s-more">Show all ${changes.length} changes</button>` : ""}` : scan.previousDate ? `<p class="note">Nothing notable changed.</p>` : ""}</div>`;

  const untracked = st.tracked.filter(id => !scan.coins.some(c => c.id === id));
  const notScanned = untracked.length ? `<p class="note" style="margin-top:8px">Tracked on this device but not in the nightly scan: ${untracked.map(esc).join(", ")}. The scan covers the top ${d.config?.topN ?? 150} coins plus the watchlist in <span class="num">public/data/scan/config.json</span>; add ${untracked.length === 1 ? "it" : "them"} there to have ${untracked.length === 1 ? "it" : "them"} scanned every night.</p>` : "";

  const chips = (id: string, list: [string, string][], cur: string, attr: string) => `<div class="chipbar" id="${id}">${list.map(([k, t]) => `<button type="button" data-${attr}="${k}" aria-pressed="${cur === k}">${t}</button>`).join("")}</div>`;
  const table = `<div class="tablewrap"><table class="sig"><tr><th></th><th>#</th><th>Coin</th><th class="r" title="Composite score: 60% trend, 40% low risk">Score</th><th class="r">Risk</th>
      <th class="r" title="The model's chance that the price is higher 7 days later, and the range it moves in when the model is refitted on resampled history">Up in 7d</th><th class="r" title="The same for 30 days">Up in 30d</th>
      <th>Class</th><th>Technicals</th><th class="r">Price</th><th class="r">7d</th><th class="r">30d</th><th class="r" title="The model's middle estimate of the 7-day return and a range that held 80% of the time in training">7-day estimate</th></tr>
    ${rows.map(c => {
      const f = fc.get(c.id);
      return `<tr class="${isTracked(c) ? "tracked" : ""}"><td>${star(c.id, isTracked(c))}</td><td class="num muted">${c.rank}</td>
      <td style="white-space:nowrap"><button class="rm" type="button" style="text-decoration:none;color:var(--ink)" data-open="${esc(c.id)}"><span class="coinname">${coinLogo(c)}<b>${esc(c.name)}</b> <span class="muted">${esc(c.symbol.toUpperCase())}</span></span></button></td>
      <td class="r num"><b>${c.composite.toFixed(0)}</b></td><td class="r">${pill(riskTone(c.risk), c.risk.toFixed(0), false)}</td>
      <td class="r" style="white-space:nowrap">${chance(f?.h7)}</td><td class="r" style="white-space:nowrap">${chance(f?.h30)}</td>
      <td>${pill(c.cls.k, c.cls.t)}</td><td>${pill(c.cons.k, capital(c.cons.t))}</td>
      <td class="r num">${eur(c.price)}</td><td class="r num ${cls(c.ret7)}">${pc(c.ret7)}</td><td class="r num ${cls(c.ret30)}">${pc(c.ret30)}</td>
      <td class="r num" style="white-space:nowrap">${f?.h7 ? `<span class="${cls(f.h7.ret[1])}">${pc(f.h7.ret[1])}</span> <span class="muted band">${pc(f.h7.ret[0], 0)} to ${pc(f.h7.ret[2], 0)}</span>` : `<span class="muted">—</span>`}</td></tr>`;
    }).join("")}
    ${!rows.length ? `<tr><td colspan="13" class="muted">No coins match these filters.</td></tr>` : ""}</table></div>`;

  el.innerHTML = head(`The nightly scan: ${scan.coins.length} coins from the closes of ${day(scan.date)}, ranked by composite score (60% trend, 40% low risk), each with the model's forecast. Updated every night by a job on GitHub.`) + err
    + modelVerdict(d) + modelDetails(d) + changesHtml
    + `<div class="section"><div class="disc-head" style="margin-bottom:6px"><h3>The ranked list</h3>
      <div class="controls" style="margin:0"><label for="s-sort">Sort by<select id="s-sort">${SORTS.map(([k, t]) => `<option value="${k}" ${sv.sort === k ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label for="s-tracked" style="flex-direction:row;align-items:center;gap:6px;padding-bottom:8px"><input id="s-tracked" type="checkbox" ${sv.trackedOnly ? "checked" : ""}>Tracked only (${st.tracked.length})</label></div></div>
      <div class="label" style="margin-bottom:6px">Size tier</div>${chips("s-tier", TIERS, sv.tier, "tier")}
      <div class="label" style="margin-bottom:6px">Sector</div>${chips("s-sec", [["", "All sectors"], ...SECTORS], sv.sector, "sec")}
      <div class="label" style="margin-bottom:6px">Risk score</div>${chips("s-risk", RISKS, sv.risk, "risk")}
      <p class="note" style="margin:0 0 6px">"Up in 7d" and "Up in 30d" are the model's chance that the price is higher by then, followed in grey by the range that chance moves in.${unproven ? " <b>Unproven:</b> see the verdict at the top." : ""} Click a coin for its forecast page.</p>
      ${table}${notScanned}</div>
    <p class="note" style="margin-top:12px">★ tracks a coin on this device: it joins your watchlist and is highlighted here. The grey numbers after a chance are the range it moves in when the model is refitted on resampled history (10th to 90th percentile); the range after the 7-day estimate held the outcome 80% of the time in training.${scan.skipped.length ? ` Not scanned tonight: ${scan.skipped.slice(0, 6).map(s => esc(s.name)).join(", ")}${scan.skipped.length > 6 ? ` and ${scan.skipped.length - 6} more` : ""}.` : ""} Nothing here is advice.${sv.at && !sv.stale ? ` Loaded ${stamp(sv.at)}.` : ""}</p>`;

  const more = el.querySelector<HTMLDetailsElement>("details.more");
  if (more) { more.open = sv.details; more.ontoggle = () => act.setSignals({ details: more.open }, true); }
  el.querySelectorAll<HTMLButtonElement>("[data-tier]").forEach(b => (b.onclick = () => act.setSignals({ tier: b.dataset.tier! })));
  el.querySelectorAll<HTMLButtonElement>("[data-sec]").forEach(b => (b.onclick = () => act.setSignals({ sector: b.dataset.sec! })));
  el.querySelectorAll<HTMLButtonElement>("[data-risk]").forEach(b => (b.onclick = () => act.setSignals({ risk: b.dataset.risk as "all" | "low" | "mid" | "high" })));
  el.querySelector<HTMLSelectElement>("#s-sort")!.onchange = e => act.setSignals({ sort: (e.target as HTMLSelectElement).value as SigSort });
  el.querySelector<HTMLInputElement>("#s-tracked")!.onchange = e => act.setSignals({ trackedOnly: (e.target as HTMLInputElement).checked });
  el.querySelector<HTMLButtonElement>("#s-more")?.addEventListener("click", () => act.setSignals({ allChanges: true }));
  el.querySelectorAll<HTMLButtonElement>("[data-track]").forEach(b => (b.onclick = () => act.toggleTrack(b.dataset.track!)));
  el.querySelectorAll<HTMLButtonElement>("[data-open]").forEach(b => (b.onclick = () => act.openCoin(b.dataset.open!, "forecast")));
}
