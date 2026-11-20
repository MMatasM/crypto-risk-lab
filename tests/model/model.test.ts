import { describe, expect, it } from "vitest";
import type { History } from "../../src/data/types";
import { btcRegime, buildSamples, coinFeatures, dayNumber, featureIndex, MIN_ROWS, P, type Sample } from "../../src/model/features";
import { fitGbt, gbtContributions, predictGbt } from "../../src/model/gbt";
import { contributions, fitLogistic, fitRidge, predictLogistic, score, solve } from "../../src/model/linear";
import { auc, blockInterval, calibration, calibrationError, compareBrier, scoreProbs, spearman } from "../../src/model/metrics";
import { evaluate, verdictText } from "../../src/model/report";
import { logPath, logToCsv, parseLog, resolve, trackRecord } from "../../src/model/track";
import type { LogRow } from "../../src/model/types";
import { fitModels, forecast, knownBefore, MODEL_DEFAULTS, probabilityBands, walkForward } from "../../src/model/walkforward";
import { dates, randomWalk } from "../helpers";

function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const normal = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
const hist = (n: number, seed: number, from = "2025-01-01"): History => ({ dates: dates(n, from), closes: randomWalk(n, seed), volumes: randomWalk(n, seed + 1000, 1e6, 0.2) });

describe("features", () => {
  const btc = hist(400, 1), coin = hist(400, 2), regime = btcRegime(btc);
  const rows = coinFeatures(coin, regime);
  it("needs enough history, then gives one value per input", () => {
    expect(rows.slice(0, MIN_ROWS - 1).every(r => r === null)).toBe(true);
    expect(rows[MIN_ROWS - 1]).toHaveLength(P);
    expect(rows[399]!.every(Number.isFinite)).toBe(true);
  });
  it("computes what the names say", () => {
    const c = coin.closes, x = rows[300]!;
    expect(x[featureIndex("ret7")]).toBeCloseTo(Math.log(c[300] / c[293]), 12);
    expect(x[featureIndex("ret90")]).toBeCloseTo(Math.log(c[300] / c[210]), 12);
    const avg20 = c.slice(281, 301).reduce((s, v) => s + v, 0) / 20;
    expect(x[featureIndex("dist20")]).toBeCloseTo(Math.log(c[300] / avg20), 10);
    expect(x[featureIndex("dd")]).toBeCloseTo(c[300] / Math.max(...c.slice(0, 301)) - 1, 12);
    expect(x[featureIndex("btcRet30")]).toBeCloseTo(Math.log(btc.closes[300] / btc.closes[270]), 12);
  });
  it("never looks ahead: changing later days leaves earlier rows exactly as they were", () => {
    const cut = 250;
    const changed = (h: History): History => ({ dates: h.dates, closes: h.closes.map((v, i) => (i > cut ? v * 3 : v)), volumes: h.volumes.map((v, i) => (i > cut ? v * 9 : v)) });
    const again = coinFeatures(changed(coin), btcRegime(changed(btc)));
    expect(again.slice(0, cut + 1)).toEqual(rows.slice(0, cut + 1));
    expect(again[cut + 1]).not.toEqual(rows[cut + 1]);
  });
  it("labels each day with the return to the close exactly 7 and 30 days later, or nothing", () => {
    const samples = buildSamples(new Map([["bitcoin", btc], ["coin", coin]]));
    const day = dayNumber(coin.dates[300]), s = samples.find(x => x.coin === "coin" && x.day === day)!;
    expect(s.fwd[7]).toBeCloseTo(Math.log(coin.closes[307] / coin.closes[300]), 12);
    expect(s.fwd[30]).toBeCloseTo(Math.log(coin.closes[330] / coin.closes[300]), 12);
    const late = samples.find(x => x.coin === "coin" && x.day === dayNumber(coin.dates[395]))!;
    expect(late.fwd).toEqual({ 7: null, 30: null });
    // A missing day is not papered over: the label needs the close on the exact day.
    const gap: History = { dates: coin.dates.filter((_, i) => i !== 307), closes: coin.closes.filter((_, i) => i !== 307), volumes: coin.volumes.filter((_, i) => i !== 307) };
    const g = buildSamples(new Map([["bitcoin", btc], ["coin", gap]])).find(x => x.coin === "coin" && x.day === day)!;
    expect(g.fwd[7]).toBeNull();
    expect(g.fwd[30]).toBeCloseTo(s.fwd[30]!, 12);
  });
});

