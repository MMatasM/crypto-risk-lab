import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backtest, START_CAPITAL, type Strategy } from "../../src/analysis/backtest";
import { board, curves, pairCurve } from "../../src/paper/summary";
import { advance, checkConfig, mergeCloses, optionsFor, STRATEGIES, WARMUP_DAYS } from "../../src/paper/trader";
import { emptyState, type PaperConfig, type PaperState, type PriceFile, type TradeRecord } from "../../src/paper/types";
import { dates, randomWalk } from "../helpers";

const CONFIG: PaperConfig = {
  coins: ["bitcoin", "ethereum"],
  strategies: [...STRATEGIES],
  fee: 0.0025,
  slippage: 0.001,
  settings: { smaLength: 50, fast: 20, slow: 50, rsiBuyBelow: 30, rsiSellAbove: 70, dcaWeeks: 52 },
};

const SERIES: Record<string, number[]> = { bitcoin: randomWalk(320, 7, 60000), ethereum: randomWalk(320, 8, 3000, 0.05) };
const DATES = dates(320);

/** The price file as it would look after `n` days of closes. */
const pricesUpTo = (n: number, series = SERIES): PriceFile =>
  Object.fromEntries(Object.entries(series).map(([k, c]) => [k, { dates: DATES.slice(0, n), closes: c.slice(0, n) }]));

/** Runs the trader once a day from day `first` to day `last`, as the nightly job would. */
function daily(first: number, last: number, config = CONFIG, series = SERIES) {
  let state: PaperState = emptyState();
  const log: TradeRecord[] = [];
  for (let n = first + 1; n <= last + 1; n++) {
    const r = advance(state, pricesUpTo(n, series), config);
    state = r.state; log.push(...r.trades);
  }
  return { state, log };
}

describe("paper trading matches the backtester", () => {
  const { state } = daily(200, 319);
  for (const s of STRATEGIES) {
    it(`${s}: same value every day, same trades, on the same closes`, () => {
      for (const coin of CONFIG.coins) {
        const pair = state.coins[coin].pairs[s]!;
        expect(pair.startDate).toBe(DATES[200]);
        const bt = backtest(SERIES[coin], s, optionsFor(pair, 200));
        expect(pair.equity).toEqual(bt.eq); // exactly equal, not just close
        expect(pair.trades).toBe(bt.trades);
      }
    });
  }
  it("the costs really are charged (slippage on top of the fee)", () => {
    const pair = state.coins.bitcoin.pairs.hold!;
    const noSlip = backtest(SERIES.bitcoin, "hold", { ...optionsFor(pair, 200), slippage: 0 });
    expect(pair.equity[pair.equity.length - 1]).toBeLessThan(noSlip.final);
  });
});

describe("running twice and catching up", () => {
  it("running again with the same prices changes nothing and trades nothing", () => {
    const { state } = daily(200, 250);
    const again = advance(state, pricesUpTo(251), CONFIG);
    expect(again.trades).toEqual([]);
    expect(again.state).toEqual(state);
    expect(Object.keys(again.days)).toEqual([]);
  });

  it("missed days are traded in order and end up exactly as if every day had run", () => {
    const everyDay = daily(200, 300);
    // Ran on day 200, then the job didn't run for 100 days.
    const first = advance(emptyState(), pricesUpTo(201), CONFIG);
    const caught = advance(first.state, pricesUpTo(301), CONFIG);
    expect(caught.state).toEqual(everyDay.state);
    expect([...first.trades, ...caught.trades]).toEqual(everyDay.log);
    expect(caught.days.bitcoin).toEqual(DATES.slice(201, 301));
    const tradeDates = caught.trades.map(t => t.date);
    expect(tradeDates).toEqual([...tradeDates].sort());
  });

  it("a coin whose prices didn't arrive catches up later without touching the others", () => {
    const first = advance(emptyState(), pricesUpTo(201), CONFIG);
    const onlyBtc = pricesUpTo(205);
    onlyBtc.ethereum = pricesUpTo(201).ethereum; // ethereum's fetch failed for four days
    const mid = advance(first.state, onlyBtc, CONFIG);
    expect(mid.state.coins.ethereum.dates.length).toBe(1);
    expect(mid.state.coins.bitcoin.dates.length).toBe(5);
    const later = advance(mid.state, pricesUpTo(206), CONFIG);
    expect(later.state).toEqual(daily(200, 205).state);
  });

  it("starts on the newest close of the first run, and needs a warm-up first", () => {
    const r = advance(emptyState(), pricesUpTo(150), CONFIG);
    expect(r.state.startDate).toBe(DATES[149]);
    expect(r.state.lastDate).toBe(DATES[149]);
    const short = advance(emptyState(), pricesUpTo(WARMUP_DAYS), CONFIG);
    expect(short.state.startDate).toBeNull();
    expect(short.notes.join()).toMatch(/needs/);
  });
});

