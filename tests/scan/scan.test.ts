import { describe, expect, it } from "vitest";
import type { History, MarketCoin } from "../../src/data/types";
import { daysToFetch, mergeHistory, parseCsv, toCsv } from "../../src/scan/history";
import { addDay, checkScanConfig, dayBefore, diff, pickUniverse, rank, scanCoin } from "../../src/scan/scan";
import type { DayRow, ScanCoin } from "../../src/scan/types";
import { dates, randomWalk } from "../helpers";

const coin = (id: string, mcap: number, over: Partial<MarketCoin> = {}): MarketCoin => ({
  id, symbol: id.slice(0, 3), name: id[0].toUpperCase() + id.slice(1), image: null, current_price: 10, market_cap: mcap, market_cap_rank: null,
  total_volume: mcap / 20, ath: 20, ath_change_percentage: -50, ath_date: null, atl: 1, atl_change_percentage: 900, atl_date: null,
  price_change_percentage_7d_in_currency: 4, price_change_percentage_30d_in_currency: -12, price_change_percentage_1y_in_currency: 30, last_updated: null, ...over,
});
const hist = (n: number, seed: number, from = "2025-01-01"): History => ({ dates: dates(n, from), closes: randomWalk(n, seed), volumes: new Array(n).fill(1e6) });

