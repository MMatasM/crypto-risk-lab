/** The Paper trading view: leaderboards, equity curves and the trade log from the nightly paper trader. */
import { portfolioBoard, type BookKey, type PortfolioState, type PortfolioTrade } from "../paper/portfolio";
import { board, curves, daysOfData, strategyName, type Curve } from "../paper/summary";
import type { PaperStrategy, TradeRecord } from "../paper/types";
import { equityChart } from "./charts";
import { cls, esc, eur, pc, stamp } from "./format";
import type { Actions, AppState } from "./state";

const COLORS: Record<PaperStrategy, string> = { hold: "var(--muted)", dca: "var(--c3)", sma: "var(--c1)", cross: "var(--c2)", macd: "var(--warn)", rsi: "var(--accent)", model: "var(--good)" };
const KNOWN: Record<string, string> = { bitcoin: "Bitcoin", ethereum: "Ethereum", ripple: "XRP", solana: "Solana", monero: "Monero" };
const LOG_PAGE = 100;
const BOOK_COLORS: Record<BookKey, string> = { topk: "var(--accent)", btc: "var(--muted)", equal: "var(--c1)" };

const money0 = (v: number) => "€" + Math.round(v).toLocaleString("en-IE");
const day = (d: string | null) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
const pts = (v: number | null) => {
  if (v == null) return `<span class="muted">baseline</span>`;
  const x = Number((v * 100).toFixed(1)); // so a tiny negative reads 0.0, not -0.0
  return `<span class="${x ? cls(x) : ""}">${x > 0 ? "+" : ""}${x.toFixed(1)} pts</span>`;
};