describe("fees and slippage", () => {
  // Flat at 100 for the warm-up, then up to 110 on the first traded day.
  const flat = [...Array(100).fill(100), 110, 110, 110];
  const one: PaperConfig = { ...CONFIG, coins: ["bitcoin"], strategies: ["hold", "dca"] };
  const r = advance(emptyState(), { bitcoin: { dates: dates(101), closes: flat.slice(0, 101) } }, one);

  it("a buy pays 0.25% fee and fills 0.10% above the close", () => {
    const t = r.trades.find(x => x.strategy === "hold")!;
    expect(t.side).toBe("buy");
    expect(t.amount).toBe(1000);
    expect(t.fee).toBeCloseTo(2.5, 10);
    expect(t.price).toBeCloseTo(110.11, 10);
    expect(t.units).toBeCloseTo(997.5 / 110.11, 12);
    expect(t.slippage).toBeCloseTo(997.5 - (997.5 / 110.11) * 110, 10);
    // Worth the coins at the close: €1,000 minus the fee minus the slippage.
    expect(r.state.coins.bitcoin.pairs.hold!.equity[0]).toBeCloseTo(1000 - t.fee - t.slippage, 10);
  });

  it("a sell receives the close minus 0.10%, minus 0.25% fee", () => {
    // Above its 5-day average on day 100, so it buys on day 101; below on day 101, so it sells on day 102.
    const c = [...Array(100).fill(100), 110, 90, 90, 90];
    const cfg: PaperConfig = { ...CONFIG, coins: ["bitcoin"], strategies: ["hold", "sma"], settings: { ...CONFIG.settings, smaLength: 5 } };
    let s = emptyState(); const log: TradeRecord[] = [];
    for (const n of [101, 102, 103]) { const x = advance(s, { bitcoin: { dates: dates(n), closes: c.slice(0, n) } }, cfg); s = x.state; log.push(...x.trades); }
    const [buy, sell] = log.filter(t => t.strategy === "sma");
    expect(buy.side).toBe("buy");
    expect(buy.date).toBe(dates(102)[101]);
    expect(sell.side).toBe("sell");
    expect(sell.price).toBeCloseTo(90 * 0.999, 10);
    const gross = buy.units * 90 * 0.999;
    expect(sell.fee).toBeCloseTo(gross * 0.0025, 10);
    expect(sell.amount).toBeCloseTo(gross * 0.9975, 10);
    expect(s.coins.bitcoin.pairs.sma!.cash).toBeCloseTo(sell.amount, 10);
    expect(buy.reason).toMatch(/above its 5-day average/);
    expect(sell.reason).toMatch(/not above its 5-day average/);
  });

  it("weekly DCA buys 1/52 of the €1,000 every 7th day", () => {
    const c = randomWalk(200, 3);
    const { state, log } = daily(100, 199, { ...one, strategies: ["hold", "dca"] }, { bitcoin: c });
    const buys = log.filter(t => t.strategy === "dca");
    expect(buys.map(t => t.date)).toEqual(DATES.slice(100, 200).filter((_, k) => k % 7 === 0));
    for (const b of buys) expect(b.amount).toBeCloseTo(START_CAPITAL / 52, 10);
    expect(buys[2].reason).toBe("Weekly buy 3 of 52");
    expect(state.coins.bitcoin.pairs.dca!.cash).toBeCloseTo(START_CAPITAL - buys.length * START_CAPITAL / 52, 8);
  });
});