describe("linear models", () => {
  it("solves equations", () => {
    expect(solve([[4, 1], [1, 3]], [1, 2]).map(v => +v.toFixed(6))).toEqual([+(1 / 11).toFixed(6), +(7 / 11).toFixed(6)]);
  });
  const r = rng(5), n = 20000;
  const X = Array.from({ length: n }, () => [normal(r), normal(r) * 3 + 10, normal(r)]);
  it("logistic regression recovers the weights the data was made with", () => {
    const y = X.map(x => (r() < 1 / (1 + Math.exp(-(0.4 + 1.2 * x[0] - 0.8 * (x[1] - 10) / 3))) ? 1 : 0));
    const m = fitLogistic(X, y, 1e-6);
    expect(m.w[0]).toBeCloseTo(1.2, 1);
    expect(m.w[1]).toBeCloseTo(-0.8, 1);
    expect(Math.abs(m.w[2])).toBeLessThan(0.06);
    expect(m.b).toBeCloseTo(0.4, 1);
    const x = [1, 13, 0];
    expect(predictLogistic(m, x)).toBeCloseTo(1 / (1 + Math.exp(-(0.4 + 1.2 - 0.8))), 1);
    expect(m.b + contributions(m, x).reduce((s, v) => s + v, 0)).toBeCloseTo(score(m, x), 10);
  });
  it("a bigger penalty shrinks the weights", () => {
    const y = X.map(x => (r() < 1 / (1 + Math.exp(-x[0])) ? 1 : 0));
    expect(Math.abs(fitLogistic(X, y, 1).w[0])).toBeLessThan(Math.abs(fitLogistic(X, y, 0.001).w[0]) / 2);
  });
  it("ridge regression recovers a straight line", () => {
    const y = X.map(x => 0.02 + 0.05 * x[0] - 0.01 * (x[1] - 10) + 0.001 * normal(r));
    const m = fitRidge(X, y, 1e-9);
    expect(score(m, [1, 10, 0])).toBeCloseTo(0.07, 3);
    expect(score(m, [0, 13, 5])).toBeCloseTo(-0.01, 3);
  });
});

describe("boosted trees", () => {
  const r = rng(11), n = 4000;
  const X = Array.from({ length: n }, () => [normal(r), normal(r), normal(r)]);
  const y = X.map(x => ((x[0] > 0) !== (x[1] > 0) ? (r() < 0.9 ? 1 : 0) : (r() < 0.1 ? 1 : 0))); // an "only when" pattern
  const m = fitGbt(X, y, { trees: 60, rate: 0.2 });
  it("learns a pattern a straight-line model can't", () => {
    const acc = (p: (x: number[]) => number) => X.filter((x, i) => (p(x) > 0.5 ? 1 : 0) === y[i]).length / n;
    expect(acc(x => predictGbt(m, x))).toBeGreaterThan(0.85);
    const lin = fitLogistic(X, y, 0.01);
    expect(acc(x => predictLogistic(lin, x))).toBeLessThan(0.6);
    expect(m.importance[2]).toBeLessThan(0.05);
    expect(m.importance.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 10);
  });
  it("gives the same model for the same seed, and its parts add up to the forecast", () => {
    const again = fitGbt(X, y, { trees: 60, rate: 0.2 });
    const x = [0.7, -1.1, 0.2];
    expect(predictGbt(again, x)).toBe(predictGbt(m, x));
    const roots = m.trees.reduce((s, t) => s + m.rate * t[0].value, 0);
    const logOdds = m.base + roots + gbtContributions(m, x).reduce((s, v) => s + v, 0);
    expect(1 / (1 + Math.exp(-logOdds))).toBeCloseTo(predictGbt(m, x), 10);
  });
});