export function renderPaper(st: AppState, act: Actions) {
  const el = document.getElementById("paper")!;
  const pv = st.paper, d = pv.data;
  const name = (id: string) => st.markets[id]?.name || KNOWN[id] || id.replace(/(^|-)([a-z])/g, (_, a, b) => (a ? " " : "") + b.toUpperCase());
  const head = `<div class="disc-head"><div><h2>Paper trading${pv.stale && pv.at ? ` <span class="offline">Offline copy from ${stamp(pv.at)}</span>` : ""}</h2>
    <div class="note">Fake money, real prices. Every night (about 00:30 UTC) a job on GitHub takes each coin's daily close and trades €1,000 per strategy and coin with the same rules as the Backtest tab. No exchange, no real money.</div></div></div>`;
  const err = pv.err ? `<div class="err">${esc(pv.err)}</div>` : "";
  if (!d) { el.innerHTML = head + err + `<div class="empty">${pv.loading ? "Loading paper trading results…" : "No paper trading results yet."}</div>`; return; }
  const { config, state, trades } = d;
  if (!state.startDate) {
    el.innerHTML = head + err + `<div class="empty">Paper trading hasn't started yet. The first nightly run starts it: each coin's first trade is at the close of the day before that run.</div>`;
    return;
  }
  const coins = [...config.coins.filter(c => state.coins[c]), ...Object.keys(state.coins).filter(c => !config.coins.includes(c))];
  const coin = pv.coin && state.coins[pv.coin] ? pv.coin : null;
  const strategies = [...new Set([...config.strategies, ...Object.values(state.coins).flatMap(cs => Object.keys(cs.pairs) as PaperStrategy[])])];
  const cs = curves(state, coin, strategies), rows = board(cs), n = daysOfData(state);
  const capital = coin ? 1000 : cs[0]?.capital ?? 1000;

  const warn = `<div class="verdict v-${n < 90 ? "warn" : "neutral"}"><div class="label">Started on ${day(state.startDate)} · ${n} day${n === 1 ? "" : "s"} of data · last close traded ${day(state.lastDate)}</div>
    <h3>${n < 90 ? "Far too early to trust a winner" : "Still one stretch of one market"}</h3>
    <p>${n < 90 ? "Over a few weeks, luck decides the order: one big day can put any rule on top. Use this to check that the rules behave as expected, and judge them only after many months." : "Even months of results cover one market phase. A rule that won here can lose the next phase; look at the worst drop as much as the return."} Nothing here is advice.</p></div>`;

  const chips = `<div class="chipbar" id="p-coin"><button type="button" data-coin="" aria-pressed="${coin === null}">All coins</button>${coins.map(c => `<button type="button" data-coin="${esc(c)}" aria-pressed="${coin === c}">${esc(name(c))}</button>`).join("")}</div>`;

  const table = `<div class="tablewrap"><table><tr><th>#</th><th>Strategy</th><th class="r">Value</th><th class="r">Return</th><th class="r">Worst drop</th><th class="r">Trades</th><th class="r" title="Against buying and holding over the same days">vs buy and hold</th></tr>
    ${rows.map((r, k) => `<tr class="pick${pv.focus === r.strategy ? " on" : ""}" data-st="${r.strategy}" tabindex="0" title="Highlight on the chart">
      <td class="num muted">${k + 1}</td><td style="white-space:nowrap"><span class="swatch" style="background:${COLORS[r.strategy]}"></span>${r.strategy === "hold" ? `<b>${esc(r.name)}</b>` : esc(r.name)}${r.since > state.startDate! ? ` <span class="muted">· since ${day(r.since)}</span>` : ""}</td>
      <td class="r num">${money0(r.value)}</td><td class="r num ${cls(r.ret)}">${pc(r.ret, 2)}</td><td class="r num">${pc(r.mdd, 1)}</td><td class="r num">${r.trades}</td><td class="r num">${pts(r.vsHold)}</td></tr>`).join("")}</table></div>`;

  const chart = chartBlock(cs, pv.focus, capital);

  const pairsNote = coin ? `€1,000 on ${esc(name(coin))} per strategy.` : `€1,000 per coin per strategy, ${coins.length} coin${coins.length === 1 ? "" : "s"} added together (${money0(capital)} each), over the days every coin was traded.`;

  // Trade log
  let log: TradeRecord[] = trades.filter(t => (!coin || t.coin === coin) && (pv.logStrategy === "all" || t.strategy === pv.logStrategy)).slice().reverse();
  const total = log.length;
  if (!pv.logAll) log = log.slice(0, LOG_PAGE);
  const settingsOf = (s: PaperStrategy, c: string) => state.coins[c]?.pairs[s]?.settings ?? config.settings;
  const logHtml = `<div class="section"><div class="disc-head" style="margin-bottom:6px"><h3>Trade log${coin ? ": " + esc(name(coin)) : ""}</h3>
    <div class="controls" style="margin:0"><label for="p-log">Strategy<select id="p-log"><option value="all">All strategies</option>${strategies.map(s => `<option value="${s}" ${pv.logStrategy === s ? "selected" : ""}>${esc(strategyName(s, config.settings))}</option>`).join("")}</select></label></div></div>
    ${total ? `<div class="tablewrap"><table class="log"><tr><th>Date</th><th>Coin</th><th>Strategy</th><th>Side</th><th class="r">Price</th><th class="r">Amount</th><th class="r">Fee</th><th class="r">Slippage</th><th>Reason</th></tr>
    ${log.map(t => `<tr><td class="num" style="white-space:nowrap">${t.date}</td><td>${esc(name(t.coin))}</td><td style="white-space:nowrap">${esc(strategyName(t.strategy, settingsOf(t.strategy, t.coin)))}</td>
      <td><span class="side ${t.side}">${t.side === "buy" ? "Buy" : "Sell"}</span></td><td class="r num" title="Close ${eur(t.close)}">${eur(t.price)}</td><td class="r num">${eur(t.amount)}</td><td class="r num">${eur(t.fee)}</td><td class="r num">${eur(t.slippage)}</td><td class="reason">${esc(t.reason)}</td></tr>`).join("")}</table></div>
    ${total > log.length ? `<button class="btn sm" type="button" id="p-more" style="margin-top:8px">Show all ${total} trades</button>` : ""}` : `<p class="note">No trades${pv.logStrategy !== "all" ? " for this strategy" : ""} yet.</p>`}</div>`;

  const k = config.settings;
  const foot = `<p class="note" style="margin-top:14px">Each day's decision uses data up to the day before and trades at that day's close, exactly as in the Backtest tab. Costs per trade: ${(config.fee * 100).toFixed(2)}% fee plus ${(config.slippage * 100).toFixed(2)}% slippage (buys fill above the close, sells below). Settings: ${k.smaLength}-day average, ${k.fast}/${k.slow} crossover, MACD 12/26/9, RSI 14 buying below ${k.rsiBuyBelow} and selling above ${k.rsiSellAbove}, the model strategy holding while the forecast's 7-day chance of a rise is above ${((k.modelThreshold ?? 0.55) * 100).toFixed(0)}% (a strategy that started later is compared with buying and holding from its own first day), DCA buying 1/${k.dcaWeeks} of the €1,000 every 7 days (the rest waits as cash). Each pair keeps the settings it started with. Prices: CoinGecko daily closes in EUR.${pv.at && !pv.stale ? ` Loaded ${stamp(pv.at)}.` : ""}</p>`;

  el.innerHTML = head + err + warn + chips + `<div class="section" style="margin-top:6px"><h3>Leaderboard: ${coin ? esc(name(coin)) : "all coins"}</h3><p class="note" style="margin:0 0 6px">${pairsNote} Click a row to highlight it on the chart.</p>${table}</div>${chart}` + (coin ? "" : portfolioBlock(d.portfolio ?? null, d.portfolioTrades ?? [], config.portfolio, name)) + logHtml + foot;

  el.querySelectorAll<HTMLButtonElement>("[data-coin]").forEach(b => (b.onclick = () => act.setPaper({ coin: b.dataset.coin || null, logAll: false })));
  el.querySelectorAll<HTMLTableRowElement>("tr[data-st]").forEach(tr => {
    const pick = () => act.setPaper({ focus: pv.focus === tr.dataset.st ? null : (tr.dataset.st as PaperStrategy) });
    tr.onclick = pick;
    tr.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
  });
  el.querySelector<HTMLSelectElement>("#p-log")!.onchange = e => act.setPaper({ logStrategy: (e.target as HTMLSelectElement).value as PaperStrategy | "all", logAll: false });
  el.querySelector<HTMLButtonElement>("#p-more")?.addEventListener("click", () => act.setPaper({ logAll: true }));
}

