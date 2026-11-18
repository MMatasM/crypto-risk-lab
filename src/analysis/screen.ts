/** The Discover screen: quick risk, pattern and score from market data alone (no history needed). */
import type { MarketCoin } from "../data/types";
import { clamp } from "./math";
import { tierOf, type Tone } from "./scoring";

const STABLE = new Set("usdt usdc dai fdusd tusd usde usds pyusd usdd frax eurc eurs usd1 rlusd gusd lusd busd usdp susd usdx usd0 eure xaut paxg usdb usdg usdf susde susds buidl ustb usyc bfusd usdtb gho usx usat ylds sofid".split(" "));
const WRAPPED = /(^wrapped|bridged|^staked|restaked|liquid stak|staked ether|stake pool|\(wormhole\))/i;
const WRAPSYM = new Set("wbtc weth steth wsteth cbbtc weeth reth meth lbtc solvbtc jitosol msol bnsol cbeth ezeth rseth tbtc wbeth stsol jupsol lseth oseth sweth wbnb weeth.base clbtc fbtc".split(" "));
/** Tokenized funds, bonds, T-bills, credit notes and stocks: listed on CoinGecko but not crypto assets in the usual sense. */
const TOKENIZED = /\b(fund|t-bills?|treasury|treasuries|money market|bond|clo|sstn|ssl|sstl|warrants?|xstock|tokenized|vault|heloc)\b/i;

/**
 * True for coins the Discover list hides by default: stablecoins, wrapped or staked copies of other coins,
 * tokenized funds and securities, and anything that hardly moves and sits on a peg.
 * `usdInEur` is the EUR price of one US dollar (taken from USDT or USDC in the same list).
 */
export function isNoise(m: MarketCoin, usdInEur = 0.9): boolean {
  const s = (m.symbol || "").toLowerCase(), name = m.name || "";
  if (STABLE.has(s) || WRAPSYM.has(s)) return true;
  if (WRAPPED.test(name) || TOKENIZED.test(name) || /^pc0{3,}\d+$/.test(s)) return true;
  const c30 = m.price_change_percentage_30d_in_currency, c7 = m.price_change_percentage_7d_in_currency;
  const still = Math.abs(c30 ?? 0) < 2.5 && Math.abs(c7 ?? 0) < 2.5;
  if (/usd|eur/i.test(s) && Math.abs(c30 ?? 0) < 5) return true; // dollar or euro coins, including slightly depegged ones
  const px = m.current_price ?? 0;
  const pegged = Math.abs(px / usdInEur - 1) < 0.03 || Math.abs(px - 1) < 0.03;
  if (still && (pegged || !m.total_volume)) return true;
  return false;
}

/** EUR value of 1 USD, read from a dollar stablecoin in the list (falls back to 0.9). */
export function usdRate(list: readonly MarketCoin[]): number {
  const s = list.find(m => m.id === "tether" || m.id === "usd-coin");
  return s?.current_price && s.current_price > 0.5 && s.current_price < 1.5 ? s.current_price : 0.9;
}

export function screen(m: MarketCoin) {
  const t = tierOf(m.market_cap);
  const f = (x: number | null | undefined) => (x == null ? null : x / 100);
  const c7 = f(m.price_change_percentage_7d_in_currency), c30 = f(m.price_change_percentage_30d_in_currency), c1y = f(m.price_change_percentage_1y_in_currency);
  const ath = f(m.ath_change_percentage);
  const liq = m.market_cap && m.total_volume != null ? m.total_volume / m.market_cap : null;
  const c30v = c30 ?? 0, c7v = c7 ?? 0;
  const risk = 0.5 * t.r + 0.3 * clamp(Math.abs(c30v) / 0.6) * 100 + 0.2 * clamp(-(ath ?? -0.5) / 0.95) * 100;
  const rk: { t: string; k: Tone } = risk < 30 ? { t: "Low", k: "good" } : risk < 50 ? { t: "Medium", k: "neutral" } : risk < 70 ? { t: "High", k: "warn" } : { t: "Very high", k: "bad" };

  let pat: { t: string; k: Tone };
  if (c30 == null) pat = { t: "New listing", k: "neutral" };
  else if (c30 < -0.2 && c7v < -0.05) pat = { t: "Falling knife", k: "bad" };
  else if (c30 > 0.15 && c7v > 0) pat = { t: "Momentum runner", k: "good" };
  else if (c1y != null && c1y > 0.5 && c30 > -0.1) pat = { t: "Long-term leader", k: "good" };
  else if (c1y != null && c1y < -0.5 && c30 > 0.1) pat = { t: "Recovering", k: "warn" };
  else if (Math.abs(c30) < 0.05) pat = { t: "Quiet / ranging", k: "neutral" };
  else if (c30 < -0.1) pat = { t: "Downtrend", k: "bad" };
  else pat = { t: "Mixed", k: "neutral" };

  const thin = liq != null && liq < 0.01;
  const quick = 0.4 * clamp((c30v + 0.3) / 0.6) * 100 + 0.3 * (c1y == null ? 50 : clamp((c1y + 0.5) / 1.5) * 100) + 0.3 * (100 - risk);
  return { tier: t, risk, rk, pat, thin, quick, c7, c30, c1y, ath, liq };
}

export type Screen = ReturnType<typeof screen>;
