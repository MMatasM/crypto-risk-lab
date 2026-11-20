import { describe, expect, it } from "vitest";
import { buildAlert, type AlertInput } from "../../src/alerts/summary";
import type { PortfolioTrade } from "../../src/paper/portfolio";
import type { TradeRecord } from "../../src/paper/types";
import type { Change, ScanCoin, ScanFile } from "../../src/scan/types";

const coin = (id: string, name: string) => ({ id, name }) as ScanCoin;
const change = (id: string, name: string, kind: Change["kind"], text: string): Change => ({ id, name, kind, text, k: "neutral", watch: true });
const scan = (changes: Change[]): ScanFile => ({ date: "2026-11-20", previousDate: "2026-11-19", generatedAt: "", coins: [coin("bitcoin", "Bitcoin"), coin("ripple", "XRP"), coin("dogecoin", "Dogecoin")], skipped: [], changes });
const trade = (coin: string, side: "buy" | "sell"): TradeRecord => ({ date: "2026-11-20", coin, strategy: "macd", side, close: 56000, price: 56056, units: 0.01, amount: 1000, fee: 2.5, slippage: 1, reason: "" });
const pfTrade = (book: PortfolioTrade["book"], coin: string, side: "buy" | "sell"): PortfolioTrade => ({ date: "2026-11-20", book, coin, side, close: 1, price: 1, units: 1, amount: 1, fee: 0, slippage: 0, reason: "" });
const base: AlertInput = { scan: scan([]), tracked: ["bitcoin", "ripple"], chance: null, chanceBefore: null, threshold: 0.55, trades: [], portfolioTrades: [], strategyName: s => "Strategy " + s };

describe("the nightly summary message", () => {
  it("says nothing when nothing happened", () => {
    expect(buildAlert(base)).toEqual({ text: null, events: 0 });
    // Changes to coins that aren't tracked, and minor changes to tracked ones, are not worth a message.
    const quiet = scan([change("dogecoin", "Dogecoin", "cls", "Classification: A → B"), change("bitcoin", "Bitcoin", "rank", "Rank 3 → 20"), change("bitcoin", "Bitcoin", "cons", "Technicals: mixed → leaning bearish")]);
    expect(buildAlert({ ...base, scan: quiet }).text).toBeNull();
    // A forecast that stays on the same side of the threshold is not a flip.
    expect(buildAlert({ ...base, chance: { bitcoin: 0.6 }, chanceBefore: { bitcoin: 0.58 } }).text).toBeNull();
  });

  it("puts everything into one message", () => {
    const a = buildAlert({
      ...base,
      scan: scan([change("bitcoin", "Bitcoin", "cls", "Classification: Avoid for now → Mixed, no clear trend"), change("ripple", "XRP", "move", "Fell 9.1% in a day, 2.4 times its usual daily move"), change("dogecoin", "Dogecoin", "move", "Rose 20% in a day")]),
      chance: { bitcoin: 0.58, ripple: 0.4, dogecoin: 0.9 }, chanceBefore: { bitcoin: 0.52, ripple: 0.6, dogecoin: 0.1 },
      trades: [trade("bitcoin", "sell")], portfolioTrades: [pfTrade("topk", "ripple", "buy"), pfTrade("topk", "bitcoin", "sell"), pfTrade("equal", "dogecoin", "buy")],
      link: "https://example.github.io/app/#signals",
    });
    expect(a.events).toBe(6);
    expect(a.text).toBe([
      "Crypto Risk Lab · closes of 20 Nov 2026", "",
      "Tracked coins",
      "• Bitcoin: Classification: Avoid for now → Mixed, no clear trend",
      "• XRP: Fell 9.1% in a day, 2.4 times its usual daily move",
      "• Bitcoin: the model's 7-day chance of a rise rose above 55% (52% → 58%)",
      "• XRP: the model's 7-day chance of a rise fell to or below 55% (60% → 40%)", "",
      "Paper trades (fake money)",
      "• Bitcoin, Strategy macd: sold at €56,056",
      "• Top-k portfolio: sold Bitcoin; bought XRP", "",
      "https://example.github.io/app/#signals",
    ].join("\n"));
  });

  it("still reports paper trades when the scan failed, and stays within Telegram's size limit", () => {
    const a = buildAlert({ ...base, scan: null, trades: Array.from({ length: 200 }, () => trade("some-new-coin", "buy")) });
    expect(a.text).toMatch(/^Crypto Risk Lab · closes of 20 Nov 2026/);
    expect(a.text).toMatch(/Some New Coin, Strategy macd: bought at/);
    expect(a.text!.length).toBeLessThan(4096);
    expect(a.text).toMatch(/more in the app/);
  });
});
