/**
 * The nightly Telegram summary: one message, and only when something happened (see src/alerts/summary.ts).
 * Run by the nightly workflow after paper trading.
 *
 *   npm run notify        (locally it only prints the message, unless the two variables below are set)
 *
 * Needs two repository secrets, TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (README.md explains how to get
 * them). Without them nothing is sent and the run still succeeds. The same night is never sent twice.
 */
import { join } from "node:path";
import { buildAlert } from "../src/alerts/summary";
import type { PortfolioState, PortfolioTrade } from "../src/paper/portfolio";
import { strategyName } from "../src/paper/summary";
import { MODEL_THRESHOLD } from "../src/paper/trader";
import type { PaperConfig, PaperState, TradeRecord } from "../src/paper/types";
import type { ScanConfig, ScanFile } from "../src/scan/types";
import { loadLog, loadModelConfig } from "./lib/data";
import { loadJson, saveJson } from "./lib/io";

const PAPER = process.env.PAPER_DIR || join("public", "paper");
const SCAN = process.env.SCAN_DIR || join("public", "data", "scan");
const STATE = join("data", "notify.json");
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim(), CHAT = (process.env.TELEGRAM_CHAT_ID ?? "").trim();

/** Sends one message. Returns why it failed, or null. The token is never printed. */
async function send(text: string): Promise<string | null> {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true }),
  });
  if (res.ok) return null;
  const why = await res.json().then((j: { description?: string }) => j.description, () => undefined);
  return `Telegram refused the message (${res.status}${why ? ": " + why : ""}). Check the two secrets.`;
}

async function main(): Promise<number> {
  // "Run workflow" with the test box ticked: send a test message whatever happened tonight.
  if (process.env.NOTIFY_TEST === "true") {
    if (!TOKEN || !CHAT) { console.error("Telegram isn't set up: add the secrets TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID first (see README.md)."); return 1; }
    const failed = await send("Crypto Risk Lab: test message. Telegram is set up; the nightly summary will arrive here on nights when something happens.");
    if (failed) { console.error(failed); return 1; }
    console.log("Test message sent to Telegram.");
    return 0;
  }
  const scan = await loadJson<ScanFile | null>(join(SCAN, "latest.json"), null);
  const scanConfig = await loadJson<ScanConfig | null>(join(SCAN, "config.json"), null);
  const paperConfig = await loadJson<PaperConfig | null>(join(PAPER, "config.json"), null);
  const paper = await loadJson<PaperState | null>(join(PAPER, "state.json"), null);
  const trades = await loadJson<TradeRecord[]>(join(PAPER, "trades.json"), []);
  const portfolio = await loadJson<PortfolioState | null>(join(PAPER, "portfolio.json"), null);
  const portfolioTrades = await loadJson<PortfolioTrade[]>(join(PAPER, "portfolio-trades.json"), []);
  const sent = await loadJson<{ lastDate: string | null }>(STATE, { lastDate: null });

  // The newest close anything was done for. A night is only ever reported once.
  const date = [scan?.date, paper?.lastDate, portfolio?.lastDate].filter((d): d is string => !!d).sort().pop();
  if (!date) { console.log("Nothing to report yet."); return 0; }
  if (sent.lastDate && date <= sent.lastDate) { console.log(`The night of ${date} was already reported.`); return 0; }

  const chance: Record<string, Record<string, number>> = {};
  try { const PRIMARY = (await loadModelConfig()).primary; for (const r of await loadLog()) if (r.h === 7) (chance[r.date] ??= {})[r.coin] = r[PRIMARY]; }
  catch (e) { console.log(`::warning::The forecast log can't be read: ${(e as Error).message}`); }
  const nights = Object.keys(chance).sort(), tonight = scan && chance[scan.date] ? scan.date : null;
  const before = tonight ? nights.filter(d => d < tonight).pop() : undefined;
  const repo = process.env.GITHUB_REPOSITORY?.split("/");

  const alert = buildAlert({
    scan: scan?.date === date ? scan : null,
    tracked: scanConfig?.watchlist ?? [],
    chance: tonight && scan?.date === date ? chance[tonight] : null,
    chanceBefore: before ? chance[before] : null,
    threshold: paperConfig?.settings.modelThreshold ?? MODEL_THRESHOLD,
    trades: trades.filter(t => t.date === date),
    portfolioTrades: portfolioTrades.filter(t => t.date === date),
    strategyName: s => (paperConfig ? strategyName(s, paperConfig.settings) : s),
    link: repo?.length === 2 ? `https://${repo[0].toLowerCase()}.github.io/${repo[1]}/#signals` : undefined,
  });

  if (!alert.text) { console.log(`Nothing worth a message for the night of ${date}.`); await saveJson(STATE, { lastDate: date }); return 0; }
  console.log(alert.text);
  if (!TOKEN || !CHAT) { console.log("\nTelegram isn't set up (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID), so nothing was sent. See README.md."); return 0; }
  const failed = await send(alert.text);
  if (failed) { console.error(failed); return 1; }
  await saveJson(STATE, { lastDate: date });
  console.log(`\nSent to Telegram (${alert.events} item${alert.events === 1 ? "" : "s"}).`);
  return 0;
}

main().then(code => process.exit(code), e => { console.error(e instanceof Error ? e.message.replace(TOKEN || "\u0000", "***") : e); process.exit(1); });
