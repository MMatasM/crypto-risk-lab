/**
 * The daily paper trading job: fetches daily closes from CoinGecko, trades every finished day not yet
 * traded, and saves the files in public/paper/. Safe to run any number of times.
 *
 *   npm run paper                      (locally; uses the keyless limit unless COINGECKO_DEMO_KEY is set)
 *
 * Run by the nightly workflow after the scan and the forecast, whose results the model strategies use:
 * the "model" strategy reads the forecast log, and the weekly top-k portfolio also reads the scan history
 * and the price files in data/history/. Exit code 1 only when nothing could be done (a bad config, a
 * rejected key, or every coin failing); a single failing coin is skipped and retried next run.
 */
import { join } from "node:path";
import { ApiError, CoinGeckoClient } from "../src/data/coingecko";
import { parseMarketChart } from "../src/data/repository";
import { advancePortfolio, emptyPortfolio, portfolioBoard, type DaySignals, type PortfolioState, type PortfolioTrade } from "../src/paper/portfolio";
import { board, curves, daysOfData } from "../src/paper/summary";
import { advance, checkConfig, mergeCloses, type Signals } from "../src/paper/trader";
import { emptyState, type PaperConfig, type PaperState, type PriceFile, type TradeRecord } from "../src/paper/types";
import type { ScanHistory } from "../src/scan/types";
import { loadHistories, loadLog, loadModelConfig } from "./lib/data";
import { loadJson, report, saveJson, utcToday } from "./lib/io";

const DIR = process.env.PAPER_DIR || join("public", "paper");
const SCAN = process.env.SCAN_DIR || join("public", "data", "scan");
const KEY = (process.env.COINGECKO_DEMO_KEY ?? "").trim();
const today = utcToday(); // UTC day: its close isn't final yet, so it is never traded

