/** Risk, trend and composite scores, classification and rule states for one coin. */
import type { History, MarketCoin } from "../data/types";
import { clamp, corr, logrets, normCdf, pct, std } from "./math";
import { maxDrawdown, rsi, sma } from "./indicators";

export type Tone = "good" | "warn" | "bad" | "neutral";
export type TierKey = "mega" | "large" | "mid" | "small" | "micro" | "unknown";
export interface Tier { k: TierKey; t: string; r: number }

export function tierOf(mcap: number | null | undefined): Tier {
  if (!mcap) return { k: "unknown", t: "Unknown size", r: 70 };
  if (mcap >= 50e9) return { k: "mega", t: "Mega cap", r: 5 };
  if (mcap >= 10e9) return { k: "large", t: "Large cap", r: 25 };
  if (mcap >= 1e9) return { k: "mid", t: "Mid cap", r: 50 };
  if (mcap >= 100e6) return { k: "small", t: "Small cap", r: 75 };
  return { k: "micro", t: "Micro cap", r: 95 };
}

export function volClass(v: number): { t: string; k: Tone } {
  return v < 0.5 ? { t: "Low volatility (for crypto)", k: "good" }
    : v < 0.8 ? { t: "Medium volatility", k: "neutral" }
    : v < 1.2 ? { t: "High volatility", k: "warn" }
    : { t: "Extreme volatility", k: "bad" };
}

/** The minimum number of daily closes the full analysis needs. */
export const MIN_DAYS = 61;

