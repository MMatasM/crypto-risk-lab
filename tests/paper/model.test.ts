import { describe, expect, it } from "vitest";
import { START_CAPITAL } from "../../src/analysis/backtest";
import { advancePortfolio, checkPortfolioConfig, choose, emptyPortfolio, portfolioBoard, universe, type DaySignals, type PortfolioConfig, type PortfolioState, type PortfolioTrade } from "../../src/paper/portfolio";
import { board, curves, strategyName } from "../../src/paper/summary";
import { advance, checkConfig, PRICE_STRATEGIES, STRATEGIES, type Signals } from "../../src/paper/trader";
import { emptyState, type Closes, type PaperConfig, type PaperState, type PriceFile, type TradeRecord } from "../../src/paper/types";
import { dates, randomWalk } from "../helpers";

const N = 140, DATES = dates(N);
const SETTINGS = { smaLength: 50, fast: 20, slow: 50, rsiBuyBelow: 30, rsiSellAbove: 70, dcaWeeks: 52, modelThreshold: 0.55 };
const PORTFOLIO: PortfolioConfig = { k: 2, universe: 4, maxWeight: 0.4, rebalanceDays: 7, trendDays: 50 };
const CONFIG: PaperConfig = { coins: ["bitcoin", "ethereum"], strategies: [...STRATEGIES], fee: 0.0025, slippage: 0.001, settings: SETTINGS, portfolio: PORTFOLIO };

const SERIES: Record<string, number[]> = { bitcoin: randomWalk(N, 7, 60000), ethereum: randomWalk(N, 8, 3000, 0.05) };
const pricesUpTo = (n: number): PriceFile => Object.fromEntries(Object.entries(SERIES).map(([k, c]) => [k, { dates: DATES.slice(0, n), closes: c.slice(0, n) }]));

/** Runs the per-coin trader once a day from day `first` to day `last`, as the nightly job would. */
function daily(first: number, last: number, config: PaperConfig, signals: Signals, state: PaperState = emptyState()) {
  const log: TradeRecord[] = [];
  for (let n = first + 1; n <= last + 1; n++) { const r = advance(state, pricesUpTo(n), config, signals); state = r.state; log.push(...r.trades); }
  return { state, log };
}

