/** The watchlist rail. */
import { screen } from "../analysis/screen";
import { cls, esc, eur, pc, pill } from "./format";
import type { Actions, AppState } from "./state";

export function renderList(s: AppState, act: Actions) {
  const el = document.getElementById("coins")!;
  el.innerHTML = s.watch.map(id => {
    const m = s.markets[id], a = s.analyses[id], err = s.coinErr[id];
    const name = m ? m.name : id, sym = m ? m.symbol.toUpperCase() : "";
    let label: string;
    if (a) label = pill(a.cls.k, a.cls.t);
    else if (err) label = pill("bad", "No data");
    else if (m) { const sc = screen(m); label = pill(sc.pat.k, sc.pat.t); }
    else label = pill("neutral", "Loading…");
    const c30 = m?.price_change_percentage_30d_in_currency;
    return `<button class="coin" type="button" data-id="${esc(id)}" aria-current="${id === s.selected}">
      <span class="nm">${esc(name)} <span class="muted" style="font-weight:400">${esc(sym)}</span></span>
      <span class="px num">${m ? eur(m.current_price) : "—"}</span>
      <span>${label}</span>
      <span class="chg num ${cls(c30)}">${c30 != null ? pc(c30 / 100) + " 30d" : ""}</span>
    </button>`;
  }).join("");
  el.querySelectorAll<HTMLButtonElement>(".coin").forEach(b => (b.onclick = () => act.selectCoin(b.dataset.id!)));
}
