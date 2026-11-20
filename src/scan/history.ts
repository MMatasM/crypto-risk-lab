/**
 * Each coin's daily history as a small CSV file (date,close,volume), kept in the repository so the nightly
 * job only has to fetch the newest days. Pure functions: no network, no files.
 */
import type { History } from "../data/types";
import { mergeCloses } from "../paper/trader";

const HEADER = "date,close,volume";

export function toCsv(h: History): string {
  const lines = [HEADER];
  for (let i = 0; i < h.dates.length; i++) lines.push(`${h.dates[i]},${h.closes[i]},${Math.round(h.volumes[i] ?? 0)}`);
  return lines.join("\n") + "\n";
}

/** Reads a history file. Throws on anything that isn't a date, a positive close and a volume, in date order. */
export function parseCsv(text: string): History {
  const h: History = { dates: [], closes: [], volumes: [] };
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines[0] !== HEADER) throw new Error(`expected the first line to be "${HEADER}"`);
  for (const line of lines.slice(1)) {
    const [d, c, v] = line.split(",");
    const close = Number(c), vol = Number(v);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !(close > 0) || !Number.isFinite(vol)) throw new Error(`a bad line: "${line}"`);
    if (h.dates.length && d <= h.dates[h.dates.length - 1]) throw new Error(`dates out of order at ${d}`);
    h.dates.push(d); h.closes.push(close); h.volumes.push(vol);
  }
  return h;
}

export interface HistoryMerge { history: History; added: number; problem: string | null }

/**
 * Adds freshly fetched days to the saved history. The same checks as paper trading (`mergeCloses`):
 * only finished days, saved days are never changed, and a fetch that disagrees with the saved closes
 * or jumps implausibly is refused (for a brand-new coin, only the days before such a jump are dropped).
 */
export function mergeHistory(saved: History | undefined, fetched: History, today: string): HistoryMerge {
  const base: History = saved ?? { dates: [], closes: [], volumes: [] };
  const m = mergeCloses(saved ? { dates: saved.dates, closes: saved.closes } : undefined, fetched, today);
  // A coin seen for the first time can have a glitch or a re-denomination somewhere in its past year. Rather
  // than refusing it every night, keep the days after the last such jump (a saved history stays strict).
  if (!saved && m.problem?.startsWith("an implausible jump")) {
    let cut = 0;
    for (let i = 1; i < fetched.closes.length; i++) { const r = fetched.closes[i] / fetched.closes[i - 1]; if (fetched.dates[i] < today && (r > 5 || r < 0.2)) cut = i; }
    if (cut > 0) return mergeHistory(undefined, { dates: fetched.dates.slice(cut), closes: fetched.closes.slice(cut), volumes: fetched.volumes.slice(cut) }, today);
  }
  if (m.problem || !m.added) return { history: base, added: 0, problem: m.problem };
  const vol = new Map(fetched.dates.map((d, i) => [d, fetched.volumes[i] ?? 0] as const));
  const volumes = [...base.volumes];
  for (let i = base.dates.length; i < m.closes.dates.length; i++) volumes.push(vol.get(m.closes.dates[i]) ?? 0);
  return { history: { dates: m.closes.dates, closes: m.closes.closes, volumes }, added: m.added, problem: null };
}

/** Days from date a to date b (YYYY-MM-DD). */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

/** How many days to ask CoinGecko for: a week of overlap with the saved days (to check against), a year the first time. */
export function daysToFetch(saved: History | undefined, today: string): number {
  const last = saved?.dates[saved.dates.length - 1];
  return last ? Math.min(365, Math.max(10, daysBetween(last, today) + 7)) : 365;
}
