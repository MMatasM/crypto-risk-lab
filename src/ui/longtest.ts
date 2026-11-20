/**
 * The long-term test, shown under Signals: the forecasting models and the paper-trading strategies on seven
 * years of Bitvavo history, per market phase, with the failures in plain sight. Everything shown is read
 * from public/data/longtest/report.json (written by `npm run longtest`); the words follow the numbers, so
 * a new run can't leave an old conclusion standing.
 */
import type { Tone } from "../analysis/scoring";
import type { Verdict } from "../model/metrics";
import { MODEL_NAMES, type BaselineKey, type ModelKey } from "../model/report";
import type { Boot, PhaseReport } from "../research/phases";
import type { LongTestFile, StrategyRow } from "../research/types";
import { growthChart } from "./charts";
import { cls, esc, pc, pcu, pill } from "./format";

const day = (d: string | null | undefined) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
const num = (n: number) => n.toLocaleString("en-IE");
const signed = (v: number, d = 4) => (v > 0 ? "+" : "") + v.toFixed(d);
const range = (b: Boot, d = 4) => (b.lo == null || b.hi == null ? "too few weeks" : `${signed(b.lo, d)} to ${signed(b.hi, d)}`);
/** Percentage points from a log-return gap (0.0033 -> "+0.33"). */
const points = (v: number | null) => (v == null ? "?" : signed(v * 100, 2));
const other = (m: ModelKey): ModelKey => (m === "gbt" ? "logit" : "gbt");
/** The nightly test calls the first baseline "always up"; over years in which most coins fell it mostly says "down", so here it gets its plain name. */
const BASELINE: Record<BaselineKey, string> = { base: "Base rate", momentum: "Momentum", flip: "Coin flip" };
const BASELINE_LONG: Record<BaselineKey, string> = { base: "the base rate (how often prices had risen so far)", momentum: "simple momentum (how often they had risen after an up, or down, month)", flip: "a coin flip" };
const VERDICT: Record<Verdict, [Tone, string]> = { better: ["good", "Beat it"], worse: ["bad", "Worse"], same: ["neutral", "No difference"], unknown: ["neutral", "Too short"] };
const verdictPill = (v: Verdict) => pill(VERDICT[v][0], VERDICT[v][1], false);
/** A big return reads better as a multiple (+1,540% is ×16.4). */
const ret = (v: number | null) => (v == null ? `<span class="muted">—</span>` : `<span class="${cls(v)}">${Math.abs(v) >= 10 ? "×" + (1 + v).toFixed(1) : pc(v, 0)}</span>`);
const tally = (list: PhaseReport[], m: ModelKey) => ({ better: list.filter(p => p[m].verdict === "better"), worse: list.filter(p => p[m].verdict === "worse"), same: list.filter(p => p[m].verdict === "same"), n: list.length });
const names = (list: PhaseReport[]) => list.map(p => p.label).join(", ");
const spanYears = (from: string | null, to: string | null) => (from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 864e5 / 365.25) : 0);

const rowBy = (rows: StrategyRow[], key: string) => rows.find(r => r.key === key);
/** The calendar years in which row `a` ended behind row `b`. */
const behind = (a: StrategyRow, b: StrategyRow, years: number[]) => years.filter((_, i) => a.years[i] != null && b.years[i] != null && (a.years[i] as number) < (b.years[i] as number));
/** Whether a strategy's edge over its benchmark is more than luck: only when the whole 95% range is on one side of zero. */
const edgeSure = (b: Boot | null) => (b?.lo == null || b.hi == null ? 0 : b.lo > 0 ? 1 : b.hi < 0 ? -1 : 0);
const edgeCell = (b: Boot | null) => (b == null ? `<span class="muted">—</span>`
  : `<span class="${edgeSure(b) > 0 ? "up" : edgeSure(b) < 0 ? "down" : ""}">${pc(b.mean, 0)}</span> <span class="muted band">${b.lo == null || b.hi == null ? "" : `${pc(b.lo, 0)} to ${pc(b.hi, 0)}`}</span>`);
