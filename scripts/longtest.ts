/**
 * The long-term test: the nightly forecasting models and the paper-trading strategies, re-run on seven years
 * of Bitvavo history (data/bitvavo/, see `npm run bitvavo`) and scored per market phase. No network.
 * Research only: the nightly run doesn't call it, and it never touches the paper-trading files.
 *
 *   npm run longtest            (about 15 minutes the first time; add -- --fresh to train again)
 *
 * Writes public/data/longtest/report.json (shown in the app under Signals).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSamples, dayNumber, dayString, HORIZONS, type Horizon } from "../src/model/features";
import { MODEL_NAMES, type ModelKey } from "../src/model/report";
import { MODEL_DEFAULTS, type Tested } from "../src/model/walkforward";
import type { BookKey } from "../src/paper/portfolio";
import { strategyName } from "../src/paper/summary";
import { MODEL_THRESHOLD, type Signals } from "../src/paper/trader";
import type { PaperConfig, PaperStrategy, PriceFile } from "../src/paper/types";
import { yearsOf } from "../src/research/bitvavo";
import { allPhases, blockWeeksFor, btcAboveLong, calibrationOf, type PhaseReport } from "../src/research/phases";
import { chain, compositeScores, curveStats, daySignals, edgeOver, marketYear, regimeSplit, runPairs, runPortfolio, volumeRanks, yearStats, yearWindows, type Curve } from "../src/research/strategies";
import type { LongTestFile, StrategyRow } from "../src/research/types";
import { loadUniverse, longWalkForward, runWorker } from "./lib/longrun";
import { loadJson, report, saveJson } from "./lib/io";

const SCRIPT = fileURLToPath(import.meta.url);
const OUT = process.env.LONGTEST_DIR || join("public", "data", "longtest");
const ROUNDS = 2000;
const MODELS: ModelKey[] = ["gbt", "logit"];

const pct = (x: number | null, d = 1) => (x == null ? "—" : (x >= 0 ? "+" : "") + (x * 100).toFixed(d) + "%");
const share = (x: number, d = 1) => (x * 100).toFixed(d) + "%";
const edge = (b: StrategyRow["edge"]) => (b == null ? "" : `${pct(b.mean)} (${pct(b.lo)} to ${pct(b.hi)})`);
const nextDay = (d: string) => dayString(dayNumber(d) + 1);

/** Numbers shortened to 5 significant digits, so the published file stays small. */
function tidy<T>(v: T): T {
  if (typeof v === "number") return (Number.isInteger(v) ? v : Number(v.toPrecision(5))) as T;
  if (Array.isArray(v)) return v.map(tidy) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tidy(x)])) as T;
  return v;
}

type Built = StrategyRow & { curve: Curve };

function row(key: string, name: string, parts: readonly Curve[], years: readonly number[], above: ReadonlyMap<string, boolean>, trades: number, beatHold?: number): Built {
  const curve = chain(parts), ys = yearStats(curve, years), rs = regimeSplit(curve, above);
  return { key, name, ...curveStats(curve), trades, years: ys.ret, yearMdd: ys.mdd, above: rs.above, below: rs.below, edge: null, edgeBtc: null, beatHold, curve };
}

