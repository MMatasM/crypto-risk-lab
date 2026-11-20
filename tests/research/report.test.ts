import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LongTestFile } from "../../src/research/types";
import { longDetails, longVerdict } from "../../src/ui/longtest";

/** The published report and the screen that shows it must agree, whichever was changed last. */
describe("the long-term test's report in the app", () => {
  const lt = JSON.parse(readFileSync("public/data/longtest/report.json", "utf8")) as LongTestFile;
  it("has every phase, both horizons and every strategy", () => {
    for (const h of ["7", "30"]) {
      const r = lt.horizons[h];
      expect(r.overall.n).toBeGreaterThan(100000);
      expect(r.years.length).toBeGreaterThanOrEqual(7);
      expect(r.regimes.map(p => p.key)).toEqual(["above", "below"]);
      expect(r.years.reduce((s, p) => s + p.n, 0)).toBe(r.overall.n);
      expect(r.regimes.reduce((s, p) => s + p.n, 0)).toBe(r.overall.n);
    }
    expect(lt.strategies.market.rows.map(r => r.key)).toEqual(["hold", "dca", "sma", "cross", "macd", "rsi", "model-gbt", "model-logit"]);
    expect(lt.strategies.portfolio.rows.map(r => r.key)).toEqual(["topk-gbt", "topk-logit", "equal", "btc"]);
    for (const r of [...lt.strategies.market.rows, ...lt.strategies.portfolio.rows]) expect(r.years).toHaveLength(lt.strategies.years.length);
    expect(lt.strategies.fee).toBe(0.0025);
    expect(lt.strategies.slippage).toBe(0.001);
  });
  it("is shown for either model without a hole in the text", () => {
    for (const m of ["gbt", "logit"] as const) {
      const html = longVerdict(lt, m) + longDetails(lt, m), text = html.replace(/<[^>]+>/g, " ");
      expect(text).not.toMatch(/NaN|undefined|null|Infinity|\[object/);
      expect(html).toContain("Where the model fails");
      expect(html).toContain("Buy and hold Bitcoin");
      expect(html.match(/<table/g)!.length).toBeGreaterThanOrEqual(8);
    }
    expect(longVerdict(null, "gbt")).toBe("");
    expect(longDetails(undefined, "gbt")).toBe("");
  });
  it("only claims a win when the whole 95% range is on the better side", () => {
    for (const h of ["7", "30"]) for (const p of [lt.horizons[h].overall, ...lt.horizons[h].years, ...lt.horizons[h].regimes, ...lt.horizons[h].groups]) for (const m of ["gbt", "logit"] as const) {
      const b = p[m].vsBest;
      if (p[m].verdict === "better") expect(b.hi!).toBeLessThan(0);
      if (p[m].verdict === "worse") expect(b.lo!).toBeGreaterThan(0);
      if (p[m].verdict === "same") { expect(b.lo!).toBeLessThanOrEqual(0); expect(b.hi!).toBeGreaterThanOrEqual(0); }
    }
  });
});
