import { describe, expect, it } from "vitest";
import { backtest } from "../../src/analysis/backtest";
import { analyze } from "../../src/analysis/scoring";
import type { History } from "../../src/data/types";
import { dayNumber } from "../../src/model/features";
import type { Tested } from "../../src/model/walkforward";
import type { DaySignals } from "../../src/paper/portfolio";
import type { Signals } from "../../src/paper/trader";
import type { PaperConfig, PriceFile } from "../../src/paper/types";
import type { BitvavoIndex } from "../../src/research/bitvavo";
import { allPhases, blockWeeksFor, bootstrapByWeek, btcAboveLong, phaseReport, weekOf, yearOf } from "../../src/research/phases";
import { chain, combine, compositeScores, curveStats, daySignals, edgeOver, firstOnOrAfter, marketYear, regimeSplit, runPairs, runPortfolio, volumeRanks, yearStats, yearWindows } from "../../src/research/strategies";
import { buildUniverse, splitAtGaps } from "../../src/research/universe";
import { dates, randomWalk } from "../helpers";

function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const hist = (n: number, seed: number, from = "2024-01-01", start = 100): History => ({ dates: dates(n, from), closes: randomWalk(n, seed, start), volumes: randomWalk(n, seed + 500, 1e6, 0.3) });

const config: PaperConfig = {
  coins: [], strategies: ["hold", "dca", "sma", "cross", "macd", "rsi", "model"], fee: 0.0025, slippage: 0.001,
  settings: { smaLength: 50, fast: 20, slow: 50, rsiBuyBelow: 30, rsiSellAbove: 70, dcaWeeks: 52, modelThreshold: 0.55 },
  portfolio: { k: 2, universe: 4, maxWeight: 0.6, rebalanceDays: 7, trendDays: 50 },
};

describe("the test's coins", () => {
  it("cuts a history where the market was suspended, and only there", () => {
    const d = [...dates(10, "2024-01-01"), ...dates(5, "2024-01-16"), ...dates(4, "2024-03-01")];
    const h: History = { dates: d, closes: d.map((_, i) => i + 1), volumes: d.map(() => 1) };
    const parts = splitAtGaps(h);
    expect(parts.map(p => p.dates.length)).toEqual([15, 4]); // 5 missing days are tolerated, 40 are not
    expect(parts[1].closes).toEqual([16, 17, 18, 19]);
    expect(splitAtGaps(hist(50, 1))).toHaveLength(1);
  });
  it("keys coins by scan id, leaves out stablecoins and keeps both sides of a suspension apart", () => {
    const gap: History = { dates: [...dates(3, "2024-01-01"), ...dates(2, "2024-06-01")], closes: [1, 2, 3, 30, 31], volumes: [1, 1, 1, 1, 1] };
    const raw = new Map<string, History>([["BTC", hist(20, 1)], ["ETH", hist(20, 2)], ["USDC", hist(20, 3)], ["HNT", gap]]);
    const m = (market: string, noise = false) => ({ market, name: market, status: "trading", from: "", to: "", days: 0, noise });
    const index = { markets: [m("BTC"), m("ETH"), m("USDC", true), m("HNT")], scan: { matched: [{ id: "ethereum", market: "ETH" }] } } as unknown as BitvavoIndex;
    const u = buildUniverse(index, raw);
    expect([...u.histories.keys()]).toEqual(["bitcoin", "ethereum", "HNT~1", "HNT"]);
    expect(u.histories.get("HNT")!.closes).toEqual([30, 31]);
    expect(u.coins.filter(c => c.scan).map(c => c.id)).toEqual(["bitcoin", "ethereum"]);
    expect(u.split).toEqual(["HNT"]);
  });
});