describe("the per-coin model strategy", () => {
  // A forecast exists from day 104 on: high on even days, low on odd days.
  const signals: Signals = { bitcoin: {}, ethereum: {} };
  for (let i = 104; i < N; i++) { signals.bitcoin[DATES[i]] = i % 2 === 0 ? 0.7 : 0.4; signals.ethereum[DATES[i]] = 0.5; }

  it("doesn't start without a forecast, and leaves the other strategies exactly as they were", () => {
    const withModel = daily(100, 120, CONFIG, {});
    const without = daily(100, 120, { ...CONFIG, strategies: PRICE_STRATEGIES }, {});
    expect(withModel.state.coins.bitcoin.pairs.model).toBeUndefined();
    expect(withModel.state).toEqual(without.state);
    expect(withModel.log).toEqual(without.log);
  });

  it("starts on the first day that has a forecast from the day before, with fresh money", () => {
    const { state, log } = daily(100, 120, CONFIG, signals);
    const pair = state.coins.bitcoin.pairs.model!;
    expect(pair.startDate).toBe(DATES[105]);
    expect(pair.equity).toHaveLength(120 - 105 + 1);
    expect(pair.settings.modelThreshold).toBe(0.55);
    // The older strategies are untouched: same values as a run that never heard of the model.
    const without = daily(100, 120, { ...CONFIG, strategies: PRICE_STRATEGIES }, {});
    for (const s of PRICE_STRATEGIES) expect(state.coins.bitcoin.pairs[s]).toEqual(without.state.coins.bitcoin.pairs[s]);
    expect(log.filter(t => t.strategy !== "model")).toEqual(without.log);
  });

  it("decides from the forecast made after the previous close and trades at the day's close", () => {
    const { log } = daily(100, 120, CONFIG, signals);
    const mine = log.filter(t => t.strategy === "model" && t.coin === "bitcoin");
    // Day 105 uses day 104's forecast (0.70): buy. Day 106 uses day 105's (0.40): sell. And so on.
    expect(mine[0]).toMatchObject({ date: DATES[105], side: "buy", close: SERIES.bitcoin[105], amount: START_CAPITAL, reason: "7-day chance of a rise 70% was above 55%" });
    expect(mine[0].price).toBeCloseTo(SERIES.bitcoin[105] * 1.001, 8);
    expect(mine[0].fee).toBeCloseTo(2.5, 10);
    expect(mine[1]).toMatchObject({ date: DATES[106], side: "sell", reason: "7-day chance of a rise 40% was not above 55%" });
    expect(mine.map(t => t.side)).toEqual(Array.from({ length: 16 }, (_, k) => (k % 2 ? "sell" : "buy")));
    // Ethereum's forecast (0.50) never clears the threshold: it started, and stays in cash.
    expect(log.filter(t => t.strategy === "model" && t.coin === "ethereum")).toEqual([]);
  });

  it("a forecast can't change a trade on its own day", () => {
    const changed: Signals = structuredClone(signals);
    changed.bitcoin[DATES[120]] = 0.99; // made after day 120's close: it can only matter on day 121
    expect(daily(100, 120, CONFIG, changed).state).toEqual(daily(100, 120, CONFIG, signals).state);
  });

  it("keeps its position on a day with no forecast", () => {
    const gap: Signals = structuredClone(signals);
    delete gap.bitcoin[DATES[105]]; // would have said "sell" on day 106
    const mine = daily(100, 110, CONFIG, gap).log.filter(t => t.strategy === "model" && t.coin === "bitcoin");
    expect(mine.map(t => [t.date, t.side])).toEqual([[DATES[105], "buy"], [DATES[108], "sell"], [DATES[109], "buy"], [DATES[110], "sell"]]);
  });

  it("is compared with buying and holding over its own days, not since the older strategies began", () => {
    const { state } = daily(100, 120, CONFIG, signals);
    const cs = curves(state, "bitcoin", STRATEGIES), rows = board(cs);
    const model = rows.find(r => r.strategy === "model")!, sma = rows.find(r => r.strategy === "sma")!, hold = rows.find(r => r.strategy === "hold")!;
    expect(model.since).toBe(DATES[105]);
    expect(sma.vsHold).toBeCloseTo(sma.ret - hold.ret, 12);
    // Buying and holding from day 105: €1,000 less the fee and slippage, then Bitcoin's move to day 120.
    const freshHold = START_CAPITAL * (1 - 0.0025) / 1.001 * SERIES.bitcoin[120] / SERIES.bitcoin[105] / START_CAPITAL - 1;
    expect(model.vsHold).toBeCloseTo(model.ret - freshHold, 10);
    expect(strategyName("model", SETTINGS)).toBe("Model: 7-day chance above 55%");
  });

  it("checks the threshold", () => {
    expect(checkConfig(CONFIG)).toEqual([]);
    expect(checkConfig({ ...CONFIG, settings: { ...SETTINGS, modelThreshold: 2 } })).toHaveLength(1);
    expect(checkConfig({ ...CONFIG, portfolio: { ...PORTFOLIO, k: 0, maxWeight: 3 } })).toHaveLength(2);
    expect(checkPortfolioConfig(PORTFOLIO)).toEqual([]);
  });
});

