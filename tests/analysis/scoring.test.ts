import { describe, expect, it } from "vitest";
import { analyze, tierOf } from "../../src/analysis/scoring";
import { technicals, monthly } from "../../src/analysis/technicals";
import { isNoise, screen } from "../../src/analysis/screen";
import { slimCoin } from "../../src/data/repository";
import { dates, randomWalk } from "../helpers";

const hist = (c: number[]) => ({ dates: dates(c.length), closes: c, volumes: c.map(() => 1e6) });

describe("analyze", () => {
  it("produces finite scores on a normal year of prices", () => {
    const h = hist(randomWalk(366, 4));
    const a = analyze(h, hist(randomWalk(366, 5)), null);
    for (const v of [a.risk, a.trend, a.composite, a.vol90, a.mdd, a.model.lo95, a.model.hi95]) expect(Number.isFinite(v)).toBe(true);
    expect(a.longN).toBe(200);
    expect(a.corrBtc).not.toBeNull();
  });
  it("copes with a perfectly flat price (a stablecoin) without NaN", () => {
    const h = hist(Array(120).fill(0.91));
    const a = analyze(h, null, null);
    expect(a.vol90).toBe(0);
    expect(a.R).toBe(50);
    expect(a.model.pDrop20).toBe(0);
    const t = technicals(h, a);
    for (const r of t.rows) expect(r.state).not.toMatch(/NaN|Infinity/);
  });
  it("scales the long average to short histories", () => {
    const a = analyze(hist(randomWalk(90, 9)), null, null);
    expect(a.longN).toBe(49);
  });
});

describe("tierOf", () => {
  it("sorts market caps into tiers", () => {
    expect(tierOf(60e9).k).toBe("mega");
    expect(tierOf(2e9).k).toBe("mid");
    expect(tierOf(5e6).k).toBe("micro");
    expect(tierOf(null).k).toBe("unknown");
  });
});

describe("monthly", () => {
  it("measures each month from the previous month's last close and marks partial months", () => {
    const d = ["2025-01-30", "2025-01-31", "2025-02-01", "2025-02-28", "2025-03-01"];
    const c = [100, 110, 121, 132, 99];
    const m = monthly(d, c);
    expect(m.map(x => x.m)).toEqual(["2025-01", "2025-02", "2025-03"]);
    expect(m[0].r).toBeCloseTo(0.1, 12); // first month: from its own first close
    expect(m[0].partialStart).toBe(true);
    expect(m[1].r).toBeCloseTo(132 / 110 - 1, 12);
    expect(m[2].r).toBeCloseTo(99 / 132 - 1, 12);
    expect(m[2].partialEnd).toBe(true);
  });
});

describe("Discover screen with real-world gaps", () => {
  const coin = (o: Record<string, unknown>) => slimCoin({ id: "x", symbol: "x", name: "X", current_price: 1, market_cap: 2e9, total_volume: 1e8, ...o });
  it("calls a coin without a 30-day change a new listing, not 'quiet'", () => {
    expect(screen(coin({ price_change_percentage_30d_in_currency: null })).pat.t).toBe("New listing");
  });
  it("treats missing trading volume as unknown, not as thin", () => {
    expect(screen(coin({ total_volume: null, price_change_percentage_30d_in_currency: 3 })).thin).toBe(false);
  });
  it("hides dollar stablecoins priced in EUR, tokenized funds and wrapped coins", () => {
    expect(isNoise(coin({ symbol: "gho", name: "GHO", current_price: 0.909, price_change_percentage_30d_in_currency: -0.06, price_change_percentage_7d_in_currency: -0.07 }), 0.91)).toBe(true);
    expect(isNoise(coin({ symbol: "newusd", name: "Some Dollar", current_price: 0.912, price_change_percentage_30d_in_currency: 0.1, price_change_percentage_7d_in_currency: 0 }), 0.91)).toBe(true);
    expect(isNoise(coin({ symbol: "ousg", name: "Ondo Short-Term U.S. Government Bond Fund", current_price: 106.9 }))).toBe(true);
    expect(isNoise(coin({ symbol: "pc0000031", name: "Tradable NA Rent Financing Platform SSTN" }))).toBe(true);
    expect(isNoise(coin({ symbol: "wbtc", name: "Wrapped Bitcoin" }))).toBe(true);
    // Seen live: a slightly depegged dollar coin
    expect(isNoise(coin({ symbol: "apxusd", name: "apxUSD", current_price: 0.8776, price_change_percentage_30d_in_currency: -2.3, price_change_percentage_7d_in_currency: -3.3 }), 0.91)).toBe(true);
  });
  it("keeps ordinary coins", () => {
    expect(isNoise(coin({ symbol: "xmr", name: "Monero", current_price: 300, price_change_percentage_30d_in_currency: -12, price_change_percentage_7d_in_currency: 4 }))).toBe(false);
    expect(isNoise(coin({ symbol: "ada", name: "Cardano", current_price: 0.9, price_change_percentage_30d_in_currency: -12, price_change_percentage_7d_in_currency: -5 }), 0.91)).toBe(false);
  });
});
