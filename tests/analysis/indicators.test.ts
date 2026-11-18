import { describe, expect, it } from "vitest";
import { bollinger, ema, macd, maxDrawdown, obv, rsi, sma } from "../../src/analysis/indicators";
import { randomWalk } from "../helpers";

const range = (n: number, f = (i: number) => i) => Array.from({ length: n }, (_, i) => f(i));

describe("sma", () => {
  it("averages the last n values and is null before that", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("with n = 1 returns the input", () => {
    expect(sma([5, 7, 9], 1)).toEqual([5, 7, 9]);
  });
  it("is all null when the series is shorter than n", () => {
    expect(sma([1, 2], 3)).toEqual([null, null]);
  });
  it("matches a direct average on a long noisy series (running sum stays accurate)", () => {
    const c = randomWalk(500, 1);
    const s = sma(c, 50);
    for (const i of [49, 200, 499]) {
      const direct = c.slice(i - 49, i + 1).reduce((a, b) => a + b, 0) / 50;
      expect(s[i]).toBeCloseTo(direct, 8);
    }
  });
});

describe("ema", () => {
  it("is seeded with the simple average of the first n values", () => {
    const e = ema([2, 4, 6, 8, 12, 14], 4); // k = 2/5 = 0.4
    expect(e.slice(0, 3)).toEqual([null, null, null]);
    expect(e[3]).toBeCloseTo(5, 12); // (2+4+6+8)/4
    expect(e[4]).toBeCloseTo(12 * 0.4 + 5 * 0.6, 12); // 7.8
    expect(e[5]).toBeCloseTo(14 * 0.4 + 7.8 * 0.6, 12); // 10.28
  });
  it("lags a straight line by exactly (n - 1) / 2 steps", () => {
    const e = ema(range(30), 9);
    for (let i = 8; i < 30; i++) expect(e[i]).toBeCloseTo(i - 4, 10);
  });
  it("skips leading nulls (used for the MACD signal line)", () => {
    expect(ema([null, null, 1, 2, 3], 3)).toEqual([null, null, null, null, 2]);
  });
  it("is all null when there is not enough data", () => {
    expect(ema([1, 2], 3)).toEqual([null, null]);
  });
});

describe("rsi (Wilder)", () => {
  it("matches a hand calculation", () => {
    // diffs +1, -1, +1, +1 with n = 2
    // first: avg gain 0.5, avg loss 0.5 -> 50
    // then gain (0.5+1)/2 = 0.75, loss 0.25 -> RS 3 -> 75
    // then gain 0.875, loss 0.125 -> RS 7 -> 87.5
    expect(rsi([1, 2, 1, 2, 3], 2)).toEqual([null, null, 50, 75, 87.5]);
  });
  it("is 100 when price only rises and 0 when it only falls", () => {
    expect(rsi(range(30, i => 10 + i)).slice(14).every(v => v === 100)).toBe(true);
    expect(rsi(range(30, i => 100 - i)).slice(14).every(v => v === 0)).toBe(true);
  });
  it("is 50 on a perfectly flat price (not 100)", () => {
    expect(rsi(range(30, () => 1)).slice(14).every(v => v === 50)).toBe(true);
  });
  it("first value is at index n; all null when the series is too short", () => {
    const r = rsi(range(20, i => 10 + Math.sin(i)));
    expect(r.slice(0, 14).every(v => v === null)).toBe(true);
    expect(r[14]).not.toBeNull();
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null]);
  });
  it("always stays between 0 and 100", () => {
    const r = rsi(randomWalk(400, 7)).filter((v): v is number => v != null);
    expect(Math.min(...r)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...r)).toBeLessThanOrEqual(100);
  });
});

describe("macd", () => {
  it("is fast EMA minus slow EMA; signal is a 9-period EMA of it; histogram is the difference", () => {
    const c = randomWalk(200, 3);
    const { m, sig, hist } = macd(c);
    const e12 = ema(c, 12), e26 = ema(c, 26);
    expect(m.slice(0, 25).every(v => v === null)).toBe(true);
    expect(sig.slice(0, 33).every(v => v === null)).toBe(true);
    for (const i of [25, 60, 199]) expect(m[i]).toBeCloseTo(e12[i]! - e26[i]!, 10);
    const sigRef = ema(m.slice(25) as number[], 9);
    for (const i of [33, 100, 199]) expect(sig[i]).toBeCloseTo(sigRef[i - 25]!, 10);
    for (const i of [33, 150]) expect(hist[i]).toBeCloseTo(m[i]! - sig[i]!, 12);
  });
  it("is 7 per unit of slope on a straight line (lags of 12.5 and 5.5 steps)", () => {
    const { m, sig, hist } = macd(range(80, i => 50 + 2 * i));
    for (let i = 33; i < 80; i++) {
      expect(m[i]).toBeCloseTo(14, 9);
      expect(sig[i]).toBeCloseTo(14, 9);
      expect(hist[i]).toBeCloseTo(0, 9);
    }
  });
  it("is zero on a flat price", () => {
    const { m } = macd(range(60, () => 3));
    expect(m[59]).toBeCloseTo(0, 12);
  });
});

describe("bollinger", () => {
  it("uses the population standard deviation of the window", () => {
    const c = range(20, i => i + 1); // 1..20, variance (20^2 - 1) / 12
    const b = bollinger(c, 20, 2);
    const sd = Math.sqrt(399 / 12);
    expect(b.mid[19]).toBeCloseTo(10.5, 12);
    expect(b.up[19]).toBeCloseTo(10.5 + 2 * sd, 12);
    expect(b.lo[19]).toBeCloseTo(10.5 - 2 * sd, 12);
    expect(b.up[18]).toBeNull();
  });
  it("collapses onto the average when the price is flat", () => {
    const b = bollinger(range(25, () => 4));
    expect(b.up[24]).toBe(4);
    expect(b.lo[24]).toBe(4);
  });
  it("is symmetric around the middle band", () => {
    const b = bollinger(randomWalk(100, 5));
    for (let i = 19; i < 100; i++) expect(b.up[i]! - b.mid[i]!).toBeCloseTo(b.mid[i]! - b.lo[i]!, 9);
  });
});

describe("maxDrawdown", () => {
  it("finds the deepest fall from a running peak", () => {
    expect(maxDrawdown([100, 80, 120, 90, 150])).toBeCloseTo(-0.25, 12); // 120 -> 90
    expect(maxDrawdown([100, 120, 60, 130, 65])).toBeCloseTo(-0.5, 12);
  });
  it("ignores falls below the starting price that come before any peak only by the right amount", () => {
    expect(maxDrawdown([100, 50, 200])).toBeCloseTo(-0.5, 12);
  });
  it("is 0 for a series that never falls", () => {
    expect(maxDrawdown([1, 2, 2, 3])).toBe(0);
  });
});

describe("obv", () => {
  it("adds volume on up days, subtracts on down days, ignores flat days", () => {
    expect(obv([1, 2, 1, 1, 3], [9, 10, 20, 30, 5])).toEqual([0, 10, -10, -10, -5]);
  });
});
