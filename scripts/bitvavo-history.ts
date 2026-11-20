/**
 * Downloads the longest available daily EUR history of every Bitvavo market, for research and backtests.
 * It uses ONLY Bitvavo's public market-data endpoints: no API key, no account, no orders.
 * The nightly run doesn't call this and doesn't read its files.
 *
 *   npm run bitvavo            (a later run only adds the days since the last one)
 *
 * Files: data/bitvavo/<TICKER>.csv (date,close,volume in EUR, the same format as data/history/) and
 * data/bitvavo/index.json (what was fetched, what Bitvavo no longer lists, and which market each scanned coin is).
 */
import { join } from "node:path";
import { candlesToHistory, extendHistory, isNoiseMarket, mapScanCoins, yearsOf, type BitvavoIndex, type Candle } from "../src/research/bitvavo";
import type { History } from "../src/data/types";
import { parseCsv, toCsv } from "../src/scan/history";
import type { ScanFile } from "../src/scan/types";
import { loadHistories } from "./lib/data";
import { loadJson, loadText, report, saveJson, saveText, utcToday } from "./lib/io";

const API = "https://api.bitvavo.com/v2";
const OUT = process.env.BITVAVO_DIR || join("data", "bitvavo");
const PAGE = 1440; // the most candles one call returns
/** Bitvavo allows 1,000 weight points a minute per IP. This script stays far below: it pauses when under this many are left. */
const KEEP_FREE = 300;
const PAUSE_MS = 120;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let calls = 0;

/** One public GET, paced by Bitvavo's own rate-limit headers, with a few patient retries. */
async function get<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    calls++;
    let res: Response;
    try { res = await fetch(API + path, { headers: { accept: "application/json" } }); }
    catch (e) { if (attempt >= 4) throw e; await sleep(2000 * (attempt + 1)); continue; }
    const left = Number(res.headers.get("bitvavo-ratelimit-remaining")), reset = Number(res.headers.get("bitvavo-ratelimit-resetat"));
    if (res.status === 429 || (Number.isFinite(left) && left < KEEP_FREE)) {
      const wait = Number.isFinite(reset) && reset > Date.now() ? Math.min(65e3, reset - Date.now() + 500) : 61e3;
      console.log(`  rate limit: ${Number.isFinite(left) ? left : "?"} points left, waiting ${Math.ceil(wait / 1000)}s`);
      await sleep(wait);
    } else await sleep(PAUSE_MS);
    if (res.ok) return await res.json() as T;
    if (res.status !== 429 && res.status < 500) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    if (attempt >= 4) throw new Error(`${res.status} after ${attempt + 1} tries`);
    await sleep(3000 * (attempt + 1));
  }
}

/** Every daily candle of a market from `sinceMs` on, paging backwards from now. */
async function allCandles(market: string, sinceMs: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let end: number | null = null;
  for (let page = 0; page < 20; page++) {
    const batch: Candle[] = await get<Candle[]>(`/${market}/candles?interval=1d&limit=${PAGE}${end == null ? "" : `&end=${end}`}`);
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    const oldest = Math.min(...batch.map(c => c[0]));
    if (batch.length < PAGE || oldest <= sinceMs || (end != null && oldest >= end)) break;
    end = oldest;
  }
  return out;
}

interface Market { market: string; status: string; base: string; quote: string }
interface Asset { symbol: string; name: string; depositStatus: string; withdrawalStatus: string }