/** What a full switch of a position costs, in percentage points: sell one coin, buy another. */
const roundTrip = (lt: LongTestFile) => 2 * (lt.strategies.fee + lt.strategies.slippage) * 100;

/** One sentence on whether the model's ranking of coins is worth anything after costs. */
function rankingLine(lt: LongTestFile, hz: "7" | "30", m: ModelKey): string {
  const p = lt.horizons[hz].overall[m], sure = p.top.lo != null && p.top.lo > 0;
  return `The fifth of coins it rated highest did ${Math.abs(p.top.mean * 100).toFixed(2)} percentage points ${p.top.mean >= 0 ? "better" : "worse"} over the next ${hz} days than the average coin (95% range ${points(p.top.lo)} to ${points(p.top.hi)}${sure ? "" : ", which includes zero"}).`
    + (hz === "7" ? ` Switching coins every week costs about ${roundTrip(lt).toFixed(2)} points in fee and slippage${sure && p.top.mean * 100 < roundTrip(lt) ? ", more than that gain" : ""}.` : "");
}

/** The strategies that grew faster than their benchmark by more than luck would explain (usually none). */
function provenEdges(lt: LongTestFile): string {
  const s = lt.strategies, all = [...s.market.rows, ...s.portfolio.rows].filter(r => r.edge != null);
  const won = all.filter(r => edgeSure(r.edge) > 0 && edgeSure(r.edgeBtc) > 0);
  return won.length ? `${won.length} of the ${all.length} strategies grew faster than both benchmarks by more than luck would explain: ${won.map(r => esc(r.name)).join("; ")}.`
    : `None of the ${all.length} strategies grew faster than buying and holding by more than luck would explain: for every one, the 95% range of its yearly edge includes zero.`;
}

/** The headline block: what seven years say, in a few sentences. */
export function longVerdict(lt: LongTestFile | null | undefined, primary: ModelKey): string {
  if (!lt) return "";
  const h = lt.horizons["7"], all = h.overall, m = all[primary], years = tally(h.years, primary), m30 = lt.horizons["30"].overall[primary];
  const tone: Tone = m.verdict === "better" ? "good" : m.verdict === "worse" ? "bad" : "warn";
  const span = `${spanYears(all.from, all.to)} years`;
  const head = m.verdict === "better" ? `Over ${span}, the 7-day forecast beat the simple baselines`
    : m.verdict === "worse" ? `Over ${span}, the 7-day forecast was worse than the simple baselines`
    : `Over ${span}, the 7-day forecast did not beat the simple baselines`;
  const s = lt.strategies, btc = rowBy(s.portfolio.rows, "btc"), hold = rowBy(s.market.rows, "hold"), model = rowBy(s.market.rows, "model-" + primary), top = rowBy(s.portfolio.rows, "topk-" + primary);
  const line = (r: StrategyRow) => `${pc(r.cagr, 0)} a year, worst drop ${pcu(-r.mdd)}`;
  const best = all.bestBaseline === "flip" ? { accuracy: 0.5, brier: 0.25 } : all[all.bestBaseline];
  return `<div class="verdict v-${tone}"><div class="label">Long-term test · ${num(lt.data.coins)} coins on Bitvavo, ${day(all.from)} to ${day(all.to)}</div>
    <h3>${head}</h3>
    <p>${num(all.n)} seven-day forecasts, each made by a model trained only on what was known before it. Prices rose in ${pcu(all.upShare, 1)} of the cases.
      ${esc(MODEL_NAMES[primary])} (the model shown in the app) was on the right side in ${pcu(m.accuracy, 1)}, with a Brier score of ${m.brier.toFixed(4)}; the best baseline, ${BASELINE_LONG[all.bestBaseline]}, in ${pcu(best.accuracy, 1)} with ${best.brier.toFixed(4)} (lower is better).
      Difference ${signed(m.vsBest.mean)}; redrawing whole weeks at random puts it between ${m.vsBest.lo == null || m.vsBest.hi == null ? "? and ?" : `${signed(m.vsBest.lo)} and ${signed(m.vsBest.hi)}`}${m.verdict === "same" ? ", so it can't be told from zero" : ""}.</p>
    <p><b>By phase:</b> it beat the best baseline in ${years.better.length} of ${years.n} calendar years${years.better.length ? ` (${esc(names(years.better))})` : ""} and was clearly worse in ${years.worse.length}${years.worse.length ? ` (${esc(names(years.worse))})` : ""}.
      <b>30-day forecasts:</b> ${m30.verdict === "better" ? "beat the best baseline" : m30.verdict === "worse" ? "clearly worse than the best baseline" : "no different from the best baseline"} (${signed(m30.vsBest.mean)}, range ${range(m30.vsBest)}).</p>
    <p><b>Picking coins:</b> ${rankingLine(lt, "7", primary)}</p>
    ${btc && hold && model && top ? `<p><b>Trading, after the ${pcu(s.fee, 2)} fee and ${pcu(s.slippage, 2)} slippage:</b> buying and holding Bitcoin, ${line(btc)}; buying and holding every coin, ${line(hold)}; holding each coin only while its chance is above ${pcu(s.threshold)}, ${line(model)}; the weekly top-${s.portfolio.k}, ${line(top)}${behind(top, btc, s.years).length ? ` (behind Bitcoin in ${behind(top, btc, s.years).join(", ")})` : ""}. ${provenEdges(lt)}</p>` : ""}
    <p>Year-by-year tables and where the model fails are under "Long-term test: every year and every strategy" below.</p></div>`;
}

