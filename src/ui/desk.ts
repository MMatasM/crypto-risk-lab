/** The analysis desk: coin header, tab bar and the selected tab. */
import { technicals } from "../analysis/technicals";
import { cls, esc, eur, pc, pill } from "./format";
import type { Actions, AppState, Tab } from "./state";
import { overview } from "./tabs/overview";
import { techTab } from "./tabs/technicalsTab";
import { ranges } from "./tabs/rangesTab";
import { historyTab } from "./tabs/historyTab";
import { signals } from "./tabs/rulesTab";
import { btUI, wireBT } from "./tabs/backtestTab";

const TABS: [Tab, string][] = [["overview", "Overview"], ["technicals", "Technicals"], ["ranges", "30-day ranges"], ["history", "History"], ["signals", "Rules"], ["backtest", "Backtest"]];

export function renderDesk(s: AppState, act: Actions) {
  const el = document.getElementById("desk")!;
  const id = s.selected, m = s.markets[id], a = s.analyses[id], h = s.hists[id], coinErr = s.coinErr[id];
  const err = s.lastErr ? `<div class="err">${esc(s.lastErr)}</div>` : "";
  if (!a || !h) {
    let msg: string;
    if (coinErr) msg = `${esc(coinErr)}<br><br><button class="btn sm" type="button" id="retry">Try again</button>${id !== "bitcoin" ? ` <button class="btn sm" type="button" id="rm">Remove from watchlist</button>` : ""}`;
    else if (h) msg = `Not enough price history for ${esc(m?.name || id)} yet. The analysis needs about two months of daily prices; CoinGecko has ${h.closes.length} day${h.closes.length === 1 ? "" : "s"}.${id !== "bitcoin" ? `<br><br><button class="btn sm" type="button" id="rm">Remove from watchlist</button>` : ""}`;
    else msg = "Loading " + esc(m?.name || id) + "… Without an API key this can take up to a minute.";
    el.innerHTML = err + `<div class="empty">${msg}</div>`;
    el.querySelector<HTMLButtonElement>("#retry")?.addEventListener("click", () => act.retryCoin(id));
    el.querySelector<HTMLButtonElement>("#rm")?.addEventListener("click", () => act.removeSelected());
    return;
  }
  const tab = s.tab;
  // CoinGecko's own rolling changes, so the header agrees with the watchlist and Discover;
  // the daily-close figures are the fallback for coins without them.
  const live = (v: number | null | undefined, fallback: number | null) => (v != null ? v / 100 : fallback);
  const r7 = live(m?.price_change_percentage_7d_in_currency, a.ret7);
  const r30 = live(m?.price_change_percentage_30d_in_currency, a.ret30);
  const r1y = live(m?.price_change_percentage_1y_in_currency, a.retAll);
  el.innerHTML = `${err}
  <div class="desk-head">
    <div><div class="label">${esc(m?.symbol?.toUpperCase() || "")} · rank #${m?.market_cap_rank ?? "—"}</div><h2 style="font-size:1.5rem">${esc(m?.name || id)}</h2>
      <div class="chips">${pill("tier", a.tier.t, false)}${pill(a.volc.k, a.volc.t, false)}${a.tags.map(t => pill("warn", t, false)).join("")}</div>
      ${id !== "bitcoin" ? `<button class="rm" id="rm" type="button" style="margin-top:8px">Remove from watchlist</button>` : ""}</div>
    <div style="text-align:right"><div class="big">${eur(a.p)}</div><div class="num" style="font-size:.85rem"><span class="${cls(r7)}">${pc(r7)} 7d</span> · <span class="${cls(r30)}">${pc(r30)} 30d</span> · <span class="${cls(r1y)}">${pc(r1y, 0)} 1y</span></div></div>
  </div>
  <div class="tabs" role="tablist">${TABS.map(([k, t]) => `<button class="tab" role="tab" type="button" data-tab="${k}" aria-selected="${k === tab}">${t}</button>`).join("")}</div>
  <div id="tabbody" role="tabpanel"></div>`;
  el.querySelectorAll<HTMLButtonElement>(".tab").forEach(b => (b.onclick = () => act.setTab(b.dataset.tab as Tab)));
  el.querySelector<HTMLButtonElement>("#rm")?.addEventListener("click", () => act.removeSelected());
  const body = el.querySelector<HTMLElement>("#tabbody")!;
  if ((tab === "technicals" || tab === "history") && !s.techs[id]) s.techs[id] = technicals(h, a);
  const t = s.techs[id];
  if (tab === "overview") body.innerHTML = overview(a, h);
  else if (tab === "technicals" && t) {
    body.innerHTML = techTab(a, h, t, s.taShow);
    body.querySelectorAll<HTMLButtonElement>("[data-ov]").forEach(b => (b.onclick = () => act.toggleOverlay(b.dataset.ov as keyof AppState["taShow"])));
  } else if (tab === "ranges") body.innerHTML = ranges(a);
  else if (tab === "history" && t) body.innerHTML = historyTab(a, m, t);
  else if (tab === "signals") body.innerHTML = signals(a);
  else if (tab === "backtest") { body.innerHTML = btUI(); wireBT(h); }
}
