import { backtest, type Strategy } from "../../analysis/backtest";
import type { History } from "../../data/types";
import { equityChart } from "../charts";
import { cls, pc, pcu } from "../format";

/** Remembered between redraws so switching tabs keeps your settings. */
const settings = { s: "sma" as Strategy, p1: 50, p2: 50, fee: 0.25 };
/** Starting values for each strategy's first setting (the second only applies to the crossover). */
const DEFAULT_P1: Record<Strategy, number> = { hold: 50, sma: 50, cross: 20, rsi: 30, macd: 50, dca: 50 };

export function btUI(): string {
  const opt = (v: Strategy, t: string) => `<option value="${v}" ${settings.s === v ? "selected" : ""}>${t}</option>`;
  return `<div class="controls">
    <label for="bt-s">Strategy<select id="bt-s">
      ${opt("sma", "Hold while above moving average")}${opt("cross", "Fast / slow average crossover")}
      ${opt("macd", "Hold while MACD above signal")}${opt("rsi", "RSI: buy oversold, sell overbought")}${opt("dca", "Weekly DCA (spread buys evenly)")}</select></label>
    <label for="bt-p1" id="l-p1"><span>Average length</span><input id="bt-p1" type="number" min="5" max="100" value="${settings.p1}" style="width:90px"></label>
    <label for="bt-p2" id="l-p2"><span>Slow length</span><input id="bt-p2" type="number" min="10" max="150" value="${settings.p2}" style="width:90px"></label>
    <label for="bt-fee">Fee per trade %<input id="bt-fee" type="number" min="0" max="2" step="0.05" value="${settings.fee}" style="width:90px"></label>
  </div><div id="bt-out"></div>`;
}

const clampInt = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d);

export function wireBT(h: History) {
  const s = document.getElementById("bt-s") as HTMLSelectElement, p1 = document.getElementById("bt-p1") as HTMLInputElement;
  const p2 = document.getElementById("bt-p2") as HTMLInputElement, fee = document.getElementById("bt-fee") as HTMLInputElement;
  const l1 = document.getElementById("l-p1")!, l2 = document.getElementById("l-p2")!;
  const run = () => {
    const st = s.value as Strategy;
    l2.hidden = st !== "cross";
    l1.hidden = st === "dca" || st === "macd";
    l1.querySelector("span")!.textContent = st === "rsi" ? "Buy below RSI" : st === "cross" ? "Fast length" : "Average length";
    if (st === "rsi") { p1.min = "5"; p1.max = "45"; } else { p1.min = "5"; p1.max = "100"; }
    let v1 = clampInt(+p1.value, st === "rsi" ? 5 : 5, st === "rsi" ? 45 : 100, DEFAULT_P1[st]);
    let v2 = clampInt(+p2.value, 10, 150, 50);
    if (st === "cross" && v1 >= v2) { v1 = 20; v2 = 50; }
    p1.value = String(v1); p2.value = String(v2);
    const feePct = Math.min(2, Math.max(0, Number.isFinite(+fee.value) ? +fee.value : 0.25));
    Object.assign(settings, { s: st, p1: v1, p2: v2, fee: feePct });

    const c = h.closes, start = Math.min(100, Math.floor(c.length * 0.4)), f = feePct / 100;
    const opt = { fee: f, start, len: v1, fast: v1, slow: v2, lo: v1, hi: 100 - v1 };
    const strat = backtest(c, st, opt), hold = backtest(c, "hold", opt);
    const beat = strat.ret > hold.ret, dates = h.dates.slice(start);
    const smallerDrop = strat.mdd > hold.mdd;
    document.getElementById("bt-out")!.innerHTML = `
      <div class="verdict v-${beat ? "good" : "bad"}"><div class="label">Result on €1,000, ${dates[0]} to ${dates[dates.length - 1]}</div>
      <h3>${beat ? "Beat" : "Lost to"} simply holding, by ${Math.abs((strat.ret - hold.ret) * 100).toFixed(1)} percentage points</h3>
      <p>${smallerDrop ? (beat ? "It also had a smaller worst drop, which matters for staying in the game." : "It did have a smaller worst drop, which matters for staying in the game.") : "Its worst drop was no smaller than holding."}</p></div>
      <div class="tablewrap"><table><tr><th></th><th class="r">End value</th><th class="r">Return</th><th class="r">Worst drop</th><th class="r">Trades</th><th class="r">Time invested</th></tr>
      <tr><td><b>This strategy</b></td><td class="r num">€${strat.final.toFixed(0)}</td><td class="r num ${cls(strat.ret)}">${pc(strat.ret)}</td><td class="r num">${pc(strat.mdd)}</td><td class="r num">${strat.trades}</td><td class="r num">${pcu(strat.exposure)}</td></tr>
      <tr><td>Buy and hold</td><td class="r num">€${hold.final.toFixed(0)}</td><td class="r num ${cls(hold.ret)}">${pc(hold.ret)}</td><td class="r num">${pc(hold.mdd)}</td><td class="r num">${hold.trades}</td><td class="r num">100%</td></tr></table></div>
      <div class="chart" style="margin-top:10px">${equityChart([{ eq: hold.eq, color: "var(--muted)", w: 1.4 }, { eq: strat.eq, color: "var(--accent)", w: 2 }], dates)}</div>
      <div class="legend"><span><i style="background:var(--accent)"></i>This strategy</span><span><i style="background:var(--muted)"></i>Buy and hold</span></div>
      <p class="note">Signals use yesterday's close and trade at today's close, so the test can't peek ahead. The data covers about ${dates.length} days after the warm-up, which is one market phase. Tweaking settings until one wins mostly finds luck.</p>`;
  };
  s.onchange = () => { const st = s.value as Strategy; p1.value = String(DEFAULT_P1[st]); if (st === "cross") p2.value = "50"; run(); };
  [p1, p2, fee].forEach(x => (x.onchange = run));
  run();
}