describe("metrics", () => {
  it("scores forecasts", () => {
    const s = scoreProbs([0.9, 0.8, 0.3, 0.6], [1, 1, 0, 0]);
    expect(s.accuracy).toBe(0.75);
    expect(s.brier).toBeCloseTo((0.01 + 0.04 + 0.09 + 0.36) / 4, 12);
    expect(s.auc).toBe(1);
    expect(auc([0.5, 0.5, 0.5], [1, 0, 1])).toBe(0.5);
    expect(scoreProbs([0.5, 0.5], [1, 0]).brier).toBe(0.25);
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 12);
  });
  it("measures calibration", () => {
    const p = [...new Array(100).fill(0.25), ...new Array(100).fill(0.75)], y = p.map((v, i) => (v === 0.25 ? (i % 4 === 0 ? 1 : 0) : (i % 4 === 0 ? 0 : 1)));
    const bins = calibration(p, y);
    expect(bins).toHaveLength(2);
    expect(bins[0]).toMatchObject({ n: 100, predicted: 0.25, observed: 0.25 });
    expect(calibrationError(bins)).toBeCloseTo(0, 12);
    expect(calibrationError(calibration(new Array(10).fill(0.9), new Array(10).fill(0)))).toBeCloseTo(0.9, 12);
  });
  it("only calls a difference real when it holds across independent periods", () => {
    const day = Array.from({ length: 700 }, (_, i) => Math.floor(i / 10)); // 70 days, 10 coins a day
    const y = day.map(d => (d % 2 ? 1 : 0));
    const good = y.map(v => (v ? 0.7 : 0.3)), flip = y.map(() => 0.5);
    expect(compareBrier(good, flip, y, day, 14).verdict).toBe("better");
    expect(compareBrier(flip, good, y, day, 14).verdict).toBe("worse");
    expect(compareBrier(flip, flip, y, day, 14).verdict).toBe("same");
    // The same forecasts over too few periods: no verdict at all.
    expect(compareBrier(good, flip, y, day, 30)).toMatchObject({ verdict: "unknown", blocks: 3, lo: null });
    // Right in one lucky period only: the many rows inside it don't make it significant.
    const lucky = y.map((v, i) => (day[i] < 14 ? (v ? 0.99 : 0.01) : 0.5 + (i % 2 ? 0.01 : -0.01)));
    expect(compareBrier(lucky, flip, y, day, 14).verdict).toBe("same");
    expect(blockInterval([], [], 14).blocks).toBe(0);
  });
});

/** The real settings with fewer trees, to keep the slower tests quick. */
const QUICK = { ...MODEL_DEFAULTS, gbt: { trees: 25 } };

/** Samples with `coins` coins a day, where the chance of a rise depends on input 0 as strongly as `signal` says. */
function synthetic(days: number, coins: number, signal: number, seed: number): Sample[] {
  const r = rng(seed), out: Sample[] = [];
  for (let d = 0; d < days; d++) for (let c = 0; c < coins; c++) {
    const x = Array.from({ length: P }, () => normal(r) * 0.05);
    x[featureIndex("vol30")] = 0.04;
    const ret = signal * x[0] + 0.05 * normal(r);
    out.push({ coin: "c" + c, day: 20000 + d, x, fwd: { 7: d + 7 < days ? ret : null, 30: d + 30 < days ? ret : null } });
  }
  return out;
}

