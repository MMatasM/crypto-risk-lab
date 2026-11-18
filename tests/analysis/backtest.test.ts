import { describe, expect, it } from "vitest";
import { backtest, positions, START_CAPITAL, type Strategy } from "../../src/analysis/backtest";
import { maxDrawdown } from "../../src/analysis/indicators";
import { randomWalk } from "../helpers";

const opt = (extra: Partial<Parameters<typeof backtest>[2]> = {}) => ({ fee: 0, start: 100, len: 50, fast: 20, slow: 50, lo: 30, hi: 70, ...extra });
const STRATEGIES: Strategy[] = ["hold", "sma", "cross", "rsi", "macd", "dca"];

describe("buy and hold", () => {
  it("returns the price change, minus one fee", () => {
    const c = randomWalk(300, 11);
    const r = backtest(c, "hold", opt({ fee: 0.01 }));
    expect(r.final).toBeCloseTo(START_CAPITAL * 0.99 * c[299] / c[100], 8);
    expect(r.trades).toBe(1);
    expect(r.exposure).toBe(1);
    expect(r.eq.length).toBe(200);
  });
  it("reports the worst drop of its own equity curve", () => {
    const c = randomWalk(300, 12);
    const r = backtest(c, "hold", opt());
    expect(r.mdd).toBeCloseTo(maxDrawdown(c.slice(100)), 10);
  });
});

describe("fees", () => {
  it("a round trip on an unchanged price costs two fees", () => {
    // Price above its average for a while (in), then below (out), ending where it started.
    const c = [...Array(60).fill(100), ...Array(20).fill(110), ...Array(30).fill(90), 110];
    const r = backtest(c, "sma", opt({ fee: 0.01, start: 55, len: 5 }));
    const want = positions(c, "sma", { fee: 0, start: 55, len: 5 });
    expect(want[60]).toBe(false); // the first 110 (day 60) is acted on only the next day
    expect(want[61]).toBe(true); // buy at 110
    expect(want[65]).toBe(false); // the 5-day average caught up on day 64: sell at 110
    // Bought and sold at 110 and never bought again, so the only loss is the two fees.
    expect(r.trades).toBe(2);
    expect(r.final).toBeCloseTo(START_CAPITAL * 0.99 * 0.99, 8);
  });
});

describe("no peeking ahead", () => {
  // Changing prices after day k must not change anything the strategy did up to day k.
  for (const s of STRATEGIES) {
    it(`${s}: the equity up to day k is the same whatever happens after day k`, () => {
      const c = randomWalk(365, 21);
      const base = backtest(c, s, opt({ fee: 0.0025 }));
      for (const k of [120, 200, 300, 363]) {
        const changed = c.map((v, i) => (i > k ? v * (i % 2 ? 1.7 : 0.4) : v));
        const other = backtest(changed, s, opt({ fee: 0.0025 }));
        expect(other.eq.slice(0, k - 100 + 1)).toEqual(base.eq.slice(0, k - 100 + 1));
      }
    });
  }

  for (const s of ["sma", "cross", "rsi", "macd"] as const) {
    it(`${s}: the decision for day i is the same with prices from day i on removed`, () => {
      const c = randomWalk(365, 33);
      const full = positions(c, s, opt());
      for (const i of [150, 250, 364]) {
        const cut = positions(c.slice(0, i), s, opt());
        // The position for day i needs only days 0..i-1. Compute it from the shortened series by
        // appending a dummy price for day i (never read by the decision).
        const withDummy = positions([...c.slice(0, i), -1], s, opt());
        expect(withDummy[i]).toBe(full[i]);
        expect(cut.slice(100, i)).toEqual(full.slice(100, i));
      }
    });
  }

  it("cannot catch a one-day jump it had no way of seeing", () => {
    // Flat at 100, jumps to 200 on day 150 and stays. A strategy that peeked would be in for the jump.
    const c = Array.from({ length: 200 }, (_, i) => (i < 150 ? 100 : 200));
    const r = backtest(c, "sma", opt({ len: 5 }));
    const want = positions(c, "sma", opt({ len: 5 }));
    expect(want[150]).toBe(false); // decided from day 149, when nothing had happened yet
    expect(want[151]).toBe(true); // buys at day 151's close, already 200
    expect(r.final).toBeCloseTo(START_CAPITAL, 8); // so it gains nothing from the jump
    expect(backtest(c, "hold", opt()).final).toBeCloseTo(2 * START_CAPITAL, 8);
  });
});

describe("dca", () => {
  it("invests the whole €1,000 in equal weekly parts", () => {
    const c = Array.from({ length: 170 }, (_, i) => 100 + i);
    const r = backtest(c, "dca", opt());
    // 70 days from day 100: buys on days 100, 107, ..., 163 -> 10 buys of €100
    expect(r.trades).toBe(10);
    let units = 0;
    for (let i = 100; i < 170; i += 7) units += 100 / c[i];
    expect(r.final).toBeCloseTo(units * c[169], 8);
  });
});

describe("rsi strategy", () => {
  it("buys when RSI falls below the low line and sells above the high line", () => {
    // Fall hard (RSI near 0), then rise hard (RSI near 100).
    const c = [...Array.from({ length: 130 }, (_, i) => 200 - i), ...Array.from({ length: 60 }, (_, i) => 71 + 2 * i)];
    const want = positions(c, "rsi", opt());
    expect(want[110]).toBe(true);
    expect(want[189]).toBe(false);
  });
});
