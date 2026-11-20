/**
 * The nightly summary message (sent to Telegram by scripts/notify.ts): one message a night, and only when
 * something happened that is worth a look. Pure function: no network, no files, no clock.
 *
 * What counts: a tracked coin's classification changed, a tracked coin moved more than twice its usual
 * daily move, the model's 7-day chance for a tracked coin crossed the trading threshold, or a paper
 * strategy traded.
 */
import type { PortfolioTrade } from "../paper/portfolio";
import type { PaperStrategy, TradeRecord } from "../paper/types";
import type { ScanFile } from "../scan/types";

export interface AlertInput {
  /** Tonight's scan (null when it failed). */
  scan: ScanFile | null;
  /** The coins alerts are sent for: the watchlist in public/data/scan/config.json. */
  tracked: string[];
  /** The model's 7-day chance of a rise per coin, tonight and the night before (null when there is no forecast). */
  chance: Record<string, number> | null;
  chanceBefore: Record<string, number> | null;
  /** The chance above which the paper "model" strategy holds a coin. */
  threshold: number;
  /** Tonight's paper trades: the per-coin strategies and the top-k portfolio. */
  trades: TradeRecord[];
  portfolioTrades: PortfolioTrade[];
  strategyName: (s: PaperStrategy) => string;
  /** A link to the app, added at the end. */
  link?: string;
}

export interface Alert {
  /** The message, or null when nothing happened. */
  text: string | null;
  events: number;
}

const day = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const money = (v: number) => "€" + (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-IE") : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(4));
const pct = (v: number) => (v * 100).toFixed(0) + "%";
const title = (id: string) => id.replace(/(^|-)([a-z])/g, (_, a, b) => (a ? " " : "") + b.toUpperCase());
/** Telegram messages can hold 4,096 characters. */
const LIMIT = 3800;

export function buildAlert(a: AlertInput): Alert {
  const tracked = new Set(a.tracked);
  const names = new Map((a.scan?.coins ?? []).map(c => [c.id, c.name] as const));
  const name = (id: string) => names.get(id) ?? title(id);
  const coinLines: string[] = [], tradeLines: string[] = [];

  for (const c of a.scan?.changes ?? []) if (tracked.has(c.id) && (c.kind === "cls" || c.kind === "move")) coinLines.push(`• ${c.name}: ${c.text}`);
  if (a.chance && a.chanceBefore) {
    for (const id of a.tracked) {
      const now = a.chance[id], was = a.chanceBefore[id];
      if (now == null || was == null || (now > a.threshold) === (was > a.threshold)) continue;
      coinLines.push(`• ${name(id)}: the model's 7-day chance of a rise ${now > a.threshold ? "rose above" : "fell to or below"} ${pct(a.threshold)} (${pct(was)} → ${pct(now)})`);
    }
  }
  for (const t of a.trades) tradeLines.push(`• ${name(t.coin)}, ${a.strategyName(t.strategy)}: ${t.side === "buy" ? "bought" : "sold"} at ${money(t.price)}`);
  const pf = a.portfolioTrades.filter(t => t.book === "topk");
  if (pf.length) {
    const list = (side: "buy" | "sell") => [...new Set(pf.filter(t => t.side === side).map(t => name(t.coin)))].join(", ");
    const bought = list("buy"), sold = list("sell");
    tradeLines.push(`• Top-k portfolio: ${[sold && "sold " + sold, bought && "bought " + bought].filter(Boolean).join("; ")}`);
  }

  const events = coinLines.length + tradeLines.length;
  if (!events) return { text: null, events: 0 };
  const date = a.scan?.date ?? a.trades[0]?.date ?? a.portfolioTrades[0]?.date;
  const parts = [`Crypto Risk Lab · closes of ${date ? day(date) : "last night"}`];
  if (coinLines.length) parts.push("", "Tracked coins", ...coinLines);
  if (tradeLines.length) parts.push("", "Paper trades (fake money)", ...tradeLines);
  if (a.link) parts.push("", a.link);
  let text = parts.join("\n");
  if (text.length > LIMIT) text = text.slice(0, LIMIT).replace(/\n[^\n]*$/, "") + "\n… (more in the app)" + (a.link ? "\n" + a.link : "");
  return { text, events };
}