describe("walk-forward test", () => {
  it("trains only on outcomes known before the test days, with a gap of the horizon", () => {
    const samples = synthetic(200, 8, 1, 3);
    for (const h of [7, 30] as const) {
      const wf = walkForward(samples, h);
      expect(wf.folds).toBeGreaterThan(5);
      for (const s of wf.steps) expect(s.trainedThrough + h).toBeLessThan(s.start);
      expect(Math.min(...wf.rows.map(r => r.day))).toBe(wf.steps[0].start);
      // Each forecast is made once.
      expect(new Set(wf.rows.map(r => r.coin + r.day)).size).toBe(wf.rows.length);
    }
    expect(knownBefore(samples, 7, 20100).every(s => s.day + 7 < 20100)).toBe(true);
    expect(knownBefore(samples, 7, 20100).some(s => s.day === 20092)).toBe(true);
    expect(walkForward(synthetic(60, 5, 1, 3), 7).rows).toHaveLength(0); // too little history: no test at all
  });
  it("finds a real pattern and says so", () => {
    const wf = walkForward(synthetic(260, 20, 2, 4), 7, QUICK), rep = evaluate(wf.rows, 7);
    expect(rep.logit.accuracy).toBeGreaterThan(0.6);
    expect(rep.logit.brier).toBeLessThan(rep.base.brier);
    expect(rep.verdict.logit).toBe("better");
    expect(rep.rankSkill.logit.mean).toBeGreaterThan(0.2);
    expect(rep.ret.r2).toBeGreaterThan(0.2);
    expect(rep.ret.coverage).toBeGreaterThan(0.7);
    expect(rep.ret.coverage).toBeLessThan(0.9);
    expect(verdictText(rep, "logit")).toMatch(/beat the best baseline/);
  }, 60000);
  it("does not claim skill on pure noise", () => {
    for (const seed of [5, 6]) {
      const rep = evaluate(walkForward(synthetic(260, 20, 0, seed), 7, QUICK).rows, 7);
      expect(rep.verdict.logit).not.toBe("better");
      expect(rep.verdict.gbt).not.toBe("better");
      expect(rep.logit.accuracy).toBeLessThan(0.56);
      expect(verdictText(rep, "logit")).not.toMatch(/beat the best baseline/);
    }
  }, 60000);
  it("does not claim skill on random-walk prices either", () => {
    const histories = new Map<string, History>([["bitcoin", hist(365, 1)]]);
    for (let k = 2; k <= 25; k++) histories.set("coin" + k, hist(365, k * 7));
    const rep = evaluate(walkForward(buildSamples(histories), 7, QUICK).rows, 7);
    expect(rep.n).toBeGreaterThan(2000);
    expect(rep.verdict.logit).not.toBe("better");
    expect(rep.verdict.gbt).not.toBe("better");
  }, 60000);
  it("gives a verdict of 'unknown' when there are too few independent periods", () => {
    const rep = evaluate(walkForward(synthetic(230, 10, 2, 8), 30, QUICK).rows, 30);
    expect(rep.n).toBeGreaterThan(0);
    expect(rep.verdict.logit).toBe("unknown");
    expect(verdictText(rep, "logit")).toMatch(/Too little history/);
  });
  it("forecasts with a range, and the range for a probability covers the forecast's neighbourhood", () => {
    const samples = synthetic(200, 10, 2, 9), train = knownBefore(samples, 7, 20201);
    const f = fitModels(train, 7), x = samples[samples.length - 1].x, p = forecast(f, x);
    expect(p.lo).toBeLessThan(p.mu);
    expect(p.hi).toBeGreaterThan(p.mu);
    expect(p.base).toBeGreaterThan(0.3);
    expect(p.base).toBeLessThan(0.7);
    const [lo, hi] = probabilityBands(train, 7, [x], undefined, 20)[0];
    expect(lo).toBeLessThanOrEqual(hi);
    expect(Math.abs((lo + hi) / 2 - p.logit)).toBeLessThan(0.1);
  });
});

describe("forecast log and live record", () => {
  const row = (date: string, coin: string, h: 7 | 30, logit: number): LogRow => ({ date, coin, h, logit, gbt: 0.5, base: 0.45, momentum: 0.4, trendUp: false, mu: 0.01, lo: -0.1, hi: 0.1 });
  it("round-trips through CSV", () => {
    const rows = [row("2026-11-19", "bitcoin", 7, 0.5312), row("2026-11-19", "bitcoin", 30, 0.4)];
    expect(parseLog(logToCsv(rows))).toEqual(rows);
    expect(logPath("2026-11-19")).toBe("2026-11/2026-11-19.csv");
    expect(() => parseLog("nonsense\n")).toThrow();
  });
  it("scores a forecast only once the close exactly h days later exists", () => {
    const h: History = { dates: dates(10, "2026-11-19"), closes: [100, 101, 102, 103, 104, 105, 106, 110, 90, 95], volumes: new Array(10).fill(1) };
    const histories = new Map([["bitcoin", h]]);
    const log = [row("2026-11-19", "bitcoin", 7, 0.7), row("2026-11-20", "bitcoin", 7, 0.7), row("2026-11-25", "bitcoin", 7, 0.7), row("2026-11-19", "bitcoin", 30, 0.7), row("2026-11-19", "unknown-coin", 7, 0.7)];
    const { rows, pending } = resolve(log, histories, 7);
    expect(rows.map(r => r.y)).toEqual([1, 0]);
    expect(rows[0].r).toBeCloseTo(Math.log(1.1), 12);
    expect(pending).toBe(2);
    const t = trackRecord(log, histories, "now");
    expect(t).toMatchObject({ since: "2026-11-19", latest: "2026-11-25", nights: 3 });
    expect(t.horizons[7]).toMatchObject({ n: 2, pending: 2, firstResolves: "2026-11-26" });
    expect(t.horizons[7].logit.accuracy).toBe(0.5);
    expect(t.horizons[30]).toMatchObject({ n: 0, pending: 1, firstResolves: "2026-12-19" });
    expect(verdictText(t.horizons[30], "logit")).toMatch(/No forecasts have been scored yet/);
  });
});