export function analyze(hist: History, btcHist: History | null | undefined, mkt: MarketCoin | null | undefined) {
  const c = hist.closes, n = c.length, p = c[n - 1];
  const r = logrets(c);
  const annual = (x: number[]) => std(x) * Math.sqrt(365);
  const vol90 = annual(r.slice(-90)), vol30 = annual(r.slice(-30)), volAll = annual(r);
  const ret = (d: number) => (n > d ? c[n - 1] / c[n - 1 - d] - 1 : null);
  const longN = Math.min(200, Math.floor(n * 0.55));
  const s50 = sma(c, 50), s200 = sma(c, longN);
  const rs = rsi(c);
  const high = Math.max(...c), dd = p / high - 1, mdd = maxDrawdown(c);

  let corrBtc: number | null = null;
  if (btcHist && btcHist !== hist) {
    const map = new Map(btcHist.dates.map((d, i) => [d, btcHist.closes[i]]));
    const a: number[] = [], b: number[] = [];
    for (let i = 1; i < n; i++) {
      const b0 = map.get(hist.dates[i - 1]), b1 = map.get(hist.dates[i]);
      if (b0 != null && b1 != null) { a.push(Math.log(c[i] / c[i - 1])); b.push(Math.log(b1 / b0)); }
    }
    if (a.length > 40) corrBtc = corr(a.slice(-90), b.slice(-90));
  }

  const s30 = vol90 / Math.sqrt(365) * Math.sqrt(30);
  const model = {
    sigma: s30,
    lo68: p * Math.exp(-s30), hi68: p * Math.exp(s30),
    lo95: p * Math.exp(-1.96 * s30), hi95: p * Math.exp(1.96 * s30),
    pDrop20: s30 > 0 ? normCdf(Math.log(0.8) / s30) : 0,
    pRise20: s30 > 0 ? 1 - normCdf(Math.log(1.2) / s30) : 0,
  };

  const roll: number[] = [];
  for (let i = 30; i < n; i++) roll.push(c[i] / c[i - 30] - 1);
  const emp = roll.length > 20 ? {
    p5: pct(roll, 0.05), p10: pct(roll, 0.10), p25: pct(roll, 0.25), p50: pct(roll, 0.5),
    p75: pct(roll, 0.75), p90: pct(roll, 0.90), p95: pct(roll, 0.95),
    share20down: roll.filter(x => x <= -0.2).length / roll.length,
    share20up: roll.filter(x => x >= 0.2).length / roll.length,
  } : null;
  const rr = emp && emp.p10 < 0 ? Math.max(emp.p90, 0) / Math.abs(emp.p10) : null;

  const mcap = mkt?.market_cap || null, v24 = mkt?.total_volume || null;
  const liq = mcap && v24 ? v24 / mcap : null;
  const riskParts = {
    volatility: clamp((vol90 - 0.30) / (1.50 - 0.30)) * 100,
    drawdown: clamp(-mdd / 0.85) * 100,
    size: mcap ? clamp((Math.log10(100e9) - Math.log10(mcap)) / 3) * 100 : 60,
    liquidity: liq ? clamp((Math.log10(0.05) - Math.log10(liq)) / 1) * 100 : 50,
  };
  const risk = 0.40 * riskParts.volatility + 0.25 * riskParts.drawdown + 0.25 * riskParts.size + 0.10 * riskParts.liquidity;

  const sL = s200[n - 1], sS = s50[n - 1], R = rs[n - 1] ?? 50, r90 = ret(90), r30 = ret(30);
  const trendParts = {
    aboveLong: sL != null ? (p > sL ? 25 : 0) : 0,
    cross: sS != null && sL != null ? (sS > sL ? 20 : 0) : 0,
    ret90: r90 != null ? 25 * clamp((r90 + 0.3) / 0.6) : 0,
    ret30: r30 != null ? 15 * clamp((r30 + 0.15) / 0.3) : 0,
    rsi: R >= 45 && R <= 70 ? 15 : (R > 70 || (R >= 35 && R < 45)) ? 8 : 0,
  };
  const trend = Object.values(trendParts).reduce((s, x) => s + x, 0);
  const composite = 0.6 * trend + 0.4 * (100 - risk);

  let cls: { k: Tone; t: string; d: string };
  if (trend >= 60 && risk < 45) cls = { k: "good", t: "Steady uptrend", d: "Trend is strong and risk is moderate for crypto. The kind of coin a cautious trend-follower would hold." };
  else if (trend >= 60) cls = { k: "warn", t: "High potential, high risk", d: "Trend is strong, but swings are large. Size positions small and expect deep pullbacks." };
  else if (trend < 40 && risk < 45) cls = { k: "neutral", t: "Out of favour, watch", d: "Established coin in a weak trend. Rules suggest waiting for the trend to turn rather than catching the fall." };
  else if (trend < 40) cls = { k: "bad", t: "Avoid for now", d: "Weak trend plus high risk. Historically the worst combination to buy into." };
  else cls = { k: "neutral", t: "Mixed, no clear trend", d: "Signals disagree. Fine for slow DCA, not a strong case either way." };

  const tags: string[] = [];
  if (risk >= 75) tags.push("Speculative");
  if (liq != null && liq < 0.01) tags.push("Thin trading");
  if (vol30 > volAll * 1.5) tags.push("Volatility spike");

  let lastCross: { days: number; golden: boolean } | null = null;
  if (sL != null) {
    for (let i = n - 1; i > 0; i--) {
      const a = s50[i], b = s200[i], a0 = s50[i - 1], b0 = s200[i - 1];
      if (a != null && b != null && a0 != null && b0 != null && (a > b) !== (a0 > b0)) { lastCross = { days: n - 1 - i, golden: a > b }; break; }
    }
  }

  const up = sL != null ? p > sL : null;
  let lean: { k: Tone; t: string; d: string };
  if (up === null) lean = { k: "neutral", t: "Not enough history", d: "Need more daily data for the trend rules." };
  else if (up && R > 70) lean = { k: "warn", t: "Hold, don't chase", d: "Uptrend, but momentum is overheated (RSI above 70). Buying here has often meant buying a short-term top." };
  else if (up) lean = { k: "good", t: "Rules lean: buy / accumulate", d: `Price is above its ${longN}-day average and momentum isn't overheated.` };
  else if (R < 30) lean = { k: "warn", t: "Oversold in a downtrend", d: "Short-term bounces are common from here, but the trend is down. Small DCA amounts at most." };
  else lean = { k: "bad", t: "Rules lean: stay out / reduce", d: `Price is below its ${longN}-day average. Trend-following rules sit in cash here.` };

  return {
    p, n, vol30, vol90, volAll, ret7: ret(7), ret30: r30, ret90: r90, retAll: c[n - 1] / c[0] - 1,
    s50, s200, longN, rsi: rs, R, high, dd, mdd, corrBtc, model, emp, rr,
    mcap, v24, liq, risk, riskParts, trend, trendParts, composite, cls, tags, lastCross, up, lean,
    tier: tierOf(mcap), volc: volClass(vol90),
  };
}

export type Analysis = ReturnType<typeof analyze>;