function chartBlock(cs: Curve[], focus: PaperStrategy | null, capital: number): string {
  const withData = cs.filter(c => c.eq.length);
  const dates = [...new Set(withData.flatMap(c => c.dates))].sort();
  if (dates.length < 2) return `<div class="section"><h3>Value over time</h3><p class="note">The chart appears after the second day of trading.</p></div>`;
  const ordered = [...withData.filter(c => c.strategy !== focus), ...withData.filter(c => c.strategy === focus)];
  const series = ordered.map(c => ({
    eq: c.eq, from: dates.indexOf(c.dates[0]), color: COLORS[c.strategy],
    w: c.strategy === focus ? 2.6 : c.strategy === "hold" ? 2 : 1.5,
    dash: c.strategy === "hold" ? "6 3" : undefined,
    op: focus && c.strategy !== focus && c.strategy !== "hold" ? 0.25 : undefined,
  }));
  return `<div class="section"><h3>Value over time vs buy and hold</h3><div class="chart">${equityChart(series, dates, capital)}</div>
    <div class="legend">${withData.map(c => `<span><i style="background:${COLORS[c.strategy]}"></i>${esc(c.name)}${c.strategy === "hold" ? " (dashed)" : ""}</span>`).join("")}</div></div>`;
}

/** The weekly top-k portfolio against its two benchmarks. */
function portfolioBlock(pf: PortfolioState | null, trades: PortfolioTrade[], cfg: { k: number; universe: number; maxWeight: number; rebalanceDays: number; trendDays: number } | undefined, name: (id: string) => string): string {
  if (!cfg) return "";
  const rule = `Every ${cfg.rebalanceDays} days it holds the ${cfg.k} best of the ${cfg.universe} biggest scanned coins, ranked by composite score and the model's 7-day chance of a rise together, in equal parts (never more than ${(cfg.maxWeight * 100).toFixed(0)}% in one coin), and sits in cash while Bitcoin is below its ${cfg.trendDays}-day average.`;
  if (!pf?.startDate) return `<div class="section"><h3>Model portfolio: top-${cfg.k} rotation</h3><p class="note">${rule} It starts with €1,000 on the first night that has a ranking from the day before, next to two things to beat with the same money: buying and holding Bitcoin, and an equal amount of each of the ${cfg.universe} biggest coins, bought once and held.</p></div>`;
  const k = pf.settings, rows = portfolioBoard(pf), book = pf.books.topk;
  const total = book.equity[book.equity.length - 1];
  const held = Object.entries(book.units).map(([c, u]) => ({ c, v: u * (pf.marks[c] ?? 0) })).sort((a, b) => b.v - a.v);
  const table = `<div class="tablewrap"><table><tr><th>Portfolio</th><th class="r">Value</th><th class="r">Return</th><th class="r">Worst drop</th><th class="r">Trades</th><th class="r">vs Bitcoin</th><th class="r">vs equal weight</th></tr>
    ${rows.map(r => `<tr><td style="white-space:nowrap"><span class="swatch" style="background:${BOOK_COLORS[r.book]}"></span>${r.book === "topk" ? `<b>${esc(r.name)}</b>` : esc(r.name)}</td><td class="r num">${eur(r.value)}</td><td class="r num ${cls(r.ret)}">${pc(r.ret, 2)}</td><td class="r num">${pc(r.mdd, 1)}</td><td class="r num">${r.trades}</td><td class="r num">${pts(r.vsBtc)}</td><td class="r num">${pts(r.vsEqual)}</td></tr>`).join("")}</table></div>`;
  const chart = pf.dates.length < 2 ? `<p class="note">The chart appears after the second day.</p>`
    : `<div class="chart">${equityChart((["btc", "equal", "topk"] as const).map(b => ({ eq: pf.books[b].equity, color: BOOK_COLORS[b], w: b === "topk" ? 2.4 : 1.6, dash: b === "btc" ? "6 3" : undefined })), pf.dates, 1000)}</div>`;
  const holding = held.length ? `Holding now: ${held.map(h => `${esc(name(h.c))} ${eur(h.v)} (${(h.v / total * 100).toFixed(0)}%)`).join(", ")}, cash ${eur(book.cash)}.` : `All ${eur(book.cash)} in cash.`;
  const mine = trades.filter(t => t.book === "topk").slice().reverse().slice(0, 30);
  return `<div class="section"><h3>Model portfolio: top-${k.k} rotation</h3>
    <p class="note" style="margin:0 0 6px">One pot of €1,000 since ${day(pf.startDate)}, with the same fee and slippage. Every ${k.rebalanceDays} days it holds the ${k.k} best of the ${k.universe} biggest scanned coins, ranked by composite score and the model's 7-day chance of a rise together, in equal parts (never more than ${(k.maxWeight * 100).toFixed(0)}% in one coin), and sits in cash while Bitcoin is below its ${k.trendDays}-day average. The two to beat started on the same day with the same money.</p>
    ${table}${chart}
    <p class="note" style="margin-top:8px">${pf.decision ? `Last weekly decision, ${day(pf.decision.date)} (from the ranking of ${day(pf.decision.rankedOn)}): ${esc(pf.decision.note)} ` : ""}${holding}</p>
    ${mine.length ? `<div class="tablewrap"><table class="log"><tr><th>Date</th><th>Coin</th><th>Side</th><th class="r">Price</th><th class="r">Amount</th><th class="r">Fee</th><th>Reason</th></tr>
      ${mine.map(t => `<tr><td class="num" style="white-space:nowrap">${t.date}</td><td>${esc(name(t.coin))}</td><td><span class="side ${t.side}">${t.side === "buy" ? "Buy" : "Sell"}</span></td><td class="r num" title="Close ${eur(t.close)}">${eur(t.price)}</td><td class="r num">${eur(t.amount)}</td><td class="r num">${eur(t.fee)}</td><td class="reason">${esc(t.reason)}</td></tr>`).join("")}</table></div>` : `<p class="note">The rotation hasn't traded yet.</p>`}</div>`;
}