describe("bootstrap by week", () => {
  it("puts Monday to Sunday in one week", () => {
    expect(weekOf(dayNumber("2026-11-16"))).toBe(weekOf(dayNumber("2026-11-22")));
    expect(weekOf(dayNumber("2026-11-23"))).toBe(weekOf(dayNumber("2026-11-16")) + 1);
    expect(yearOf(dayNumber("2021-12-31"))).toBe(2021);
    expect(blockWeeksFor(7)).toBe(2);
    expect(blockWeeksFor(30)).toBe(9);
  });
  it("gives no range for a handful of weeks, and the same answer for the same seed", () => {
    const day = Array.from({ length: 28 }, (_, i) => 1000 + i), v = day.map((_, i) => (i % 2 ? 1 : -1));
    expect(bootstrapByWeek(day, v, null, 2)).toMatchObject({ lo: null, hi: null, below: null });
    const long = Array.from({ length: 700 }, (_, i) => 1000 + i), r = rng(3), w = long.map(() => r() - 0.5);
    expect(bootstrapByWeek(long, w, null, 2, 500, 9)).toEqual(bootstrapByWeek(long, w, null, 2, 500, 9));
  });
  it("sees a real difference and doesn't see one in noise", () => {
    const day = Array.from({ length: 1400 }, (_, i) => 1000 + i), r = rng(5);
    const real = bootstrapByWeek(day, day.map(() => -0.01 + (r() - 0.5) * 0.02), null, 2);
    expect(real.hi!).toBeLessThan(0);
    expect(real.below).toBe(1);
    const noise = bootstrapByWeek(day, day.map(() => r() - 0.5), null, 2);
    expect(noise.lo!).toBeLessThan(0);
    expect(noise.hi!).toBeGreaterThan(0);
  });
  it("counts a week once however many rows it has: rows that move together don't shrink the range", () => {
    const r = rng(11), day: number[] = [], v: number[] = [];
    for (let w = 0; w < 100; w++) { const shock = r() - 0.5; for (let k = 0; k < 200; k++) { day.push(1001 + w * 7 + (k % 7)); v.push(shock); } }
    const b = bootstrapByWeek(day, v, null, 1);
    const naive = 1.96 * Math.sqrt(1 / 12) / Math.sqrt(v.length); // what treating 20,000 rows as independent would claim
    expect((b.hi! - b.lo!) / 2).toBeGreaterThan(8 * naive);
    expect(b.weeks).toBeGreaterThanOrEqual(100);
  });
  it("takes a ratio of sums when a denominator is given", () => {
    const day = Array.from({ length: 70 }, (_, i) => 1000 + i);
    expect(bootstrapByWeek(day, day.map(() => 3), day.map(() => 2), 2).mean).toBeCloseTo(1.5, 12);
  });
});

/** Walk-forward rows where "logit" knows the true chance and "gbt" guesses at random. */
function fakeRows(weeks: number, coins: number, seed: number, from = "2021-03-01"): Tested[] {
  const r = rng(seed), d0 = dayNumber(from), out: Tested[] = [];
  for (let d = 0; d < weeks * 7; d++) for (let c = 0; c < coins; c++) {
    const p = r() < 0.5 ? 0.3 : 0.7, y = r() < p ? 1 : 0, ret = (y ? 1 : -1) * (0.01 + r() * 0.05);
    out.push({ coin: "c" + c, day: d0 + d, r: ret, y, logit: p, gbt: 0.35 + r() * 0.3, base: 0.5, momentum: 0.5, trendUp: r() < 0.5, mu: 0, lo: -0.1, hi: 0.1 });
  }
  return out;
}

describe("phase reports", () => {
  const rows = fakeRows(60, 12, 21);
  it("call a model better only when it really is", () => {
    const p = phaseReport("all", "All", rows, 7, 400)!;
    expect(p.n).toBe(60 * 7 * 12);
    expect(p.logit.verdict).toBe("better");
    expect(p.logit.vsBest.hi!).toBeLessThan(0);
    expect(p.logit.vsHit.lo!).toBeGreaterThan(0);
    expect(p.logit.rank.lo!).toBeGreaterThan(0);
    expect(p.logit.top.lo!).toBeGreaterThan(0.005); // the coins it rates highest really do better than the average coin
    expect(p.gbt.top.lo!).toBeLessThan(0);
    expect(p.gbt.top.hi!).toBeGreaterThan(0);
    expect(p.gbt.verdict).not.toBe("better");
    expect(p.gbt.rank.lo!).toBeLessThan(0.05);
    expect(phaseReport("none", "None", [], 7)).toBeNull();
  });
  it("split the forecasts by year, by Bitcoin's trend and by today's scan, without losing any", () => {
    const above = new Map<number, boolean>(rows.map(r => [r.day, r.day % 2 === 0] as const));
    const ph = allPhases(rows, 7, above, new Set(["c0", "c1"]), 200);
    expect(ph.years.map(y => y.key)).toEqual(["2021", "2022"]);
    expect(ph.years.reduce((s, y) => s + y.n, 0)).toBe(rows.length);
    expect(ph.regimes.map(y => y.key)).toEqual(["above", "below"]);
    expect(ph.regimes.reduce((s, y) => s + y.n, 0)).toBe(rows.length);
    expect(ph.groups.map(g => g.coins)).toEqual([2, 10]);
    expect(ph.gbtVsLogit.lo!).toBeGreaterThan(0); // the guessing model's Brier score is clearly the worse one
  });
  it("read Bitcoin's trend from its own closes, never from later ones", () => {
    const btc = hist(400, 1), a = btcAboveLong(btc);
    const later: History = { ...btc, closes: btc.closes.map((c, i) => (i > 300 ? c * 5 : c)) };
    const b = btcAboveLong(later);
    for (let i = 100; i <= 300; i++) expect(b.get(dayNumber(btc.dates[i]))).toBe(a.get(dayNumber(btc.dates[i])));
    expect(a.size).toBeGreaterThan(250);
  });
});