/** Fills in how much faster each row grew than the table's benchmark and, when given, than buying and holding Bitcoin. */
function addEdges(rows: Built[], bench: string, btc: Curve | null): Built[] {
  const b = rows.find(r => r.key === bench)!;
  for (const r of rows) { r.edge = r.key === bench ? null : edgeOver(r.curve, b.curve, 4, ROUNDS); r.edgeBtc = !btc || r.key === "btc" ? null : edgeOver(r.curve, btc, 4, ROUNDS); }
  return rows;
}
const strip = (r: StrategyRow & { curve?: Curve }): StrategyRow => { const { curve: _curve, ...rest } = r; return rest; };

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === "--worker") { await runWorker(Number(args[1]) as Horizon, Number(args[2]), Number(args[3]), args[4]); return 0; }
  const started = Date.now();
  const { index, universe } = await loadUniverse();
  const btc = universe.histories.get("bitcoin");
  if (!btc) { console.error("No Bitcoin history in data/bitvavo/. Run `npm run bitvavo` first."); return 1; }
  const samples = buildSamples(universe.histories);
  const last = btc.dates[btc.dates.length - 1];
  console.log(`Long-term test: ${universe.coins.length} coins, ${samples.length} coin-days with full inputs, ${dayString(samples[0].day)} to ${last}.`);
  const aboveDay = btcAboveLong(btc), above = new Map([...aboveDay].map(([d, a]) => [dayString(d), a] as const));
  const scan = new Set(universe.coins.filter(c => c.scan).map(c => c.id));

  // 1. The forecasts: the nightly walk-forward test on the long history, scored per phase.
  const horizons: LongTestFile["horizons"] = {};
  let week: Tested[] = [];
  for (const h of HORIZONS) {
    const wf = await longWalkForward(samples, h, SCRIPT, args.includes("--fresh"));
    if (h === 7) week = wf.rows;
    horizons[h] = { folds: wf.folds, firstTrainRows: wf.firstTrainRows, lastTrainRows: wf.lastTrainRows, blockWeeks: blockWeeksFor(h), ...allPhases(wf.rows, h, aboveDay, scan, ROUNDS), calibration: calibrationOf(wf.rows, h) };
    console.log(`  ${h}-day forecasts scored (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }

  // 2. The strategies, traded by the paper trader's own code with the walk-forward forecasts.
  const config = await loadJson<PaperConfig>(join("public", "paper", "config.json"));
  if (!config.portfolio) { console.error("public/paper/config.json has no portfolio settings."); return 1; }
  const prices: PriceFile = Object.fromEntries([...universe.histories].map(([id, h]) => [id, { dates: h.dates, closes: h.closes }]));
  const byCoin = {} as Record<ModelKey, Signals>, byDay = {} as Record<ModelKey, Record<string, Record<string, number>>>;
  for (const m of MODELS) { byCoin[m] = {}; byDay[m] = {}; }
  let firstDay = Infinity;
  for (const r of week) {
    const d = dayString(r.day);
    if (r.day < firstDay) firstDay = r.day;
    for (const m of MODELS) { (byCoin[m][r.coin] ??= {})[d] = r[m]; (byDay[m][d] ??= {})[r.coin] = r[m]; }
  }
  // Forecasts exist only up to a week before the last close (later ones have no outcome yet and weren't tested),
  // so the strategies stop on the day after the last tested forecast.
  const lastForecast = dayString(week.reduce((mx, r) => Math.max(mx, r.day), 0));
  const first = nextDay(dayString(firstDay)), end = nextDay(lastForecast) > last ? last : nextDay(lastForecast);
  const windows = yearWindows(first, end), years = windows.map(w => w.year);
  const settings = config.settings, threshold = settings.modelThreshold ?? MODEL_THRESHOLD;
  const modelName = (m: ModelKey) => `Model, ${MODEL_NAMES[m].toLowerCase()}: 7-day chance above ${(threshold * 100).toFixed(0)}%`;

  // 2a. Every coin, equal money in each, fresh every 1 January.
  const marketYears = windows.map(w => marketYear(prices, byCoin.gbt, config, w, btc.dates));
  const logitYears = windows.map(w => marketYear(prices, byCoin.logit, { ...config, strategies: ["hold", "model"] }, w, btc.dates));
  const coinsPerYear = marketYears.map(y => y.coins), coinYears = coinsPerYear.reduce((s, n) => s + n, 0);
  const weighted = (ys: typeof marketYears, s: PaperStrategy, pick: "trades" | "beatHold") => ys.reduce((sum, y) => sum + (y[pick].get(s) ?? 0) * y.coins, 0) / coinYears;
  const market = [
    ...config.strategies.map(s => row(s === "model" ? "model-gbt" : s, s === "model" ? modelName("gbt") : s === "hold" ? "Buy and hold every coin (equal weight)" : strategyName(s, settings),
      marketYears.map(y => y.curves.get(s)!), years, above, weighted(marketYears, s, "trades"), s === "hold" ? undefined : weighted(marketYears, s, "beatHold"))),
    row("model-logit", modelName("logit"), logitYears.map(y => y.curves.get("model")!), years, above, weighted(logitYears, "model", "trades"), weighted(logitYears, "model", "beatHold")),
  ];
  console.log(`  whole-market strategies done (${((Date.now() - started) / 1000).toFixed(0)}s)`);

  // 2b. The weekly top-k portfolio and its benchmarks, fresh every 1 January.
  const seed = dayString(firstDay - 1);
  const composite = compositeScores(universe.histories, seed), ranks = volumeRanks(universe.histories, seed);
  const pf = Object.fromEntries(MODELS.map(m => { const sig = daySignals(composite, ranks, byDay[m]); return [m, windows.map(w => runPortfolio(prices, sig, config, w.start, w.end))]; })) as Record<ModelKey, ReturnType<typeof runPortfolio>[]>;
  const book = (m: ModelKey, k: BookKey) => pf[m].filter(r => r != null).map(r => r!.books[k]);
  const perYear = (m: ModelKey, k: BookKey) => book(m, k).reduce((s, r) => s + r.trades, 0) / windows.length;
  const topName = (m: ModelKey) => `Top-${config.portfolio!.k} weekly rotation, ${MODEL_NAMES[m].toLowerCase()}`;
  const portfolio = [
    row("topk-gbt", topName("gbt"), book("gbt", "topk"), years, above, perYear("gbt", "topk")),
    row("topk-logit", topName("logit"), book("logit", "topk"), years, above, perYear("logit", "topk")),
    row("equal", `Equal weight of the ${config.portfolio.universe} most traded coins, held`, book("gbt", "equal"), years, above, perYear("gbt", "equal")),
    row("btc", "Buy and hold Bitcoin", book("gbt", "btc"), years, above, perYear("gbt", "btc")),
  ];
  addEdges(portfolio, "btc", null);
  for (const r of portfolio) r.edgeBtc = r.edge;
  addEdges(market, "hold", portfolio[3].curve);
  console.log(`  portfolio done (${((Date.now() - started) / 1000).toFixed(0)}s)`);

  // 2c. The paper-trading coins, each run without a break from its first forecast.
  const coinTables: LongTestFile["strategies"]["coins"] = [];
  for (const coin of config.coins) {
    const days = Object.keys(byCoin.gbt[coin] ?? {}).sort();
    if (!days.length) continue;
    const from = nextDay(days[0]);
    const a = runPairs(prices, byCoin.gbt, config, [coin], from, end).get(coin), b = runPairs(prices, byCoin.logit, { ...config, strategies: ["hold", "model"] }, [coin], from, end).get(coin);
    if (!a || !b) continue;
    const span = (dayNumber(end) - dayNumber(from) + 1) / 365.25;
    const rows = [...config.strategies.map(s => { const r = a.get(s)!; return row(s === "model" ? "model-gbt" : s, s === "model" ? modelName("gbt") : strategyName(s, settings), [r], years, above, r.trades / span); }),
      row("model-logit", modelName("logit"), [b.get("model")!], years, above, b.get("model")!.trades / span)];
    coinTables.push({ coin, name: universe.coins.find(c => c.id === coin)?.name ?? coin, from, to: end, rows: addEdges(rows, "hold", null).map(strip) });
  }

  // Weekly points of the main curves, for the chart.
  const chartRows = [...portfolio, ...market], dates = chartRows[0].curve.dates;
  const keep = dates.map((_, i) => i).filter(i => i % 7 === 0 || i === dates.length - 1);
  const chart = { dates: keep.map(i => dates[i]), series: chartRows.map(r => ({ key: r.key, name: r.name, eq: keep.map(i => Number(r.curve.eq[i].toPrecision(4))) })) };

  const real = universe.coins.filter(c => !c.id.includes("~"));
  const bucket = (lo: number, hi: number) => real.filter(c => { const y = yearsOf(universe.histories.get(c.id)!); return y >= lo && y < hi; }).length;
  const collapsed = real.filter(c => { const h = universe.histories.get(c.id)!; return h.closes[h.closes.length - 1] < 0.1 * Math.max(...h.closes); }).length;
  const file: LongTestFile = {
    generatedAt: new Date().toISOString(), through: last, source: "Bitvavo public daily EUR candles",
    data: {
      coins: real.length, scanCoins: scan.size, from: btc.dates[0], samples: samples.length,
      byYears: [["7 years or more", bucket(7, 99)], ["5 to 7 years", bucket(5, 7)], ["3 to 5 years", bucket(3, 5)], ["2 to 3 years", bucket(2, 3)], ["1 to 2 years", bucket(1, 2)], ["under 1 year", bucket(0, 1)]],
      collapsed, delisted: index.delisted.length, scanTotal: index.scan.matched.length + index.scan.unlisted.length + index.scan.clash.length,
      scanMissing: [...index.scan.unlisted, ...index.scan.clash].map(c => c.name), split: universe.split,
    },
    options: MODEL_DEFAULTS, bootstrapRounds: ROUNDS, horizons,
    strategies: {
      fee: config.fee, slippage: config.slippage, threshold, years, coinsPerYear,
      partial: Object.fromEntries(windows.filter(w => w.start !== `${w.year}-01-01` || w.end !== `${w.year}-12-31`).map(w => [String(w.year), `${w.start} to ${w.end}`])),
      market: { from: first, to: end, rows: market.map(strip) },
      portfolio: { from: first, to: end, k: config.portfolio.k, universe: config.portfolio.universe, rows: portfolio.map(strip) },
      coins: coinTables, chart,
    },
  };
  await saveJson(join(OUT, "report.json"), tidy(file));

  // The same results as text, for the console (and the run's summary page on GitHub).
  const lines = [`## Long-term test, Bitvavo closes ${btc.dates[0]} to ${last}`,
    `${real.length} coins (${scan.size} of them in today's scan), ${samples.length} coin-days. Bootstrap: ${ROUNDS} resamples of whole weeks.`];
  const phaseLine = (p: PhaseReport) => {
    const m = (k: ModelKey) => `${share(p[k].accuracy)} | ${p[k].brier.toFixed(4)} | ${p[k].vsBest.mean > 0 ? "+" : ""}${p[k].vsBest.mean.toFixed(4)} (${p[k].vsBest.lo?.toFixed(4) ?? "?"} to ${p[k].vsBest.hi?.toFixed(4) ?? "?"}) ${p[k].verdict} | ${p[k].rank.mean.toFixed(3)} (${p[k].rank.lo?.toFixed(3) ?? "?"} to ${p[k].rank.hi?.toFixed(3) ?? "?"}) | ${share(p[k].calibrationError)}`;
    return `| ${p.label} | ${p.n} | ${share(p.upShare)} | ${share(p.base.accuracy)} / ${p.base.brier.toFixed(4)} | ${share(p.momentum.accuracy)} / ${p.momentum.brier.toFixed(4)} | ${p.bestBaseline} | ${m("gbt")} | ${m("logit")} |`;
  };
  for (const h of HORIZONS) {
    const r = horizons[h];
    lines.push("", `### ${h}-day forecasts (${r.folds} weekly steps)`,
      "| Phase | Forecasts | Rose | Always up: hit / Brier | Momentum: hit / Brier | Best baseline | Trees: hit | Brier | vs best (95% range) | rank corr. (95% range) | calib. gap | Logistic: hit | Brier | vs best (95% range) | rank corr. (95% range) | calib. gap |",
      "|---|---:|---:|---|---|---|---:|---:|---|---|---:|---:|---:|---|---|---:|",
      ...[r.overall, ...r.years, ...r.regimes, ...r.groups].map(phaseLine),
      "", `Trees minus logistic, Brier: ${r.gbtVsLogit.mean.toFixed(4)} (${r.gbtVsLogit.lo?.toFixed(4)} to ${r.gbtVsLogit.hi?.toFixed(4)}).`,
      `Top fifth by forecast minus the average coin, ${h}-day log return: ${[r.overall, ...r.years, ...r.regimes].map(p => `${p.label}: trees ${pct(p.gbt.top.mean, 2)} (${pct(p.gbt.top.lo, 2)} to ${pct(p.gbt.top.hi, 2)}), logistic ${pct(p.logit.top.mean, 2)} (${pct(p.logit.top.lo, 2)} to ${pct(p.logit.top.hi, 2)})`).join("; ")}.`);
  }
  const table = (title: string, rows: StrategyRow[]) => {
    lines.push("", `### ${title}`, `| Strategy | Total | Per year | Worst drop | Trades/yr | ${years.join(" | ")} | BTC above 200d | BTC below 200d | Beat hold | Edge vs benchmark / yr (95% range) | Edge vs BTC / yr |`, `|---|---:|---:|---:|---:|${years.map(() => "---:").join("|")}|---:|---:|---:|---|---|`);
    for (const r of rows) lines.push(`| ${r.name} | ${pct(r.ret, 0)} | ${pct(r.cagr)} | ${pct(r.mdd, 0)} | ${r.trades.toFixed(1)} | ${r.years.map(v => pct(v, 0)).join(" | ")} | ${pct(r.above.ret, 0)} (${r.above.days}d) | ${pct(r.below.ret, 0)} (${r.below.days}d) | ${r.beatHold == null ? "" : share(r.beatHold, 0)} | ${edge(r.edge)} | ${edge(r.edgeBtc)} |`);
  };
  table(`Whole market, ${first} to ${end}: equal money in every coin, fresh each 1 January (coins per year: ${coinsPerYear.join(", ")})`, market);
  table(`Weekly portfolio, fresh each 1 January`, portfolio);
  for (const c of coinTables) table(`${c.name}, ${c.from} to ${c.to}, without a break`, c.rows);
  lines.push("", `Done in ${((Date.now() - started) / 1000).toFixed(0)}s.`);
  await report(lines.join("\n"));
  return 0;
}

main().then(code => process.exit(code), e => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