describe("the top-k portfolio", () => {
  // Six coins; Bitcoin rises steadily for 100 days (an uptrend), then falls (a downtrend).
  const up = (i: number) => (i < 100 ? 100 * 1.004 ** i : 100 * 1.004 ** 100 * 0.985 ** (i - 100));
  const COINS = ["bitcoin", "aaa", "bbb", "ccc", "ddd", "eee"];
  const closesOf = (c: string): number[] => (c === "bitcoin" ? Array.from({ length: N }, (_, i) => up(i)) : randomWalk(N, 11 + COINS.indexOf(c), 10));
  const ALL: Record<string, number[]> = Object.fromEntries(COINS.map(c => [c, closesOf(c)]));
  const prices = (n: number): Record<string, Closes> => Object.fromEntries(COINS.map(c => [c, { dates: DATES.slice(0, n), closes: ALL[c].slice(0, n) }]));
  // The ranking: aaa and bbb are best; eee is the smallest coin, outside the universe of 4; from day 90 on ccc overtakes bbb.
  const sig = (i: number): DaySignals => ({
    composite: { bitcoin: 40, aaa: 80, bbb: i < 90 ? 70 : 20, ccc: i < 90 ? 30 : 75, ddd: 10, eee: 99 },
    mcapRank: { bitcoin: 1, aaa: 5, bbb: 8, ccc: 12, ddd: 20, eee: 150 },
    p: { bitcoin: 0.5, aaa: 0.6, bbb: i < 90 ? 0.58 : 0.3, ccc: i < 90 ? 0.4 : 0.62, ddd: 0.2, eee: 0.9 },
  });
  const signals = (from: number): Record<string, DaySignals> => Object.fromEntries(DATES.map((d, i) => [d, sig(i)] as const).filter((_, i) => i >= from));
  function run(first: number, last: number, sigs = signals(first - 1)) {
    let state: PortfolioState = emptyPortfolio();
    const log: PortfolioTrade[] = [], notes: string[] = [];
    for (let n = first + 1; n <= last + 1; n++) { const r = advancePortfolio(state, prices(n), sigs, CONFIG); state = r.state; log.push(...r.trades); notes.push(...r.notes); }
    return { state, log, notes };
  }

  it("picks the best of the biggest coins by the average of two percentile ranks", () => {
    expect(universe(sig(0), 4)).toEqual(["bitcoin", "aaa", "bbb", "ccc"]);
    const picks = choose(sig(0), PORTFOLIO);
    expect(picks.map(p => p.coin)).toEqual(["aaa", "bbb"]);
    expect(picks[0]).toMatchObject({ score: 1, composite: 80, p: 0.6 });
    expect(picks[1].score).toBeCloseTo(2 / 3, 12);
    expect(choose(sig(95), PORTFOLIO).map(p => p.coin)).toEqual(["aaa", "ccc"]); // a tie on score: alphabetical
    expect(choose({ composite: {}, mcapRank: {}, p: {} }, PORTFOLIO)).toEqual([]);
  });

  it("waits for a ranking, then starts all three with the same money on the same day", () => {
    const waiting = advancePortfolio(emptyPortfolio(), prices(61), {}, CONFIG);
    expect(waiting.state.startDate).toBeNull();
    expect(waiting.notes[0]).toMatch(/waiting for a ranking/);
    const { state, log } = run(60, 60);
    expect(state).toMatchObject({ startDate: DATES[60], lastDate: DATES[60], fee: 0.0025, slippage: 0.001, settings: PORTFOLIO, lastRebalance: DATES[60] });
    // Buy and hold Bitcoin: everything in, less the costs.
    expect(state.books.btc.equity[0]).toBeCloseTo(START_CAPITAL * (1 - 0.0025) / 1.001, 9);
    // Equal weight: a quarter in each of the four biggest coins.
    expect(log.filter(t => t.book === "equal").map(t => [t.coin, t.amount])).toEqual([["bitcoin", 250], ["aaa", 250], ["bbb", 250], ["ccc", 250]]);
    expect(state.books.equal.cash).toBeCloseTo(0, 9);
    // Top 2, each capped at 40% of the pot: 20% stays in cash.
    expect(log.filter(t => t.book === "topk").map(t => [t.coin, t.side, t.amount])).toEqual([["aaa", "buy", 400], ["bbb", "buy", 400]]);
    expect(state.books.topk.cash).toBeCloseTo(200, 9);
    expect(log.find(t => t.book === "topk")!.reason).toBe("Pick 1 of 2: composite score 80, 7-day chance of a rise 60%");
    expect(state.decision).toMatchObject({ date: DATES[60], rankedOn: DATES[59] });
  });

  it("rebalances once a week, from the ranking of the day before", () => {
    const { state, log } = run(60, 99);
    const days = [...new Set(log.filter(t => t.book === "topk").map(t => t.date))];
    for (const d of days) expect((DATES.indexOf(d) - 60) % 7).toBe(0);
    // The ranking changes on day 90 (ccc overtakes bbb). The next rebalance day is 95, deciding from day 94.
    const swap = log.filter(t => t.book === "topk" && t.date === DATES[95]);
    expect(swap.filter(t => t.side === "sell" && t.coin === "bbb")[0].reason).toBe("No longer in the top 2");
    expect(swap.some(t => t.side === "buy" && t.coin === "ccc")).toBe(true);
    expect(Object.keys(state.books.topk.units).sort()).toEqual(["aaa", "ccc"]);
    expect(state.books.btc.trades).toBe(1);
    expect(state.books.equal.trades).toBe(4);
    // A ranking for the same day can't change that day's trades.
    const sigs = signals(59);
    sigs[DATES[95]] = sig(0);
    expect(run(60, 95, sigs).log).toEqual(run(60, 95).log);
  });

  it("values each book as cash plus coins at the close, every day", () => {
    const { state } = run(60, 99);
    expect(state.dates).toEqual(DATES.slice(60, 100));
    for (const key of ["topk", "btc", "equal"] as const) {
      const b = state.books[key];
      expect(b.equity).toHaveLength(40);
      expect(b.equity[39]).toBeCloseTo(b.cash + Object.entries(b.units).reduce((s, [c, u]) => s + u * ALL[c][99], 0), 8);
    }
    const rows = portfolioBoard(state);
    expect(rows.map(r => r.book).sort()).toEqual(["btc", "equal", "topk"]);
    const topk = rows.find(r => r.book === "topk")!, btc = rows.find(r => r.book === "btc")!;
    expect(topk.name).toBe("Top-2 rotation");
    expect(topk.vsBtc).toBeCloseTo(topk.ret - btc.ret, 12);
    expect(btc.vsBtc).toBeNull();
  });

  it("goes to cash when Bitcoin closes below its average, and comes back at a weekly rebalance", () => {
    const { state, log } = run(60, 135);
    // Bitcoin turns down on day 100 and is below its 50-day average a couple of weeks later.
    const exit = log.filter(t => t.book === "topk" && /everything to cash/.test(t.reason));
    expect(exit.length).toBeGreaterThanOrEqual(2);
    expect(new Set(exit.map(t => t.date)).size).toBe(1);
    expect(state.books.topk.units).toEqual({});
    expect(state.books.topk.cash).toBeCloseTo(state.books.topk.equity[state.books.topk.equity.length - 1], 9);
    expect(state.decision!.note).toMatch(/in cash/);
    expect(state.decision!.picks).toEqual([]);
    // The benchmarks never trade again.
    expect(state.books.btc.trades).toBe(1);
  });

  it("running twice changes nothing, and catching up several days equals running daily", () => {
    const { state, log } = run(60, 110);
    const again = advancePortfolio(state, prices(111), signals(59), CONFIG);
    expect(again.trades).toEqual([]);
    expect(again.state).toEqual(state);
    // Start on day 60, then nothing until one catch-up run on day 110.
    const first = advancePortfolio(emptyPortfolio(), prices(61), signals(59), CONFIG);
    const late = advancePortfolio(first.state, prices(111), signals(59), CONFIG);
    expect(late.state).toEqual(state);
    expect([...first.trades, ...late.trades]).toEqual(log);
  });

  it("a rebalance without a ranking waits a day instead of being skipped for a week", () => {
    const sigs = signals(59);
    delete sigs[DATES[66]]; // the ranking the day-67 rebalance needs
    const { state, notes } = run(60, 70, sigs);
    expect(notes.some(n => /waits a day/.test(n))).toBe(true);
    expect(state.lastRebalance).toBe(DATES[68]);
  });

  it("isn't traded when the config has no portfolio", () => {
    const r = advancePortfolio(emptyPortfolio(), prices(61), signals(59), { ...CONFIG, portfolio: undefined });
    expect(r.state).toEqual(emptyPortfolio());
  });
});