describe("strategies on past prices", () => {
  const h = hist(500, 7), prices: PriceFile = { coin: { dates: h.dates, closes: h.closes } };
  const start = h.dates[120], end = h.dates[420];
  const always = (p: number): Signals => ({ coin: Object.fromEntries(h.dates.map(d => [d, p])) });
  const runs = runPairs(prices, always(0.9), config, ["coin"], start, end).get("coin")!;

  it("trade exactly as the Backtest tab does from the same day", () => {
    const c = h.closes.slice(0, 421);
    for (const s of ["hold", "sma", "cross", "macd", "rsi", "dca"] as const) {
      const b = backtest(c, s, { fee: config.fee, slippage: config.slippage, start: 120, len: 50, fast: 20, slow: 50, lo: 30, hi: 70, dcaChunk: 1000 / 52 });
      const r = runs.get(s)!;
      expect(r.dates[0]).toBe(start);
      expect(r.dates[r.dates.length - 1]).toBe(end);
      expect(r.eq.length).toBe(b.eq.length);
      for (let i = 0; i < b.eq.length; i += 25) expect(r.eq[i] * 1000).toBeCloseTo(b.eq[i], 6);
      expect(r.trades).toBe(b.trades);
    }
  });
  it("never see prices after the end", () => {
    const changed: PriceFile = { coin: { dates: h.dates, closes: h.closes.map((c, i) => (i > 420 ? c * 4 : c)) } };
    const again = runPairs(changed, always(0.9), config, ["coin"], start, end).get("coin")!;
    for (const s of config.strategies) expect(again.get(s)!.eq).toEqual(runs.get(s)!.eq);
  });
  it("the model strategy holds above the threshold and stays in cash below it", () => {
    expect(runs.get("model")!.eq).toEqual(runs.get("hold")!.eq);
    const out = runPairs(prices, always(0.5), config, ["coin"], start, end).get("coin")!.get("model")!;
    expect(out.eq.every(v => v === 1)).toBe(true);
    expect(out.trades).toBe(0);
  });
  it("leave out a coin with too little history or no forecast on the day before the start", () => {
    expect(runPairs(prices, always(0.9), config, ["coin"], h.dates[30], end).size).toBe(0);
    expect(runPairs(prices, {}, config, ["coin"], start, end).size).toBe(0);
    expect(runPairs(prices, {}, { ...config, strategies: ["hold", "sma"] }, ["coin"], start, end).size).toBe(1);
    expect(runPairs(prices, always(0.9), config, ["coin", "nope"], "2030-01-01", "2030-12-31").size).toBe(0);
  });
  it("combine, chain and measure curves", () => {
    const d = dates(4, "2024-12-30");
    const both = combine([{ dates: d, eq: [1, 1.2, 1.2, 1.5] }, { dates: [d[1], d[3]], eq: [0.8, 0.5] }], d);
    expect(both.eq).toEqual([1, 1, 1, 1]); // cash before its first day, last value kept on a missing day
    const joined = chain([{ dates: d.slice(0, 2), eq: [1.1, 2] }, { dates: d.slice(2), eq: [0.9, 0.5] }]);
    expect(joined.eq.map(v => +v.toFixed(6))).toEqual([1.1, 2, 1.8, 1]);
    expect(curveStats(joined).ret).toBeCloseTo(0, 12);
    expect(curveStats(joined).mdd).toBeCloseTo(-0.5, 12);
    const y = yearStats(joined, [2023, 2024, 2025]);
    expect(y.ret[0]).toBeNull();
    expect(y.ret[1]).toBeCloseTo(1, 12);     // 1 -> 2 by the end of 2024
    expect(y.ret[2]).toBeCloseTo(-0.5, 12);  // 2 -> 1 in 2025
    expect(y.mdd[2]).toBeCloseTo(-0.5, 12);
    const split = regimeSplit(joined, new Map([[d[0], true], [d[1], false], [d[2], false]]));
    expect(split.above).toEqual({ days: 1, ret: 2 / 1.1 - 1 });
    expect(split.below.days).toBe(2);
    expect(split.below.ret).toBeCloseTo(-0.5, 12);
    expect(firstOnOrAfter(d, "2025-01-01")).toBe(2);
    expect(yearWindows("2019-09-20", "2021-03-05")).toEqual([{ year: 2019, start: "2019-09-20", end: "2019-12-31" }, { year: 2020, start: "2020-01-01", end: "2020-12-31" }, { year: 2021, start: "2021-01-01", end: "2021-03-05" }]);
  });
  it("says whether one curve outgrew another by more than luck", () => {
    const d = dates(1400, "2020-01-01"), r = rng(41);
    const walk = (drift: number, tie: number[]) => { let v = 1; return tie.map(z => (v *= Math.exp(drift + z))); };
    const noise = d.map(() => (r() - 0.5) * 0.06);
    const base = { dates: d, eq: walk(0, noise) };
    const ahead = edgeOver({ dates: d, eq: walk(0.001, noise.map(z => z + (r() - 0.5) * 0.004)) }, base, 4, 500);
    expect(ahead.mean).toBeGreaterThan(0.3);            // 0.1% a day is about +44% a year
    expect(ahead.lo!).toBeGreaterThan(0);
    const same = edgeOver({ dates: d, eq: walk(0, d.map(() => (r() - 0.5) * 0.06)) }, base, 4, 500);
    expect(same.lo!).toBeLessThan(0);
    expect(same.hi!).toBeGreaterThan(0);
    expect(edgeOver(base, base, 4, 100).mean).toBe(0);
    // Curves at different levels on their first shared day: only the changes after it count.
    expect(edgeOver({ dates: d.slice(700), eq: base.eq.slice(700).map(v => v * 9) }, base, 4, 100).mean).toBeCloseTo(0, 12);
  });
});