function phaseTable(list: PhaseReport[], primary: ModelKey): string {
  const o = other(primary);
  const cells = (p: PhaseReport, m: ModelKey) => `<td class="r num">${pcu(p[m].accuracy, 1)}</td><td class="r num">${p[m].brier.toFixed(4)}</td>
    <td class="r num" style="white-space:nowrap">${signed(p[m].vsBest.mean)} <span class="muted band">${range(p[m].vsBest)}</span></td><td>${verdictPill(p[m].verdict)}</td>`;
  const head = (m: ModelKey) => `<th class="r">${esc(MODEL_NAMES[m])}: right side</th><th class="r">Brier</th><th class="r" title="Brier score minus the best baseline's: negative means the model was better. In grey: the 95% range when whole weeks are redrawn at random.">vs best baseline</th><th></th>`;
  return `<div class="tablewrap"><table><tr><th>Phase</th><th class="r">Forecasts</th><th class="r">Price rose</th><th title="The best of: base rate, momentum, coin flip, by Brier score in that phase">Best baseline</th><th class="r">right side</th><th class="r">Brier</th>
      ${head(primary)}${head(o)}
      <th class="r" title="${esc(MODEL_NAMES[primary])}: average daily rank correlation between forecast and outcome across coins. 0 = can't tell winners from losers, 1 = perfect.">Picking coins</th>
      <th class="r" title="${esc(MODEL_NAMES[primary])}: return of the fifth of coins rated highest minus that of the average coin, in percentage points, before costs">Top fifth vs average</th></tr>
    ${list.map(p => {
      const b = p.bestBaseline === "flip" ? { accuracy: 0.5, brier: 0.25 } : p[p.bestBaseline], m = p[primary];
      return `<tr><td style="white-space:nowrap">${p.key === "all" ? `<b>${esc(p.label)}</b>` : esc(p.label)}</td><td class="r num">${num(p.n)}</td><td class="r num">${pcu(p.upShare, 1)}</td>
      <td style="white-space:nowrap">${BASELINE[p.bestBaseline]}</td><td class="r num">${pcu(b.accuracy, 1)}</td><td class="r num">${b.brier.toFixed(4)}</td>
      ${cells(p, primary)}${cells(p, o)}
      <td class="r num" style="white-space:nowrap">${m.rank.mean.toFixed(3)} <span class="muted band">${range(m.rank, 3)}</span></td>
      <td class="r num" style="white-space:nowrap">${points(m.top.mean)} <span class="muted band">${points(m.top.lo)} to ${points(m.top.hi)}</span></td></tr>`;
    }).join("")}</table></div>`;
}