describe("history files", () => {
  it("round-trips through CSV", () => {
    const h: History = { dates: ["2026-01-01", "2026-01-02"], closes: [57416.182264674375, 0.00001234], volumes: [123456.7, 0] };
    expect(parseCsv(toCsv(h))).toEqual({ ...h, volumes: [123457, 0] });
  });
  it("refuses a damaged file rather than guessing", () => {
    expect(() => parseCsv("date,close,volume\n2026-01-02,5,1\n2026-01-01,5,1\n")).toThrow(/out of order/);
    expect(() => parseCsv("date,close,volume\n2026-01-02,-5,1\n")).toThrow(/bad line/);
    expect(() => parseCsv("2026-01-02,5,1\n")).toThrow(/first line/);
  });
  it("only adds finished days, with their volumes, and never rewrites saved ones", () => {
    const saved: History = { dates: ["2026-01-01", "2026-01-02"], closes: [100, 101], volumes: [5, 6] };
    const fetched: History = { dates: ["2026-01-02", "2026-01-03", "2026-01-04"], closes: [101.2, 103, 99], volumes: [60, 7, 8] };
    const m = mergeHistory(saved, fetched, "2026-01-04");
    expect(m).toEqual({ history: { dates: ["2026-01-01", "2026-01-02", "2026-01-03"], closes: [100, 101, 103], volumes: [5, 6, 7] }, added: 1, problem: null });
  });
  it("refuses prices that don't match the saved ones", () => {
    const saved: History = { dates: ["2026-01-01", "2026-01-02"], closes: [100, 101], volumes: [5, 6] };
    const m = mergeHistory(saved, { dates: ["2026-01-01", "2026-01-02", "2026-01-03"], closes: [50, 51, 52], volumes: [1, 1, 1] }, "2026-01-05");
    expect(m.added).toBe(0);
    expect(m.problem).toMatch(/don't match/);
    expect(m.history).toEqual(saved);
  });
  it("keeps a new coin whose early history has a glitch, from the day of the last jump on", () => {
    const fetched: History = { dates: ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"], closes: [1, 1.1, 40, 41, 42], volumes: [1, 2, 3, 4, 5] };
    expect(mergeHistory(undefined, fetched, "2026-01-06")).toEqual({ history: { dates: ["2026-01-03", "2026-01-04", "2026-01-05"], closes: [40, 41, 42], volumes: [3, 4, 5] }, added: 3, problem: null });
    // A coin that already has a saved history stays strict: the fetch is refused.
    const saved: History = { dates: ["2026-01-01", "2026-01-02"], closes: [1, 1.1], volumes: [1, 2] };
    expect(mergeHistory(saved, fetched, "2026-01-06").problem).toMatch(/implausible jump/);
  });
  it("asks for a year the first time and only the newest days afterwards", () => {
    expect(daysToFetch(undefined, "2026-11-20")).toBe(365);
    expect(daysToFetch(hist(3, 1, "2026-11-17"), "2026-11-20")).toBe(10);
    expect(daysToFetch(hist(3, 1, "2026-10-01"), "2026-11-20")).toBe(55);
  });
});

describe("pickUniverse", () => {
  const markets = [
    coin("bitcoin", 1000e9), coin("tether", 150e9, { symbol: "usdt", current_price: 0.9 }), coin("ethereum", 300e9),
    coin("wrapped-bitcoin", 10e9, { symbol: "wbtc", name: "Wrapped Bitcoin" }), coin("solana", 80e9), coin("ripple", 70e9), coin("dogecoin", 20e9), coin("monero", 5e9),
  ];
  it("takes the biggest real coins and leaves out stablecoins and wrapped tokens", () => {
    expect(pickUniverse(markets, 3, [])).toEqual(["bitcoin", "ethereum", "solana"]);
  });
  it("always includes watched coins, and Bitcoin first", () => {
    expect(pickUniverse(markets, 2, ["monero"])).toEqual(["bitcoin", "ethereum", "monero"]);
    expect(pickUniverse(markets.slice(1), 1, [])[0]).toBe("bitcoin");
  });
  it("keeps a coin scanned last time while it is still close to the cut", () => {
    expect(pickUniverse(markets, 5, [], ["monero"])).toContain("monero"); // 6th, within 20% of the cut
    expect(pickUniverse(markets, 3, [], ["monero"])).not.toContain("monero");
  });
});

describe("scanCoin, rank and diff", () => {
  const btc = hist(365, 7);
  const row = (id: string, seed: number, watch = false) => scanCoin(hist(365, seed), btc, coin(id, 1e9 * seed), { sectors: ["layer-1"], watch }) as ScanCoin;
  it("gives the same scores as the coin page's analysis and says why a new coin is skipped", () => {
    const r = row("ethereum", 11);
    expect(r.composite).toBeGreaterThanOrEqual(0);
    expect(r.composite).toBeLessThanOrEqual(100);
    expect(r.composite).toBeCloseTo(0.6 * r.trend + 0.4 * (100 - r.risk), 0);
    expect(r.days).toBe(365);
    expect(r.cons.t).not.toMatch(/Technicals/);
    expect(scanCoin(hist(40, 3), btc, coin("newcoin", 1e9), { sectors: [], watch: false })).toMatch(/only 40 days/);
  });
  it("ranks by composite score", () => {
    const list = rank([row("a", 3), row("b", 5), row("c", 9), row("d", 13)]);
    expect(list.map(c => c.rank)).toEqual([1, 2, 3, 4]);
    for (let i = 1; i < list.length; i++) expect(list[i - 1].composite).toBeGreaterThanOrEqual(list[i].composite);
  });
  it("reports class and consensus changes, big rank moves, unusual moves, and coins that came or went", () => {
    const a = { ...row("aaa", 3, true), rank: 1 }, b = { ...row("bbb", 5), rank: 20, ret1: 0.3, dayVol: 0.04 }, c = { ...row("ccc", 9), rank: 3, ret1: 0.001 };
    const prev = { date: "2025-12-30", coins: {
      aaa: [2, 50, 50, 50, 1, a.cls.t === "Avoid for now" ? "Steady uptrend" : "Avoid for now", a.cons.t, 1] as DayRow,
      bbb: [2, 50, 50, 50, 1, b.cls.t, b.cons.t, 2] as DayRow,
      zzz: [9, 50, 50, 50, 1, "Mixed, no clear trend", "mixed", 3] as DayRow,
    } };
    const ch = diff(prev, [a, b, c]);
    expect(ch[0]).toMatchObject({ id: "aaa", kind: "cls", watch: true });
    expect(ch.find(x => x.id === "bbb" && x.kind === "rank")).toMatchObject({ k: "bad", text: "Rank 2 → 20" });
    expect(ch.find(x => x.id === "bbb" && x.kind === "move")!.text).toMatch(/Rose 30\.0% in a day/);
    expect(ch.find(x => x.id === "ccc")).toMatchObject({ kind: "new" });
    expect(ch.find(x => x.id === "zzz")).toMatchObject({ kind: "gone" });
    // The first scan ever has nothing to compare with: only unusual moves are reported.
    expect(diff(undefined, [a, b, c]).every(x => x.kind === "move")).toBe(true);
  });
  it("keeps a short history, one entry per day", () => {
    const list = rank([row("a", 3), row("b", 5)]);
    let h = addDay({ days: [] }, "2026-01-01", list, 2);
    h = addDay(h, "2026-01-02", list, 2);
    h = addDay(h, "2026-01-02", list, 2);
    h = addDay(h, "2026-01-03", list, 2);
    expect(h.days.map(d => d.date)).toEqual(["2026-01-02", "2026-01-03"]);
    expect(dayBefore(h, "2026-01-03")!.date).toBe("2026-01-02");
    expect(dayBefore(h, "2026-01-02")).toBeUndefined();
    expect(h.days[0].coins.a).toHaveLength(8);
  });
  it("checks the config", () => {
    expect(checkScanConfig({ topN: 150, watchlist: ["bitcoin"], historyDays: 45 })).toEqual([]);
    expect(checkScanConfig({ topN: 500, watchlist: ["Bitcoin!"], historyDays: 0 })).toHaveLength(3);
  });
});