describe("the weekly portfolio on past prices", () => {
  const ids = ["bitcoin", "a", "b", "c", "d"];
  const hs = new Map<string, History>(ids.map((id, i) => [id, hist(420, 30 + i)]));
  const all = hs.get("bitcoin")!.dates, from = all[150];
  const prices = Object.fromEntries([...hs].map(([id, x]) => [id, { dates: x.dates, closes: x.closes }]));
  const chance: Record<string, Record<string, number>> = {};
  const r = rng(77);
  for (const d of all.slice(149)) chance[d] = Object.fromEntries(ids.map(id => [id, r()]));
  const ranks = volumeRanks(hs, all[140]), comp = compositeScores(hs, all[140]);
  const sig: Record<string, DaySignals> = daySignals(comp, ranks, chance);

  it("ranks coins by the volume traded up to that day only", () => {
    const day = ranks.get(all[200])!;
    const avg = (id: string) => hs.get(id)!.volumes.slice(171, 201).reduce((s, v) => s + v, 0) / 30;
    const order = [...ids].sort((x, y) => avg(y) - avg(x));
    expect(order.map(id => day[id])).toEqual([1, 2, 3, 4, 5]);
    expect(ranks.has(all[139])).toBe(false);
  });
  it("scores a coin from the year before the day, as the scan does", () => {
    const x = hs.get("a")!, i = 400;
    const want = analyze({ dates: x.dates.slice(i - 364, i + 1), closes: x.closes.slice(i - 364, i + 1), volumes: x.volumes.slice(i - 364, i + 1) }, null, null).composite;
    expect(comp.get(all[i])!.a).toBeCloseTo(want, 1);
  });
  it("starts all three portfolios on the first day and trades them to the end without looking further", () => {
    const run = runPortfolio(prices, sig, config, from, all[400])!;
    expect(run.dates[0]).toBe(from);
    expect(run.dates[run.dates.length - 1]).toBe(all[400]);
    const b = hs.get("bitcoin")!.closes;
    expect(run.books.btc.eq[run.books.btc.eq.length - 1]).toBeCloseTo((1 - config.fee) / (1 + config.slippage) * b[400] / b[150], 9);
    expect(run.books.btc.trades).toBe(1);
    expect(run.books.equal.trades).toBe(4); // the universe is the 4 most traded
    expect(run.books.topk.trades).toBeGreaterThan(2);
    const changed = Object.fromEntries(Object.entries(prices).map(([id, p]) => [id, { dates: p.dates, closes: p.closes.map((c, i) => (i > 400 ? c * 3 : c)) }]));
    expect(runPortfolio(changed, sig, config, from, all[400])!.books).toEqual(run.books);
    expect(runPortfolio(prices, sig, config, "2030-01-01", "2030-06-01")).toBeNull();
  });
  it("runs every coin for a year with equal money in each", () => {
    const signals: Signals = Object.fromEntries(ids.map(id => [id, Object.fromEntries(Object.entries(chance).map(([d, p]) => [d, p[id]]))]));
    const y = marketYear(prices, signals, config, { year: 2024, start: from, end: all[400] }, all);
    expect(y.coins).toBe(5);
    const holds = [...runPairs(prices, signals, config, ids, from, all[400]).values()].map(m => m.get("hold")!);
    const mean = holds.reduce((s, x) => s + x.eq[x.eq.length - 1], 0) / 5;
    const curve = y.curves.get("hold")!;
    expect(curve.eq[curve.eq.length - 1]).toBeCloseTo(mean, 12);
    expect(y.beatHold.get("hold")).toBe(0);
    expect(y.trades.get("hold")).toBe(1);
    expect(y.trades.get("model")!).toBeGreaterThan(1);
  });
});