const eur = (v: number) => "€" + (Math.abs(v) >= 10 ? v.toFixed(2) : v.toPrecision(4));
const pct = (v: number) => (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%";
const pts = (v: number | null) => { if (v == null) return "(baseline)"; const x = Number((v * 100).toFixed(2)); return (x >= 0 ? "+" : "") + x.toFixed(2) + " pts"; };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

async function main(): Promise<number> {
  const config = await loadJson<PaperConfig>(join(DIR, "config.json"));
  const bad = checkConfig(config);
  if (bad.length) { console.error("config.json has problems:\n- " + bad.join("\n- ")); return 1; }
  const prices = await loadJson<PriceFile>(join(DIR, "prices.json"), {});
  const state = await loadJson<PaperState>(join(DIR, "state.json"), emptyState());
  const log = await loadJson<TradeRecord[]>(join(DIR, "trades.json"), []);

  console.log(`Paper trading run for closes before ${today} (UTC). CoinGecko: ${KEY ? "Demo key" : "no key (slow keyless limit)"}.`);
  const client = new CoinGeckoClient({ getKey: () => KEY, onStatus: t => console.log("  " + t) });
  const failed: string[] = [];
  let added = 0;
  for (const coin of config.coins) {
    const saved = prices[coin];
    const last = saved?.dates[saved.dates.length - 1];
    // A week of overlap with the saved closes, to check the new data against them; a full year the first time.
    const days = last ? Math.min(365, Math.max(10, daysBetween(last, today) + 7)) : 365;
    try {
      const h = parseMarketChart(await client.get(`/coins/${encodeURIComponent(coin)}/market_chart?vs_currency=eur&days=${days}&interval=daily`));
      const m = mergeCloses(saved, h, today);
      if (m.problem) { failed.push(`${coin}: skipped, ${m.problem}`); continue; }
      prices[coin] = m.closes;
      added += m.added;
      console.log(`  ${coin}: ${m.added} new close${m.added === 1 ? "" : "s"} (latest ${m.closes.dates[m.closes.dates.length - 1] ?? "none"})`);
    } catch (e) {
      if (e instanceof ApiError && e.kind === "auth") { console.error("CoinGecko rejected the API key (COINGECKO_DEMO_KEY). Nothing was changed. " + e.message); return 1; }
      failed.push(`${coin}: skipped, ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // The forecasts logged so far: the 7-day chance of a rise for each coin, by the day it was made from.
  const chance: Record<string, Record<string, number>> = {}; // day -> coin -> chance
  const signals: Signals = {}; // coin -> day -> chance
  const notes: string[] = [];
  try {
    const PRIMARY = (await loadModelConfig()).primary;
    for (const r of await loadLog()) if (r.h === 7) { (chance[r.date] ??= {})[r.coin] = r[PRIMARY]; (signals[r.coin] ??= {})[r.date] = r[PRIMARY]; }
  } catch (e) { notes.push(`The forecast log can't be read, so the model strategies wait: ${(e as Error).message}`); }

  const r = advance(state, prices, config, signals);
  const tradedDays = Object.values(r.days).reduce((n, d) => n + d.length, 0);
  if (added) await saveJson(join(DIR, "prices.json"), prices);
  if (tradedDays) { await saveJson(join(DIR, "state.json"), r.state); await saveJson(join(DIR, "trades.json"), [...log, ...r.trades]); }

  // The weekly top-k portfolio, on the scan's own price files.
  let pf: PortfolioState | null = null, pfTrades: PortfolioTrade[] = [], pfDays: string[] = [];
  if (config.portfolio) {
    try {
      const pfState = await loadJson<PortfolioState>(join(DIR, "portfolio.json"), emptyPortfolio());
      const pfLog = await loadJson<PortfolioTrade[]>(join(DIR, "portfolio-trades.json"), []);
      const scans = await loadJson<ScanHistory>(join(SCAN, "history.json"), { days: [] });
      const daySignals: Record<string, DaySignals> = {};
      for (const d of scans.days) {
        if (!chance[d.date]) continue; // the ranking needs both the scan and the forecast of that day
        const s: DaySignals = { composite: {}, mcapRank: {}, p: chance[d.date] };
        for (const [id, row] of Object.entries(d.coins)) { s.composite[id] = row[1]; s.mcapRank[id] = row[7] ?? null; }
        daySignals[d.date] = s;
      }
      const closes = Object.fromEntries([...(await loadHistories())].map(([id, h]) => [id, { dates: h.dates.filter(d => d < today), closes: h.closes.slice(0, h.dates.filter(d => d < today).length) }]));
      const a = advancePortfolio(pfState, closes, daySignals, config);
      pf = a.state; pfTrades = a.trades; pfDays = a.days;
      notes.push(...a.notes);
      if (a.days.length) { await saveJson(join(DIR, "portfolio.json"), a.state); await saveJson(join(DIR, "portfolio-trades.json"), [...pfLog, ...a.trades]); }
    } catch (e) { failed.push(`portfolio: skipped, ${e instanceof Error ? e.message : String(e)}`); }
  }

  const lines: string[] = [];
  lines.push(`## Paper trading, run on ${today}`);
  lines.push(tradedDays ? `Traded ${Object.entries(r.days).map(([c, d]) => `${c} ${d.join(", ")}`).join("; ")}. ${r.trades.length} trade${r.trades.length === 1 ? "" : "s"}.` : "Nothing new to trade (every finished day was already traded).");
  for (const n of [...failed, ...r.notes, ...notes]) lines.push(`- ${n}`);
  if (r.state.startDate) {
    lines.push("", `Started ${r.state.startDate}, ${daysOfData(r.state)} day(s) of data, last close traded ${r.state.lastDate}. All coins together:`, "");
    lines.push("| Strategy | Since | Value | Return | Worst drop | Trades | vs buy and hold, same days |", "|---|---|---:|---:|---:|---:|---:|");
    const strategies = [...new Set([...config.strategies, ...Object.values(r.state.coins).flatMap(cs => Object.values(cs.pairs).map(p => p!.strategy))])];
    for (const row of board(curves(r.state, null, strategies))) {
      lines.push(`| ${row.name} | ${row.since} | ${eur(row.value)} of ${eur(row.capital)} | ${pct(row.ret)} | ${(row.mdd * 100).toFixed(2)}% | ${row.trades} | ${pts(row.vsHold)} |`);
    }
  }
  if (r.trades.length) {
    lines.push("", "| Date | Coin | Strategy | Side | Price | Fee | Reason |", "|---|---|---|---|---:|---:|---|");
    for (const t of r.trades) lines.push(`| ${t.date} | ${t.coin} | ${t.strategy} | ${t.side} | ${eur(t.price)} | ${eur(t.fee)} | ${t.reason} |`);
  }
  if (pf?.startDate) {
    lines.push("", `### Portfolio (started ${pf.startDate}, last close ${pf.lastDate}${pfDays.length ? "" : ", nothing new"})`, pf.decision ? `Last weekly decision (${pf.decision.date}, from the ranking of ${pf.decision.rankedOn}): ${pf.decision.note}${pf.decision.picks.length ? " " + pf.decision.picks.map(p => p.coin).join(", ") + "." : ""}` : "", "");
    lines.push("| Portfolio | Value | Return | Worst drop | Trades | vs Bitcoin | vs equal weight |", "|---|---:|---:|---:|---:|---:|---:|");
    for (const row of portfolioBoard(pf)) lines.push(`| ${row.name} | ${eur(row.value)} | ${pct(row.ret)} | ${(row.mdd * 100).toFixed(2)}% | ${row.trades} | ${pts(row.vsBtc)} | ${pts(row.vsEqual)} |`);
    const shown = pfTrades.filter(t => t.book === "topk");
    if (shown.length) {
      lines.push("", "| Date | Coin | Side | Price | Amount | Reason |", "|---|---|---|---:|---:|---|");
      for (const t of shown) lines.push(`| ${t.date} | ${t.coin} | ${t.side} | ${eur(t.price)} | ${eur(t.amount)} | ${t.reason} |`);
    }
  }
  await report(lines.join("\n"));
  for (const f of failed) console.log(`::warning::${f}`);
  return failed.filter(f => !f.startsWith("portfolio")).length === config.coins.length ? 1 : 0;
}

main().then(code => process.exit(code), e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
