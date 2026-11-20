/**
 * The nightly market scan: fetches the newest daily closes for the top coins and the watchlist, saves them
 * in data/history/, and writes the ranked list (public/data/scan/latest.json) with what changed since the
 * scan before. Safe to run any number of times.
 *
 *   npm run scan          (locally; uses the slow keyless limit unless COINGECKO_DEMO_KEY is set)
 *
 * CoinGecko calls per run: 1 for the market list, 1 per coin for its newest days (about 155), and once a
 * week 7 more for the sector lists. Roughly 5,000 a month, half of the free Demo key's 10,000.
 */
import { join } from "node:path";
import { ApiError, CoinGeckoClient } from "../src/data/coingecko";
import { parseMarketChart, slimCoin } from "../src/data/repository";
import type { History, MarketCoin } from "../src/data/types";
import type { PaperConfig } from "../src/paper/types";
import { daysBetween, daysToFetch, mergeHistory, parseCsv, toCsv } from "../src/scan/history";
import { addDay, checkScanConfig, dayBefore, diff, pickUniverse, rank, scanCoin } from "../src/scan/scan";
import { SECTORS, type ScanCoin, type ScanConfig, type ScanFile, type ScanHistory, type SectorFile } from "../src/scan/types";
import { loadJson, loadText, report, saveJson, saveText, utcToday } from "./lib/io";

