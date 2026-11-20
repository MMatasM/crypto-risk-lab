/**
 * The coins of the long-term test: every Bitvavo EUR market that isn't a stablecoin or a wrapped copy, each
 * from its first day there. Pure functions.
 */
import type { History } from "../data/types";
import type { BitvavoIndex } from "./bitvavo";

/** A market with no trades for longer than this many days was suspended (a token swap, a relisting). */
export const MAX_GAP_DAYS = 7;

const dayMs = (d: string) => Date.parse(d + "T00:00:00Z");

/**
 * A history cut where the market was suspended, oldest part first. The price after a suspension often can't
 * be compared with the price before (a 1:10 token swap looks like a 90% crash), so each part is treated as
 * a coin of its own: no return is ever measured across the break.
 */
export function splitAtGaps(h: History, maxGap = MAX_GAP_DAYS): History[] {
  const out: History[] = [];
  let from = 0;
  for (let i = 1; i <= h.dates.length; i++) {
    if (i < h.dates.length && (dayMs(h.dates[i]) - dayMs(h.dates[i - 1])) / 864e5 - 1 <= maxGap) continue;
    out.push({ dates: h.dates.slice(from, i), closes: h.closes.slice(from, i), volumes: h.volumes.slice(from, i) });
    from = i;
  }
  return out;
}

export interface ResearchCoin {
  /** The key used in the test: the CoinGecko id for scanned coins ("bitcoin"), otherwise the Bitvavo ticker; an older part of a suspended market ends in ~1, ~2, … */
  id: string;
  market: string;
  name: string;
  /** In tonight's scan of the top coins (so: a survivor). */
  scan: boolean;
  from: string;
  to: string;
  days: number;
}

export interface Universe { histories: Map<string, History>; coins: ResearchCoin[]; split: string[] }

/** The test's coins from the downloaded markets. Bitcoin is always keyed "bitcoin" (the model's market-mood inputs need it). */
export function buildUniverse(index: BitvavoIndex, raw: ReadonlyMap<string, History>): Universe {
  const scanId = new Map(index.scan.matched.map(m => [m.market, m.id] as const));
  const histories = new Map<string, History>(), coins: ResearchCoin[] = [], split: string[] = [];
  for (const m of index.markets) {
    const h = raw.get(m.market);
    if (m.noise || !h?.dates.length) continue;
    const base = m.market === "BTC" ? "bitcoin" : scanId.get(m.market) ?? m.market;
    const parts = splitAtGaps(h);
    if (parts.length > 1) split.push(m.market);
    parts.forEach((part, k) => {
      const older = parts.length - 1 - k, id = older ? `${base}~${older}` : base;
      histories.set(id, part);
      coins.push({ id, market: m.market, name: m.name, scan: !older && (scanId.has(m.market) || m.market === "BTC"), from: part.dates[0], to: part.dates[part.dates.length - 1], days: part.dates.length });
    });
  }
  return { histories, coins, split };
}