function forecastSection(lt: LongTestFile, hz: "7" | "30", primary: ModelKey): string {
  const h = lt.horizons[hz], all = h.overall, cal = h.calibration[primary], o = other(primary);
  const y = tally(h.years, primary), yo = tally(h.years, o), gap = h.gbtVsLogit;
  const gapText = gap.lo == null || gap.hi == null ? "" : gap.hi < 0 ? "Between the two models, boosted trees had the clearly better Brier score." : gap.lo > 0 ? "Between the two models, logistic regression had the clearly better Brier score." : "Between the two models, the difference in Brier score is within what luck would explain.";
  return `<h4>${hz}-day forecasts: ${num(all.n)} of them, in ${h.folds} weekly steps</h4>
    ${phaseTable([all, ...h.years, ...h.regimes, ...h.groups], primary)}
    <p class="note">${esc(MODEL_NAMES[primary])} beat the best baseline in ${y.better.length} of ${y.n} calendar years and was clearly worse in ${y.worse.length}; ${esc(MODEL_NAMES[o].toLowerCase())}: ${yo.better.length} and ${yo.worse.length}. ${gapText}
      "Beat it" and "Worse" are only said when the whole 95% range is on one side of zero. The range comes from redrawing whole calendar weeks at random ${num(lt.bootstrapRounds)} times, in runs of ${h.blockWeeks} weeks so that overlapping forecasts stay together.
      "Base rate" is the share of rises seen so far, used as the forecast for every coin (the nightly test calls it "always up"; here most coins fell, so it mostly says "down").
      With ${h.years.length + h.regimes.length + h.groups.length + 1} phases, two models and two horizons, a "Beat it" or two would be expected from luck alone.</p>
    <div class="tablewrap"><table style="max-width:520px"><tr><th>When ${esc(MODEL_NAMES[primary].toLowerCase())} said (${hz}-day)</th><th class="r">Cases</th><th class="r">Average forecast</th><th class="r">Actually rose</th></tr>
      ${cal.map(b => `<tr><td class="num">${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}%</td><td class="r num">${num(b.n)}</td><td class="r num">${pcu(b.predicted, 0)}</td><td class="r num ${Math.abs(b.predicted - b.observed) > 0.1 ? "down" : ""}">${pcu(b.observed, 0)}</td></tr>`).join("")}</table></div>
    <p class="note">Calibration: a forecast you can take at face value has the last two columns roughly equal. Average gap over all years: ${(all[primary].calibrationError * 100).toFixed(1)} percentage points (${esc(MODEL_NAMES[o].toLowerCase())}: ${(all[o].calibrationError * 100).toFixed(1)}).</p>`;
}

function strategyTable(title: string, rows: StrategyRow[], years: number[], bench: string, perCoin: boolean, withBtc = false): string {
  const b = rowBy(rows, bench), benchName = b?.name ?? "the benchmark";
  const won = (r: StrategyRow) => (b && r !== b ? r.years.filter((v, i) => v != null && b.years[i] != null && v > (b.years[i] as number)).length : null);
  const edgeTip = (name: string) => `How much faster it grew per year than ${esc(name.toLowerCase())}. In grey: the 95% range when whole weeks are redrawn at random. A range that includes zero is within what luck would explain.`;
  return `<div class="tablewrap"><table><tr><th>${esc(title)}</th><th class="r" title="What the starting money became">Total</th><th class="r">Per year</th><th class="r" title="The worst fall from a high">Worst drop</th>
      ${years.map(y => `<th class="r">${y}</th>`).join("")}
      <th class="r" title="Return compounded over the days entered with Bitcoin above its 200-day average">Bitcoin above 200d</th><th class="r" title="The same for days entered with Bitcoin below its 200-day average">Bitcoin below 200d</th>
      <th class="r" title="Calendar years it ended ahead of: ${esc(benchName.toLowerCase())}">Years ahead</th>
      <th class="r" title="${edgeTip(benchName)}">Edge per year</th>${withBtc ? `<th class="r" title="${edgeTip("Buying and holding Bitcoin")}">Edge vs Bitcoin</th>` : ""}
      <th class="r" title="${perCoin ? "Trades per coin per year" : "Trades per year"}">Trades / yr</th></tr>
    ${rows.map(r => `<tr><td>${r.key === bench ? `<b>${esc(r.name)}</b>` : esc(r.name)}</td><td class="r num">${ret(r.ret)}</td><td class="r num ${cls(r.cagr)}">${pc(r.cagr, 0)}</td><td class="r num">${pc(r.mdd, 0)}</td>
      ${r.years.map((v, i) => `<td class="r num" ${v != null && r.yearMdd[i] != null ? `title="Worst drop within the year: ${pc(r.yearMdd[i], 0)}"` : ""}>${ret(v)}</td>`).join("")}
      <td class="r num">${ret(r.above.ret)}</td><td class="r num">${ret(r.below.ret)}</td>
      <td class="r num">${won(r) == null ? `<span class="muted">benchmark</span>` : `${won(r)} of ${r.years.filter(v => v != null).length}`}</td>
      <td class="r num" style="white-space:nowrap">${edgeCell(r.edge)}</td>${withBtc ? `<td class="r num" style="white-space:nowrap">${edgeCell(r.edgeBtc)}</td>` : ""}<td class="r num">${r.trades.toFixed(1)}</td></tr>`).join("")}</table></div>`;
}

