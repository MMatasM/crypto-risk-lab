/**
 * The daily paper trading job: fetches daily closes from CoinGecko, trades every finished day not yet
 * traded, and saves the files in public/paper/. Safe to run any number of times.
 *
 *   npm run paper                      (locally; uses the keyless limit unless COINGECKO_DEMO_KEY is set)
 *
 * Run by .github/workflows/paper-trading.yml every night. Exit code 1 only when nothing could be done
 * (a bad config, a rejected key, or every coin failing); a single failing coin is skipped and retried next run.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError, CoinGeckoClient } from "../src/data/coingecko";
import { parseMarketChart } from "../src/data/repository";
import { board, curves, daysOfData } from "../src/paper/summary";
import { advance, checkConfig, mergeCloses } from "../src/paper/trader";
import { emptyState, type PaperConfig, type PaperState, type PriceFile, type TradeRecord } from "../src/paper/types";

const DIR = process.env.PAPER_DIR || join("public", "paper");
const KEY = (process.env.COINGECKO_DEMO_KEY ?? "").trim();
const today = new Date().toISOString().slice(0, 10); // UTC day: its close isn't final yet, so it is never traded

async function load<T>(name: string, fallback: T | undefined): Promise<T> {
  try { return JSON.parse(await readFile(join(DIR, name), "utf8")) as T; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && fallback !== undefined) return fallback;
    throw new Error(`Can't read ${join(DIR, name)}: ${(e as Error).message}`);
  }
}

/** JSON that stays readable in git: objects indented, lists of numbers or words on one line, one trade per line. */
function stringify(v: unknown, indent = ""): string {
  if (Array.isArray(v)) {
    if (v.every(x => x === null || typeof x !== "object")) return JSON.stringify(v);
    return "[\n" + v.map(x => indent + "  " + JSON.stringify(x)).join(",\n") + "\n" + indent + "]";
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v);
    if (!entries.length) return "{}";
    return "{\n" + entries.map(([k, x]) => `${indent}  ${JSON.stringify(k)}: ${stringify(x, indent + "  ")}`).join(",\n") + "\n" + indent + "}";
  }
  return JSON.stringify(v);
}

/** Write to a temporary file first, so a crash can never leave half a file. */
async function save(name: string, data: unknown) {
  const path = join(DIR, name), tmp = path + ".tmp";
  await writeFile(tmp, stringify(data) + "\n", "utf8");
  await rename(tmp, path);
}

const eur = (v: number) => "€" + (Math.abs(v) >= 10 ? v.toFixed(2) : v.toPrecision(4));
const pct = (v: number) => (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%";
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

async function main(): Promise<number> {
  const config = await load<PaperConfig>("config.json", undefined);
  const bad = checkConfig(config);
  if (bad.length) { console.error("config.json has problems:\n- " + bad.join("\n- ")); return 1; }
  const prices = await load<PriceFile>("prices.json", {});
  const state = await load<PaperState>("state.json", emptyState());
  const log = await load<TradeRecord[]>("trades.json", []);

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

  const r = advance(state, prices, config);
  const tradedDays = Object.values(r.days).reduce((n, d) => n + d.length, 0);
  await mkdir(DIR, { recursive: true });
  if (added) await save("prices.json", prices);
  if (tradedDays) { await save("state.json", r.state); await save("trades.json", [...log, ...r.trades]); }

  const lines: string[] = [];
  lines.push(`## Paper trading, run on ${today}`);
  lines.push(tradedDays ? `Traded ${Object.entries(r.days).map(([c, d]) => `${c} ${d.join(", ")}`).join("; ")}. ${r.trades.length} trade${r.trades.length === 1 ? "" : "s"}.` : "Nothing new to trade (every finished day was already traded).");
  for (const n of [...failed, ...r.notes]) lines.push(`- ${n}`);
  if (r.state.startDate) {
    lines.push("", `Started ${r.state.startDate}, ${daysOfData(r.state)} day(s) of data, last close traded ${r.state.lastDate}. All coins together:`, "");
    lines.push("| Strategy | Value | Return | Worst drop | Trades | vs buy and hold |", "|---|---:|---:|---:|---:|---:|");
    for (const row of board(curves(r.state, null, config.strategies))) {
      lines.push(`| ${row.name} | ${eur(row.value)} of ${eur(row.capital)} | ${pct(row.ret)} | ${(row.mdd * 100).toFixed(2)}% | ${row.trades} | ${row.vsHold == null ? "(baseline)" : (row.vsHold >= 0 ? "+" : "") + (row.vsHold * 100).toFixed(2) + " pts"} |`);
    }
  }
  if (r.trades.length) {
    lines.push("", "| Date | Coin | Strategy | Side | Price | Fee | Reason |", "|---|---|---|---|---:|---:|---|");
    for (const t of r.trades) lines.push(`| ${t.date} | ${t.coin} | ${t.strategy} | ${t.side} | ${eur(t.price)} | ${eur(t.fee)} | ${t.reason} |`);
  }
  const report = lines.join("\n");
  console.log("\n" + report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report + "\n");
  for (const f of failed) console.log(`::warning::${f}`);
  return failed.length === config.coins.length ? 1 : 0;
}

main().then(code => process.exit(code), e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
