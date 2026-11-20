/**
 * The nightly forecast: retrains the models on every finished day in data/history/, runs the walk-forward
 * test again, forecasts each coin from the newest close, logs those forecasts (so a real track record builds
 * up) and scores the logged forecasts whose outcome is now known. No network; run after `npm run scan`.
 *
 *   npm run forecast
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import { buildSamples, dayNumber, dayString, FEATURES, HORIZONS } from "../src/model/features";
import { BASELINE_NAMES, evaluate, MODEL_NAMES, verdictText, type HorizonReport } from "../src/model/report";
import { logPath, logToCsv, trackRecord } from "../src/model/track";
import { type CoinForecast, type ForecastFile, type HorizonForecast, type LogRow, type ValidationFile } from "../src/model/types";
import { drivers, fitModels, forecast, knownBefore, MODEL_DEFAULTS, probabilityBands, walkForward } from "../src/model/walkforward";
import { loadHistories, loadLog, loadModelConfig, MODEL_DIR as OUT, MODEL_LOG_DIR as LOG } from "./lib/data";
import { report, saveJson, saveText } from "./lib/io";


const round = (x: number, d = 4) => { const k = 10 ** d; return Math.round(x * k) / k; };
const pct = (x: number, d = 1) => (x * 100).toFixed(d) + "%";
const exists = (path: string) => access(path).then(() => true, () => false);

function table(r: HorizonReport): string[] {
  const row = (name: string, s: { accuracy: number; brier: number; auc: number }, extra = "") => `| ${name} | ${pct(s.accuracy)} | ${s.brier.toFixed(4)} | ${s.auc.toFixed(3)} | ${extra} |`;
  const vs = (m: "logit" | "gbt") => { const c = r.versus[m][r.bestBaseline]; return c.lo == null ? "too little history to say" : `${c.mean > 0 ? "+" : ""}${c.mean.toFixed(4)} (95% range ${c.lo!.toFixed(4)} to ${c.hi!.toFixed(4)}): ${c.verdict}`; };
  return [
    `| ${r.horizon}-day forecasts | Accuracy | Brier (lower is better) | AUC | Brier vs best baseline (${BASELINE_NAMES[r.bestBaseline]}) |`, "|---|---:|---:|---:|---|",
    row(MODEL_NAMES.logit, r.logit, vs("logit")), row(MODEL_NAMES.gbt, r.gbt, vs("gbt")),
    row("Baseline: always up (as a probability)", r.base), row("Baseline: simple momentum (as a probability)", r.momentum),
    `| Baseline: coin flip | 50.0% | 0.2500 | 0.500 | |`,
    "", `Plain rules: always saying "up" was right ${pct(r.alwaysUpAccuracy)} of the time; "up if the last 30 days were up" ${pct(r.momentumRuleAccuracy)}.`,
  ];
}

async function main(): Promise<number> {
  const started = Date.now();
  const { primary: PRIMARY, note } = await loadModelConfig();
  const histories = await loadHistories();
  const btc = histories.get("bitcoin");
  if (!btc) { console.error("No Bitcoin history in data/history/ yet. Run the scan first (npm run scan)."); return 1; }
  const date = btc.dates[btc.dates.length - 1], today = dayNumber(date);
  const samples = buildSamples(histories);
  if (!samples.length) { console.error("Not enough history to build the model's inputs yet."); return 1; }
  console.log(`Forecast from the closes of ${date}: ${histories.size} coins, ${samples.length} coin-days with full inputs.`);
  const generatedAt = new Date().toISOString();

  // 1. The walk-forward test.
  const validation: ValidationFile = { generatedAt, date, coins: new Set(samples.map(s => s.coin)).size, samples: samples.length, historyFrom: dayString(samples[0].day), options: MODEL_DEFAULTS, horizons: {} };
  for (const h of HORIZONS) {
    const wf = walkForward(samples, h);
    validation.horizons[h] = { ...evaluate(wf.rows, h), folds: wf.folds, firstTrainRows: wf.firstTrainRows, lastTrainRows: wf.lastTrainRows };
    console.log(`  ${h}-day walk-forward: ${wf.rows.length} forecasts in ${wf.folds} weekly steps (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }

  // 2. Tonight's forecasts, from models trained on every outcome known by now.
  const now = samples.filter(s => s.day === today);
  const coins = new Map<string, CoinForecast>(now.map(s => [s.coin, { id: s.coin } as CoinForecast]));
  const file: ForecastFile = { date, generatedAt, primary: PRIMARY, primaryNote: note, coins: [], trained: {}, weights: {} };
  const logRows: LogRow[] = [];
  // Last night's forecasts, to show how each chance moved.
  const earlier = (await loadLog()).filter(r => r.date < date);
  const lastNight = earlier.length ? earlier[earlier.length - 1].date : null;
  const was = new Map(earlier.filter(r => r.date === lastNight).map(r => [r.coin + "/" + r.h, r[PRIMARY]] as const));
  for (const h of HORIZONS) {
    const train = knownBefore(samples, h, today + 1);
    if (train.length < 500) { console.error(`Only ${train.length} rows with a known ${h}-day outcome: too few to train on.`); return 1; }
    const f = fitModels(train, h), bands = probabilityBands(train, h, now.map(s => s.x), MODEL_DEFAULTS, PRIMARY === "gbt" ? 20 : 30, 7, PRIMARY);
    file.trained[h] = { rows: f.rows, from: dayString(f.firstDay), to: dayString(f.lastDay) };
    file.weights[h] = { logit: f.logit.w.map(w => round(w)), gbt: f.gbt.importance.map(w => round(w)) };
    now.forEach((s, i) => {
      const p = forecast(f, s.x), why = drivers(f, s.x)[PRIMARY];
      const hf: HorizonForecast = {
        p: round(p[PRIMARY]), was: was.get(s.coin + "/" + h) ?? null, band: [round(Math.min(bands[i][0], p[PRIMARY])), round(Math.max(bands[i][1], p[PRIMARY]))], logit: round(p.logit), gbt: round(p.gbt),
        ret: [round(Math.expm1(p.lo)), round(Math.expm1(p.mu)), round(Math.expm1(p.hi))],
        why: why.map((c, j) => [j, round(c, 3)] as [number, number]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5),
      };
      coins.get(s.coin)![h === 7 ? "h7" : "h30"] = hf;
      logRows.push({ date, coin: s.coin, h, logit: p.logit, gbt: p.gbt, base: p.base, momentum: p.momentum, trendUp: p.trendUp, mu: p.mu, lo: p.lo, hi: p.hi });
    });
  }
  file.coins = [...coins.values()].sort((a, b) => b.h7.p - a.h7.p);
  await saveJson(join(OUT, "latest.json"), file);
  await saveJson(join(OUT, "validation.json"), validation);

  // 3. The log (a night's forecasts are written once and never changed) and the live record.
  const path = join(LOG, logPath(date));
  const logged = await exists(path);
  if (!logged) await saveText(path, logToCsv(logRows.sort((a, b) => a.h - b.h || (a.coin < b.coin ? -1 : 1))));
  const track = trackRecord(await loadLog(), histories, generatedAt);
  await saveJson(join(OUT, "track.json"), track);

  const lines = [`## Forecast, closes of ${date}`];
  lines.push(`${file.coins.length} coins forecast in ${((Date.now() - started) / 1000).toFixed(0)}s. ${logged ? "Tonight's forecasts were already logged (the first ones stand)." : "Forecasts logged."}`);
  lines.push("", "### Walk-forward test on past data", `History from ${validation.historyFrom}; every forecast was made by a model trained only on outcomes known before it.`, "");
  for (const h of HORIZONS) {
    const r = validation.horizons[h];
    lines.push(...table(r), "", `- ${verdictText(r, "logit")}`, `- ${verdictText(r, "gbt")}`, `- Return estimate: skill against "no change" ${r.ret.r2.toFixed(3)}; the 80% range held the outcome ${pct(r.ret.coverage)} of the time.`, "");
  }
  lines.push("### Live record (forecasts logged each night)");
  for (const h of HORIZONS) {
    const r = track.horizons[h];
    lines.push(r.n ? `- ${h}-day: ${r.n} scored, ${MODEL_NAMES[PRIMARY]} right ${pct(r[PRIMARY].accuracy)}, Brier ${r[PRIMARY].brier.toFixed(4)} (always up: ${r.base.brier.toFixed(4)}). ${verdictText(r, PRIMARY)}` : `- ${h}-day: none scored yet (${r.pending} waiting; the first outcomes arrive on ${r.firstResolves}).`);
  }
  const top = file.coins.slice(0, 5).map(c => `${c.id} ${pct(c.h7.p, 0)}`).join(", ");
  lines.push("", `Highest 7-day chance of a rise tonight: ${top}. Inputs: ${FEATURES.length}.`);
  await report(lines.join("\n"));
  return 0;
}

main().then(code => process.exit(code), e => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