const CHART: [string, string][] = [["btc", "var(--muted)"], ["hold", "var(--c1)"], ["sma", "var(--c2)"], ["model", "var(--good)"], ["topk", "var(--accent)"]];

function strategySection(lt: LongTestFile, primary: ModelKey): string {
  const s = lt.strategies, partial = Object.entries(s.partial);
  const pick = (key: string) => s.chart.series.find(x => x.key === key) ?? s.chart.series.find(x => x.key === `${key}-${primary}`);
  const lines = CHART.flatMap(([key, color]) => { const x = pick(key); return x ? [{ s: x, color }] : []; });
  const safest = s.market.rows.slice().sort((a, b) => b.mdd - a.mdd)[0];
  const rules = s.market.rows.filter(r => r.beatHold != null);
  const btcWhole = s.coins.find(c => c.coin === "bitcoin")?.rows.find(r => r.key === "hold"), btc = rowBy(s.portfolio.rows, "btc");
  return `<h4>Strategies after costs, ${day(s.market.from)} to ${day(s.market.to)}</h4>
    <p class="note">Traded by the paper trader's own code on the walk-forward forecasts: decided after one day's close, traded at the next, with a ${pcu(s.fee, 2)} fee and ${pcu(s.slippage, 2)} slippage on every trade.
      So that coins listed later, and coins that later collapsed, are all in, the money is split afresh every 1 January (each year starts in cash and buys at that day's close).${partial.length ? ` Unfinished years: ${partial.map(([y, d]) => `${y} covers ${esc(d)}`).join("; ")}.` : ""}
      <b>${provenEdges(lt)}</b></p>
    <div class="chart">${growthChart(lines.map(x => ({ eq: x.s.eq, color: x.color, w: x.s.key === "btc" ? 2.2 : 1.6 })), s.chart.dates)}</div>
    <div class="legend">${lines.map(x => `<span><i style="background:${x.color}"></i>${esc(x.s.name)}</span>`).join("")}<span>Logarithmic scale: each gridline is a fixed multiple of the starting money.</span></div>
    ${strategyTable(`Every coin, equal money in each (${s.coinsPerYear[0]} coins in ${s.years[0]}, ${s.coinsPerYear[s.coinsPerYear.length - 1]} in ${s.years[s.years.length - 1]})`, s.market.rows, s.years, "hold", true, true)}
    <p class="note">Each strategy is run on every coin that could be traded on the year's first day, with the same money in each. "Years ahead" and "Edge per year" are against buying and holding the same coins.
      ${safest ? `Smallest worst drop: ${esc(safest.name)}, ${pc(safest.mdd, 0)}.` : ""}
      ${rules.length ? `A strategy that is often in cash "wins" on a coin simply because the coin fell: the share of single coin-years ended ahead of holding that coin was ${rules.map(r => `${pcu(r.beatHold)} (${esc(r.name.split(/[:,]/)[0].toLowerCase())}${r.key.startsWith("model-") ? ", " + esc(MODEL_NAMES[r.key.slice(6) as ModelKey].toLowerCase()) : ""})`).join(", ")}, in years when most coins lost money.` : ""}</p>
    ${strategyTable(`Weekly portfolio (one pot)`, s.portfolio.rows, s.years, "btc", false)}
    <p class="note">The top-${s.portfolio.k} rotation picks from the ${s.portfolio.universe} most traded coins on Bitvavo and goes to cash while Bitcoin is below its 50-day average. Bitvavo's public data has no market caps, so trading volume stands in for size and the composite score lacks its size and liquidity parts. "Years ahead" and "Edge per year" are against buying and holding Bitcoin.
      ${btcWhole && btc ? `Held without a break, Bitcoin made ${ret(btcWhole.ret)} (${pc(btcWhole.cagr, 0)} a year); the ${ret(btc.ret)} here is lower because every row restarts in cash each 1 January and so misses that day's move.` : ""}</p>
    <details class="more" style="margin-top:10px"><summary>The same strategies on single coins, without a break</summary>
      ${s.coins.map(c => strategyTable(`${c.name}, from ${day(c.from)}`, c.rows, s.years, "hold", true)).join("")}
      <p class="note">€1,000 per strategy on one coin from its first forecast to the end, as on the Paper trading page. Weekly DCA spreads the money over the first 52 weeks and then holds, so after its first year it is buy and hold. Monero and other paper-trading coins that Bitvavo doesn't list are missing.</p></details>`;
}

