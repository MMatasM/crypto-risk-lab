import { describe, expect, it } from "vitest";
import { ApiError, type CoinGeckoClient } from "../../src/data/coingecko";
import { closeDay, HISTORY_TTL, parseMarketChart, Repository, slimCoin } from "../../src/data/repository";
import { memoryStore } from "../../src/data/storage";
import { withLivePrice } from "../../src/app";
import { eur } from "../../src/ui/format";

const midnight = (d: string) => Date.parse(d + "T00:00:00Z");

describe("parseMarketChart", () => {
  it("counts a 00:00 UTC point as the previous day's close and the last point as today", () => {
    // What CoinGecko really sends: daily points at midnight, then the current price.
    const prices: [number, number][] = [
      [midnight("2026-11-17"), 10], [midnight("2026-11-18"), 11], [Date.parse("2026-11-18T21:48:50Z"), 12],
    ];
    const h = parseMarketChart({ prices, total_volumes: prices.map(([t]) => [t, 5]) });
    expect(h.dates).toEqual(["2026-11-16", "2026-11-17", "2026-11-18"]);
    expect(h.closes).toEqual([10, 11, 12]); // no day is lost or overwritten
    expect(h.volumes).toEqual([5, 5, 5]);
  });
  it("drops zero, negative and missing prices", () => {
    const h = parseMarketChart({ prices: [[midnight("2026-01-02"), 0], [midnight("2026-01-03"), null], [midnight("2026-01-04"), -1], [midnight("2026-01-05"), 2]] });
    expect(h.closes).toEqual([2]);
    expect(h.volumes).toEqual([0]);
  });
  it("handles a reply with no prices at all", () => {
    expect(parseMarketChart({})).toEqual({ dates: [], closes: [], volumes: [] });
  });
  it("closeDay", () => {
    expect(closeDay(midnight("2026-03-01"))).toBe("2026-02-28");
    expect(closeDay(Date.parse("2026-03-01T00:00:01Z"))).toBe("2026-03-01");
  });
});

describe("slimCoin", () => {
  it("turns missing or broken numbers into null and keeps only known fields", () => {
    const c = slimCoin({ id: "a", symbol: "a", name: "A", current_price: "12", market_cap: null, roi: { x: 1 } });
    expect(c.current_price).toBeNull();
    expect(c.market_cap).toBeNull();
    expect("roi" in c).toBe(false);
  });
});

describe("Repository caching", () => {
  function fake(reply: () => unknown) {
    let calls = 0;
    const api = { get: async () => { calls++; return reply(); } } as unknown as CoinGeckoClient;
    let t = 1e12;
    const repo = new Repository(api, memoryStore(), () => t);
    return { repo, calls: () => calls, advance: (ms: number) => { t += ms; } };
  }
  const chart = { prices: [[midnight("2026-01-02"), 1], [midnight("2026-01-03"), 2]] };

  it("uses a fresh saved copy without a request", async () => {
    const f = fake(() => chart);
    await f.repo.history("btc");
    const again = await f.repo.history("btc");
    expect(f.calls()).toBe(1);
    expect(again.stale).toBe(false);
  });
  it("falls back to the old copy, marked stale, when the network fails", async () => {
    let fail = false;
    const f = fake(() => { if (fail) throw new ApiError("network", "down"); return chart; });
    await f.repo.history("btc");
    f.advance(HISTORY_TTL + 1);
    fail = true;
    const r = await f.repo.history("btc");
    expect(r.stale).toBe(true);
    expect(r.data.closes).toEqual([1, 2]);
  });
  it("does not hide a rejected key behind old data", async () => {
    let fail = false;
    const f = fake(() => { if (fail) throw new ApiError("auth", "bad key"); return chart; });
    await f.repo.history("btc");
    f.advance(HISTORY_TTL + 1);
    fail = true;
    await expect(f.repo.history("btc")).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("withLivePrice", () => {
  const h = { dates: ["2026-11-17", "2026-11-18"], closes: [10, 11], volumes: [1, 1] };
  const m = (day: string, px: number) => slimCoin({ id: "a", symbol: "a", name: "A", current_price: px, last_updated: day + "T12:00:00Z" });
  it("replaces today's close with the newer market price", () => {
    expect(withLivePrice(h, m("2026-11-18", 12)).closes).toEqual([10, 12]);
  });
  it("adds a day when the saved history is from yesterday", () => {
    const r = withLivePrice(h, m("2026-11-19", 13));
    expect(r.dates).toEqual(["2026-11-17", "2026-11-18", "2026-11-19"]);
    expect(r.closes).toEqual([10, 11, 13]);
  });
  it("ignores older market data", () => {
    expect(withLivePrice(h, m("2026-11-16", 99))).toBe(h);
  });
});

describe("eur formatting of real prices", () => {
  it("shows meaningful digits for tiny prices", () => {
    expect(eur(2.8193e-7)).toBe("€0.000000282");
    expect(eur(0.00000345)).toBe("€0.00000345");
    expect(eur(56819)).toBe("€56,819.00");
    expect(eur(null)).toBe("—");
  });
});