const HIST = process.env.HISTORY_DIR || join("data", "history");
const OUT = process.env.SCAN_DIR || join("public", "data", "scan");
const PAPER = process.env.PAPER_DIR || join("public", "paper");
const KEY = (process.env.COINGECKO_DEMO_KEY ?? "").trim();
const today = utcToday();
const MARKET_FIELDS = "vs_currency=eur&per_page=250&price_change_percentage=7d,30d,1y";
const SECTOR_REFRESH_DAYS = 7;
/** Fetching stops after this many minutes (the keyless limit can be very slow); coins not reached are caught up on the next run. */
const BUDGET_MIN = Number(process.env.SCAN_MINUTES) || 100;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pct = (v: number | null) => (v == null ? "—" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%");

async function main(): Promise<number> {
  const config = await loadJson<ScanConfig>(join(OUT, "config.json"));
  const bad = checkScanConfig(config);
  if (bad.length) { console.error("public/data/scan/config.json has problems:\n- " + bad.join("\n- ")); return 1; }
  const last = await loadJson<ScanFile | null>(join(OUT, "latest.json"), null);
  const hist = await loadJson<ScanHistory>(join(OUT, "history.json"), { days: [] });
  let sectors = await loadJson<SectorFile | null>(join("data", "sectors.json"), null);
  const paper = await loadJson<PaperConfig | null>(join(PAPER, "config.json"), null);
  const portfolio = await loadJson<{ books?: Record<string, { units: Record<string, number> }> } | null>(join(PAPER, "portfolio.json"), null);

  console.log(`Market scan for closes before ${today} (UTC). CoinGecko: ${KEY ? "Demo key" : "no key (slow keyless limit)"}.`);
  let calls = 0, lastStatus = "";
  const client = new CoinGeckoClient({ getKey: () => KEY, onStatus: t => { if (/Retrying|rate limit/i.test(t) && t !== lastStatus) console.log("  " + (lastStatus = t)); } });
  const get = <T>(path: string) => { calls++; return client.get<T>(path); };
  const authFail = (e: unknown) => e instanceof ApiError && e.kind === "auth";

  // 1. The market list (top 250), and the watched coins that aren't in it.
  let markets: MarketCoin[];
  try { markets = (await get<Record<string, unknown>[]>(`/coins/markets?${MARKET_FIELDS}&order=market_cap_desc&page=1`)).map(slimCoin); }
  catch (e) { console.error("Couldn't load the market list from CoinGecko. Nothing was changed. " + msg(e)); return 1; }
  const held = Object.values(portfolio?.books ?? {}).flatMap(b => Object.keys(b.units));
  const forced = [...new Set([...config.watchlist, ...(paper?.coins ?? []), ...held])];
  const extra = forced.filter(id => !markets.some(m => m.id === id));
  if (extra.length) {
    try { markets.push(...(await get<Record<string, unknown>[]>(`/coins/markets?${MARKET_FIELDS}&ids=${extra.map(encodeURIComponent).join(",")}`)).map(slimCoin)); }
    catch (e) { if (authFail(e)) { console.error(msg(e)); return 1; } console.log(`::warning::Couldn't load market data for ${extra.join(", ")}: ${msg(e)}`); }
  }
  const byId = new Map(markets.map(m => [m.id, m] as const));
  const universe = pickUniverse(markets, config.topN, forced, last?.coins.map(c => c.id) ?? []).filter(id => byId.has(id));
  console.log(`Scanning ${universe.length} coins (top ${config.topN} by market cap plus ${forced.length} watched or held).`);

  // 2. Each coin's newest days.
  const histories = new Map<string, History>();
  const skipped: ScanFile["skipped"] = [];
  let added = 0, failed = 0, unreached = 0;
  const deadline = Date.now() + BUDGET_MIN * 60e3;
  for (const [i, id] of universe.entries()) {
    const path = join(HIST, id + ".csv");
    let saved: History | undefined;
    try { const text = await loadText(path); if (text) saved = parseCsv(text); }
    catch (e) { skipped.push({ id, name: byId.get(id)!.name, why: `its saved history can't be read (${msg(e)})` }); failed++; continue; }
    // Already has yesterday's close (an earlier run today): nothing newer can exist, so no call is spent.
    if (saved && daysBetween(saved.dates[saved.dates.length - 1], today) <= 1) { histories.set(id, saved); continue; }
    if (Date.now() > deadline) { unreached++; if (saved) histories.set(id, saved); continue; }
    try {
      const fetched = parseMarketChart(await get(`/coins/${encodeURIComponent(id)}/market_chart?vs_currency=eur&days=${daysToFetch(saved, today)}&interval=daily`));
      const m = mergeHistory(saved, fetched, today);
      if (m.problem) { failed++; console.log(`::warning::${id}: new prices refused, ${m.problem}`); }
      else if (m.added) { await saveText(path, toCsv(m.history)); added += m.added; saved = m.history; }
    } catch (e) {
      if (authFail(e)) { console.error("CoinGecko rejected the API key (COINGECKO_DEMO_KEY). " + msg(e)); return 1; }
      failed++;
      console.log(`::warning::${id}: couldn't fetch new prices, ${msg(e)}`);
    }
    if (saved) histories.set(id, saved);
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1} of ${universe.length} coins fetched…`);
  }

  if (unreached) console.log(`::warning::Ran out of time after ${BUDGET_MIN} minutes: ${unreached} coins were not fetched tonight. A free CoinGecko Demo key (see README.md) makes the scan about ten times faster.`);

  // 3. Sector lists, once a week.
  if (!unreached && (!sectors || daysBetween(sectors.at, today) >= SECTOR_REFRESH_DAYS)) {
    try {
      const coins: Record<string, string[]> = {};
      for (const [key] of SECTORS) {
        const list = await get<Record<string, unknown>[]>(`/coins/markets?${MARKET_FIELDS}&order=market_cap_desc&page=1&category=${encodeURIComponent(key)}`);
        for (const m of list) (coins[String(m.id)] ??= []).push(key);
      }
      sectors = { at: today, coins };
      await saveJson(join("data", "sectors.json"), sectors);
    } catch (e) { console.log(`::warning::Couldn't refresh the sector lists (keeping the old ones): ${msg(e)}`); }
  }

  // 4. Scores, ranking, changes.
  const btc = histories.get("bitcoin");
  const date = btc?.dates[btc.dates.length - 1];
  if (!btc || !date) { console.error("No Bitcoin prices, so nothing can be scanned."); return 1; }
  if (daysBetween(date, today) > 3) { console.error(`The newest Bitcoin close is ${date}; CoinGecko has no fresh prices. The scan was not updated.`); return 1; }
  const watch = new Set(config.watchlist);
  const coins: ScanCoin[] = [];
  for (const id of universe) {
    const h = histories.get(id), m = byId.get(id)!;
    if (!h) { if (!skipped.some(s => s.id === id)) skipped.push({ id, name: m.name, why: "no prices could be fetched" }); continue; }
    const lastDay = h.dates[h.dates.length - 1];
    if (lastDay !== date) { skipped.push({ id, name: m.name, why: `no fresh prices (its newest close is ${lastDay})` }); continue; }
    const row = scanCoin(h, btc, m, { sectors: sectors?.coins[id] ?? [], watch: watch.has(id) });
    if (typeof row === "string") skipped.push({ id, name: m.name, why: row }); else coins.push(row);
  }
  if (coins.length < universe.length / 2) { console.error(`Only ${coins.length} of ${universe.length} coins have fresh prices. The scan was not updated; the next run will try again.`); return 1; }
  rank(coins);
  const prev = dayBefore(hist, date);
  const changes = diff(prev, coins);
  for (const c of changes) if (c.kind === "gone") c.name = last?.coins.find(x => x.id === c.id)?.name ?? c.id;

  const fresh = added > 0 || last?.date !== date || coins.length !== last.coins.length;
  if (fresh) {
    const file: ScanFile = { date, previousDate: prev?.date ?? null, generatedAt: new Date().toISOString(), coins, skipped, changes };
    await saveJson(join(OUT, "latest.json"), file);
    await saveJson(join(OUT, "history.json"), addDay(hist, date, coins, config.historyDays));
  }

  const lines = [`## Market scan, closes of ${date}`];
  lines.push(`${fresh ? "Scanned" : "Nothing new: already scanned"} ${coins.length} coins, ${added} new daily closes saved, ${calls} CoinGecko calls.${failed ? ` ${failed} fetches failed.` : ""}${skipped.length ? ` ${skipped.length} skipped.` : ""}`);
  lines.push("", "| # | Coin | Composite | Risk | Trend | Class | Technicals | 7d | 30d |", "|---:|---|---:|---:|---:|---|---|---:|---:|");
  for (const c of coins.filter(c => c.rank <= 10 || c.watch)) lines.push(`| ${c.rank} | ${c.name}${c.watch ? " ★" : ""} | ${c.composite} | ${c.risk} | ${c.trend} | ${c.cls.t} | ${c.cons.t} | ${pct(c.ret7)} | ${pct(c.ret30)} |`);
  const shown = changes.filter(c => c.watch || c.kind === "cls").slice(0, 25);
  if (shown.length) lines.push("", `**What changed since ${prev?.date ?? "the scan before"}** (${changes.length} in all)`, ...shown.map(c => `- ${c.watch ? "★ " : ""}${c.name}: ${c.text}`));
  if (skipped.length) lines.push("", "**Skipped**", ...skipped.slice(0, 20).map(s => `- ${s.name}: ${s.why}`));
  await report(lines.join("\n"));
  return 0;
}

main().then(code => process.exit(code), e => { console.error(msg(e)); process.exit(1); });