/** Where the model fails, read from the numbers. */
function failures(lt: LongTestFile, primary: ModelKey): string {
  const out: string[] = [], name = esc(MODEL_NAMES[primary]);
  for (const hz of ["7", "30"] as const) {
    const h = lt.horizons[hz], y = tally(h.years, primary), all = h.overall[primary];
    out.push(`<b>${hz}-day, all years:</b> ${name} ${all.verdict === "better" ? "beat" : all.verdict === "worse" ? "was clearly worse than" : "was no better than"} ${BASELINE_LONG[h.overall.bestBaseline]}: Brier ${all.brier.toFixed(4)} against ${(h.overall.bestBaseline === "flip" ? 0.25 : h.overall[h.overall.bestBaseline].brier).toFixed(4)}.`);
    out.push(`<b>${hz}-day, by year:</b> ${y.better.length ? `beat the best baseline in ${esc(names(y.better))}` : "never beat the best baseline"}${y.worse.length ? `; clearly worse in ${esc(names(y.worse))}` : ""}${y.same.length ? `; no measurable difference in ${y.same.length === y.n ? "any year" : esc(names(y.same))}` : ""}.`);
    const below = h.regimes.find(p => p.key === "below"), above = h.regimes.find(p => p.key === "above");
    if (below && above) out.push(`<b>${hz}-day, by Bitcoin's trend:</b> ${VERDICT[above[primary].verdict][1].toLowerCase()} with Bitcoin above its 200-day average (${signed(above[primary].vsBest.mean)}); ${VERDICT[below[primary].verdict][1].toLowerCase()} with it below (${signed(below[primary].vsBest.mean)}).`);
    if (all.calibrationError > 0.03) out.push(`<b>${hz}-day, calibration:</b> its chances can't be taken at face value. On average they were ${(all.calibrationError * 100).toFixed(1)} percentage points away from how often the rise happened, and furthest off when it sounded most sure.`);
    out.push(`<b>${hz}-day, picking coins:</b> rank correlation ${all.rank.mean.toFixed(3)} (range ${range(all.rank, 3)}). ${rankingLine(lt, hz, primary)}`);
  }
  const s = lt.strategies, hold = rowBy(s.market.rows, "hold"), model = rowBy(s.market.rows, "model-" + primary), btc = rowBy(s.portfolio.rows, "btc"), top = rowBy(s.portfolio.rows, "topk-" + primary), topOther = rowBy(s.portfolio.rows, "topk-" + other(primary));
  if (hold && model && btc) out.push(`<b>Per-coin model strategy:</b> ${pc(model.cagr, 0)} a year against ${pc(hold.cagr, 0)} for holding the same coins and ${pc(btc.cagr, 0)} for holding Bitcoin. Its edge over Bitcoin: ${model.edgeBtc ? `${pc(model.edgeBtc.mean, 0)} a year (range ${pc(model.edgeBtc.lo, 0)} to ${pc(model.edgeBtc.hi, 0)})` : "—"}. It fell less (${pc(model.mdd, 0)} against ${pc(hold.mdd, 0)}) mostly because it was in cash much of the time.`);
  if (btc && top) {
    out.push(`<b>Weekly top-${s.portfolio.k}:</b> ${pc(top.cagr, 0)} a year against ${pc(btc.cagr, 0)} for Bitcoin, with a worst drop of ${pc(top.mdd, 0)} and ${top.trades.toFixed(0)} trades a year. Edge ${top.edge ? `${pc(top.edge.mean, 0)} a year (range ${pc(top.edge.lo, 0)} to ${pc(top.edge.hi, 0)})` : "—"}. It trailed Bitcoin in ${behind(top, btc, s.years).join(", ") || "no year"}.${topOther ? ` The same rotation on ${esc(MODEL_NAMES[other(primary)].toLowerCase())} made ${pc(topOther.cagr, 0)} a year: a result that swings this much between two near-identical forecasts is mostly luck.` : ""}`);
  }
  return `<ul class="note">${out.map(t => `<li>${t}</li>`).join("")}</ul>`;
}