async function main(): Promise<number> {
  const today = utcToday(), started = Date.now();
  console.log(`Bitvavo public daily candles, finished days before ${today} (UTC).`);
  const markets = (await get<Market[]>("/markets")).filter(m => m.quote === "EUR").sort((a, b) => (a.base < b.base ? -1 : 1));
  const assets = await get<Asset[]>("/assets");
  const nameOf = new Map(assets.map(a => [a.symbol, a.name] as const));
  console.log(`${markets.length} EUR markets listed (${markets.filter(m => m.status !== "trading").length} not trading), ${assets.length} assets named.`);

  const histories = new Map<string, History>();
  let added = 0, failed = 0;
  for (const [i, m] of markets.entries()) {
    const path = join(OUT, m.base + ".csv");
    try {
      const text = await loadText(path), saved = text ? parseCsv(text) : undefined;
      const last = saved?.dates[saved.dates.length - 1];
      if (last && Date.parse(today) - Date.parse(last) <= 864e5) { histories.set(m.base, saved!); continue; } // already has yesterday
      const h = extendHistory(saved, candlesToHistory(await allCandles(m.market, last ? Date.parse(last) : 0), today));
      if (!h.dates.length) { console.log(`  ${m.market}: no finished days yet`); continue; }
      if (h.dates.length !== (saved?.dates.length ?? 0)) { await saveText(path, toCsv(h)); added += h.dates.length - (saved?.dates.length ?? 0); }
      histories.set(m.base, h);
    } catch (e) { failed++; console.log(`::warning::${m.market}: ${(e as Error).message}`); }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1} of ${markets.length} markets (${calls} calls, ${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }

  // Which markets are stablecoins or wrapped copies (left out of the tests), by the scan's own filter.
  const usdc = histories.get("USDC"), usd = usdc ? usdc.closes[usdc.closes.length - 1] : 0.9;
  const listed = new Set(markets.map(m => m.base));
  const scan = await loadJson<ScanFile | null>(join("public", "data", "scan", "latest.json"), null);
  const mapping = mapScanCoins(scan?.coins ?? [], await loadHistories(), histories);
  const index: BitvavoIndex = {
    fetchedAt: new Date().toISOString(), through: today, source: `${API}/{market}/candles?interval=1d (public, no key)`,
    markets: markets.filter(m => histories.has(m.base)).map(m => {
      const h = histories.get(m.base)!, name = nameOf.get(m.base) ?? m.base;
      return { market: m.base, name, status: m.status, from: h.dates[0], to: h.dates[h.dates.length - 1], days: h.dates.length, noise: isNoiseMarket(m.base, name, h, usd) };
    }),
    delisted: assets.filter(a => !listed.has(a.symbol) && a.symbol !== "EUR").map(a => ({ symbol: a.symbol, name: a.name, status: a.depositStatus === a.withdrawalStatus ? a.depositStatus : `${a.depositStatus}/${a.withdrawalStatus}` })),
    scan: { date: scan?.date ?? "", ...mapping },
  };
  await saveJson(join(OUT, "index.json"), index);

  const real = index.markets.filter(m => !m.noise);
  const bucket = (lo: number, hi: number) => real.filter(m => { const y = yearsOf(histories.get(m.market)!); return y >= lo && y < hi; }).length;
  const lines = [`## Bitvavo long history, finished days before ${today}`,
    `${index.markets.length} EUR markets saved (${added} new days, ${calls} public calls, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(0)}s). ${index.markets.length - real.length} are stablecoins or wrapped copies and are left out of the tests.`,
    "", "| Years of history | Coins |", "|---|---:|",
    `| 7 or more | ${bucket(7, 99)} |`, `| 5 to 7 | ${bucket(5, 7)} |`, `| 3 to 5 | ${bucket(3, 5)} |`, `| 2 to 3 | ${bucket(2, 3)} |`, `| 1 to 2 | ${bucket(1, 2)} |`, `| under 1 | ${bucket(0, 1)} |`,
    "", `Scan coins (${scan?.coins.length ?? 0}): ${mapping.matched.length} trade on Bitvavo in EUR, ${mapping.unlisted.length + mapping.clash.length} don't.`,
    `Not on Bitvavo: ${[...mapping.unlisted, ...mapping.clash].map(c => `${c.name} (${c.symbol.toUpperCase()})`).join(", ") || "none"}.`,
    mapping.clash.length ? `Same ticker, different coin (not matched): ${mapping.clash.map(c => `${c.name} vs Bitvavo's ${c.market}`).join(", ")}.` : "",
    mapping.matched.some(c => c.how === "price") ? `Matched by price under another ticker: ${mapping.matched.filter(c => c.how === "price").map(c => `${c.name} = ${c.market}`).join(", ")}.` : "",
    `Assets Bitvavo names but no longer has an EUR market for (history gone from the public API): ${index.delisted.length}.`];
  await report(lines.filter(l => l !== "").join("\n"));
  return failed > markets.length / 2 ? 1 : 0;
}

main().then(code => process.exit(code), e => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