describe("config changes", () => {
  it("a pair keeps the fee and settings it started with", () => {
    const first = advance(emptyState(), pricesUpTo(201), CONFIG);
    const cheaper: PaperConfig = { ...CONFIG, fee: 0, slippage: 0, settings: { ...CONFIG.settings, smaLength: 10 } };
    const later = advance(first.state, pricesUpTo(260), cheaper);
    expect(later.state).toEqual(advance(first.state, pricesUpTo(260), CONFIG).state);
  });

  it("a strategy or coin added later starts on the next day traded", () => {
    const partial: PaperConfig = { ...CONFIG, coins: ["bitcoin"], strategies: ["hold", "sma"] };
    const first = advance(emptyState(), pricesUpTo(201), partial);
    const later = advance(first.state, pricesUpTo(211), CONFIG);
    expect(later.state.coins.bitcoin.pairs.hold!.startDate).toBe(DATES[200]);
    expect(later.state.coins.bitcoin.pairs.macd!.startDate).toBe(DATES[201]);
    expect(later.state.coins.ethereum.pairs.hold!.startDate).toBe(DATES[210]);
    const macd = later.state.coins.bitcoin.pairs.macd!;
    expect(pairCurve(later.state, "bitcoin", macd).dates).toEqual(DATES.slice(201, 211));
    expect(macd.equity).toEqual(backtest(SERIES.bitcoin.slice(0, 211), "macd", optionsFor(macd, 201)).eq);
  });

  it("checkConfig accepts the shipped config and explains bad ones", () => {
    const shipped = JSON.parse(readFileSync("public/paper/config.json", "utf8")) as PaperConfig;
    expect(checkConfig(shipped)).toEqual([]);
    expect(shipped.fee).toBe(0.0025);
    expect(shipped.slippage).toBe(0.001);
    expect(checkConfig({ ...shipped, strategies: ["sma" as Strategy] }).join()).toMatch(/hold/);
    expect(checkConfig({ ...shipped, fee: 2.5 }).join()).toMatch(/fee/);
    expect(checkConfig({ ...shipped, coins: ["Bitcoin "] }).join()).toMatch(/coins/);
    expect(checkConfig({ ...shipped, settings: { ...shipped.settings, fast: 50, slow: 20 } }).join()).toMatch(/fast/);
  });
});

describe("mergeCloses", () => {
  const saved = { dates: ["2026-11-01", "2026-11-02", "2026-11-03"], closes: [100, 101, 102] };

  it("adds only finished days, and never changes a saved close", () => {
    const fetched = { dates: ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"], closes: [101.5, 102.2, 103, 104] };
    const m = mergeCloses(saved, fetched, "2026-11-05");
    expect(m.problem).toBeNull();
    expect(m.added).toBe(1);
    expect(m.closes).toEqual({ dates: ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"], closes: [100, 101, 102, 103] });
    expect(mergeCloses(m.closes, fetched, "2026-11-05").added).toBe(0); // the same fetch again adds nothing
  });

  it("refuses data that disagrees with the saved closes", () => {
    const usd = { dates: ["2026-11-02", "2026-11-03", "2026-11-04"], closes: [118, 119, 120] };
    const m = mergeCloses(saved, usd, "2026-11-10");
    expect(m.problem).toMatch(/don't match/);
    expect(m.closes).toBe(saved);
    expect(m.added).toBe(0);
  });

  it("refuses an implausible jump and bad numbers", () => {
    expect(mergeCloses(saved, { dates: ["2026-11-03", "2026-11-04"], closes: [102, 1020] }, "2026-11-10").problem).toMatch(/jump/);
    expect(mergeCloses(saved, { dates: ["2026-11-04"], closes: [Number.NaN] }, "2026-11-10").problem).toMatch(/bad price/);
  });

  it("takes the whole fetched history the first time", () => {
    const m = mergeCloses(undefined, { dates: ["2026-11-01", "2026-11-02"], closes: [1, 2] }, "2026-11-02");
    expect(m.closes).toEqual({ dates: ["2026-11-01"], closes: [1] });
  });
});

describe("leaderboard", () => {
  const { state } = daily(200, 260);
  it("ranks by return and compares with buy and hold", () => {
    const rows = board(curves(state, "bitcoin", STRATEGIES));
    expect(rows.length).toBe(6);
    for (let k = 1; k < rows.length; k++) expect(rows[k - 1].ret).toBeGreaterThanOrEqual(rows[k].ret);
    const hold = rows.find(r => r.strategy === "hold")!;
    expect(hold.vsHold).toBeNull();
    for (const r of rows) if (r !== hold) expect(r.vsHold).toBeCloseTo(r.ret - hold.ret, 12);
  });
  it("adds the coins together for the overall board", () => {
    const all = board(curves(state, null, STRATEGIES)).find(r => r.strategy === "hold")!;
    const btc = state.coins.bitcoin.pairs.hold!.equity.at(-1)!, eth = state.coins.ethereum.pairs.hold!.equity.at(-1)!;
    expect(all.capital).toBe(2000);
    expect(all.value).toBeCloseTo(btc + eth, 8);
  });
});