/** The full long-term report, folded away under the verdict. */
export function longDetails(lt: LongTestFile | null | undefined, primary: ModelKey): string {
  if (!lt) return "";
  const d = lt.data;
  return `<details class="more" id="long"><summary>Long-term test: every year and every strategy</summary>
    <div class="section"><h3>What was tested</h3>
      <p class="note">Bitvavo's public daily EUR prices from ${day(d.from)} to ${day(lt.through)}: ${num(d.coins)} coins, every one Bitvavo lists today, each from its first day there (${d.byYears.map(([t, n]) => `${n} with ${esc(t)}`).join(", ")}).
        The same models, inputs and walk-forward method as the nightly test: for each week, train only on outcomes known before it, with a gap of the full 7 or 30 days. Nothing was tuned to these results.</p>
      <p class="note"><b>Survivorship bias is smaller here, not gone.</b> Only ${d.scanCoins} of the ${num(d.coins)} coins are in today's top-coin scan, and ${d.collapsed} now trade more than 90% below their own high, so the losers that are still listed are in.
        Coins Bitvavo has removed are not: its public data keeps nothing for them (${d.delisted} are still named without a market, older removals aren't named at all). "Buy and hold every coin" is therefore still a little too rosy.
        ${d.scanTotal - d.scanCoins} of the ${d.scanTotal} scanned coins don't trade on Bitvavo and aren't covered.</p></div>
    <div class="section"><h3>Where the model fails</h3>${failures(lt, primary)}</div>
    <div class="section"><h3>The forecasts, phase by phase</h3>${forecastSection(lt, "7", primary)}${forecastSection(lt, "30", primary)}</div>
    <div class="section"><h3>Strategies</h3>${strategySection(lt, primary)}</div>
    <div class="section"><h3>What this can't tell you</h3>
      <ul class="note"><li>Seven years is about two full market cycles. "Per phase" still means only a handful of bull and bear stretches, which is why the ranges are so wide.</li>
      <li>Most coins were listed in 2024 or later, so recent years carry far more forecasts than early ones.</li>
      <li>Daily closes and ${pcu(lt.strategies.slippage, 2)} slippage are kind to small coins: in real trading the gap between buying and selling prices of a thinly traded coin is often much wider.</li>
      <li>Past returns are not a promise, and nothing here is advice.</li></ul></div></details>`;
}
