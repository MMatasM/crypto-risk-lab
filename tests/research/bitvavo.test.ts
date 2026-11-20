import { describe, expect, it } from "vitest";
import type { History } from "../../src/data/types";
import { candlesToHistory, extendHistory, isNoiseMarket, mapScanCoins, priceMatch, yearsOf, type Candle } from "../../src/research/bitvavo";
import { dates, randomWalk } from "../helpers";

const ms = (d: string) => Date.parse(d + "T00:00:00Z");
const candle = (d: string, close: number, vol = 10): Candle => [ms(d), String(close), String(close), String(close), String(close), String(vol)];
const hist = (n: number, seed: number, from = "2025-01-01", start = 100): History => ({ dates: dates(n, from), closes: randomWalk(n, seed, start), volumes: new Array(n).fill(1e6) });

describe("Bitvavo candles", () => {
  it("become a history, oldest first, with volume in euros and without the unfinished day", () => {
    const h = candlesToHistory([candle("2026-01-03", 12, 5), candle("2026-01-01", 10, 2), candle("2026-01-02", 11, 3), candle("2026-01-02", 11, 3)], "2026-01-03");
    expect(h).toEqual({ dates: ["2026-01-01", "2026-01-02"], closes: [10, 11], volumes: [20, 33] });
  });
  it("skip rows without a real price", () => {
    const h = candlesToHistory([candle("2026-01-01", 0), [ms("2026-01-02"), "1", "1", "1", "x", "1"], candle("2026-01-03", 2.5e-7, 1e9)], "2026-02-01");
    expect(h.dates).toEqual(["2026-01-03"]);
    expect(h.closes).toEqual([2.5e-7]);
    expect(h.volumes).toEqual([250]);
  });
  it("a later download only adds days and never rewrites saved ones", () => {
    const saved: History = { dates: ["2026-01-01", "2026-01-02"], closes: [10, 11], volumes: [1, 1] };
    const fetched: History = { dates: ["2026-01-02", "2026-01-03"], closes: [99, 12], volumes: [9, 2] };
    expect(extendHistory(saved, fetched)).toEqual({ dates: ["2026-01-01", "2026-01-02", "2026-01-03"], closes: [10, 11, 12], volumes: [1, 1, 2] });
    expect(extendHistory(undefined, fetched)).toBe(fetched);
    expect(saved.dates).toHaveLength(2);
  });
  it("measures years from the first to the last day", () => {
    expect(yearsOf({ dates: ["2020-01-01", "2026-01-01"], closes: [1, 1], volumes: [0, 0] })).toBeCloseTo(6, 1);
    expect(yearsOf({ dates: [], closes: [], volumes: [] })).toBe(0);
  });
});

describe("telling coins apart", () => {
  it("uses the scan's own filter for stablecoins and wrapped copies", () => {
    const flat = (px: number): History => ({ dates: dates(60), closes: new Array(60).fill(px), volumes: new Array(60).fill(5e6) });
    expect(isNoiseMarket("USDC", "USD Coin", flat(0.86), 0.86)).toBe(true);
    expect(isNoiseMarket("EURC", "Euro Coin", flat(1), 0.86)).toBe(true);
    expect(isNoiseMarket("WBTC", "Wrapped Bitcoin", hist(60, 3), 0.86)).toBe(true);
    expect(isNoiseMarket("BTC", "Bitcoin", hist(60, 3, "2025-01-01", 50000), 0.86)).toBe(false);
    expect(isNoiseMarket("X", "Empty", { dates: [], closes: [], volumes: [] }, 0.86)).toBe(true);
  });
  it("sees the same coin on two venues, also when one of them dates its prices a day later", () => {
    const a = hist(200, 5);
    const b: History = { dates: a.dates, closes: a.closes.map((c, i) => c * (1 + (i % 2 ? 0.003 : -0.003))), volumes: a.volumes };
    expect(priceMatch(a, b)!.gap).toBeLessThan(0.004);
    expect(priceMatch(a, b)!.shift).toBe(0);
    const late: History = { dates: dates(200, "2025-01-02"), closes: a.closes, volumes: a.volumes };
    expect(priceMatch(a, late)).toMatchObject({ gap: 0, shift: -1 });
    expect(priceMatch(a, hist(200, 6))!.gap).toBeGreaterThan(0.1);
    expect(priceMatch(a, hist(20, 5))).toBeNull();
  });
  it("maps scanned coins to markets by ticker and price, never by ticker alone", () => {
    const btc = hist(200, 1, "2025-01-01", 50000), eth = hist(200, 2, "2025-01-01", 3000), iota = hist(200, 3, "2025-01-01", 0.2), other = hist(200, 4, "2025-01-01", 7);
    const cg = new Map<string, History>([["bitcoin", btc], ["ethereum", eth], ["iota", iota], ["lighter", other], ["monero", hist(200, 9)]]);
    const bitvavo = new Map<string, History>([["BTC", btc], ["ETH", eth], ["MIOTA", iota], ["LIT", hist(200, 8, "2025-01-01", 0.5)]]);
    const scan = [{ id: "bitcoin", symbol: "btc", name: "Bitcoin" }, { id: "ethereum", symbol: "eth", name: "Ethereum" }, { id: "iota", symbol: "iota", name: "IOTA" }, { id: "lighter", symbol: "lit", name: "Lighter" }, { id: "monero", symbol: "xmr", name: "Monero" }];
    const m = mapScanCoins(scan, cg, bitvavo);
    expect(m.matched.map(x => [x.id, x.market, x.how])).toEqual([["bitcoin", "BTC", "ticker"], ["ethereum", "ETH", "ticker"], ["iota", "MIOTA", "price"]]);
    expect(m.clash.map(x => [x.id, x.market])).toEqual([["lighter", "LIT"]]); // Bitvavo's LIT is another coin
    expect(m.unlisted.map(x => x.id)).toEqual(["monero"]);
  });
});
