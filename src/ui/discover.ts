/** The Discover screener: the top 250 coins by market cap, sorted into size tiers and patterns. */
import { isNoise, screen, usdRate, type Screen } from "../analysis/screen";
import type { MarketCoin } from "../data/types";
import { SECTORS as SCAN_SECTORS } from "../scan/types";
import { cls, esc, eur, pc, pill, stamp } from "./format";
import type { Actions, AppState, DiscSort } from "./state";

export const SECTORS: [string, string][] = [["", "All coins"], ...SCAN_SECTORS];
const TIERS: [string, string][] = [["all", "All sizes"], ["mega", "Mega (€50B+)"], ["large", "Large (€10–50B)"], ["mid", "Mid (€1–10B)"], ["small", "Small (€100M–1B)"], ["micro", "Micro (<€100M)"]];
const SORTS: [DiscSort, string][] = [["mcap", "Market cap"], ["quick", "Screen score"], ["c30", "30-day change"], ["c1y", "1-year change"], ["risk", "Lowest risk"], ["liq", "Trading activity"]];

interface Row { m: MarketCoin; s: Screen }

const coinLogo = (m: MarketCoin) => (m.image ? `<img src="${esc(m.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" width="20" height="20">` : "");

function ideaCard(r: Row, tierName: string): string {
  const { m, s } = r;
  return `<div class="idea"><div class="label">${tierName}</div>
  <div class="t"><span class="coinname">${coinLogo(m)}<b>${esc(m.name)}</b></span><span class="num ${cls(s.c30)}">${pc(s.c30)} 30d</span></div>
  <div class="chips" style="margin:0">${pill(s.pat.k, s.pat.t)}${pill(s.rk.k, s.rk.t + " risk")}</div>
  <button class="btn sm" type="button" data-an="${esc(m.id)}" style="align-self:flex-start">Analyze</button></div>`;
}

const nullsLast = (v: number | null) => (v == null ? -Infinity : v);

export function renderDiscover(st: AppState, act: Actions) {
  const el = document.getElementById("disc")!;
  const d = st.disc;
  const usd = usdRate(d.data ?? []);
  let rows: Row[] = (d.data || []).filter(m => (m.market_cap ?? 0) > 0 && m.current_price != null).map(m => ({ m, s: screen(m) }));
  if (d.hide) rows = rows.filter(r => !isNoise(r.m, usd));
  const all = rows;
  if (d.tier !== "all") rows = rows.filter(r => r.s.tier.k === d.tier);
  const sorters: Record<DiscSort, (a: Row, b: Row) => number> = {
    mcap: (a, b) => (b.m.market_cap ?? 0) - (a.m.market_cap ?? 0),
    c30: (a, b) => nullsLast(b.s.c30) - nullsLast(a.s.c30),
    c1y: (a, b) => nullsLast(b.s.c1y) - nullsLast(a.s.c1y),
    risk: (a, b) => a.s.risk - b.s.risk,
    quick: (a, b) => b.s.quick - a.s.quick,
    liq: (a, b) => nullsLast(b.s.liq) - nullsLast(a.s.liq),
  };
  rows.sort(sorters[d.sort]);
  const ideaTiers = (["mega", "large", "mid", "small"] as const).map(k => {
    const cand = all.filter(r => r.s.tier.k === k && r.s.c30 != null && !["Falling knife", "Downtrend"].includes(r.s.pat.t) && !r.s.thin)
      .sort((a, b) => b.s.quick - a.s.quick).slice(0, 2);
    return { k, t: TIERS.find(x => x[0] === k)![1], cand };
  }).filter(x => x.cand.length);
  const sectorName = SECTORS.find(x => x[0] === d.sector)?.[1] ?? d.sector;
  const staleNote = d.stale && d.at ? ` <span class="offline">Offline copy from ${stamp(d.at)}</span>` : "";

  el.innerHTML = `<div class="disc-head"><div><h2>Discover${staleNote}</h2><div class="note">Top coins by market cap${d.sector ? " in " + esc(sectorName) : ""}, sorted into size tiers and patterns. Click a coin to run the full analysis.</div></div>
    <div class="controls" style="margin:0"><label for="d-sort">Sort by<select id="d-sort">
      ${SORTS.map(([k, t]) => `<option value="${k}" ${d.sort === k ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label for="d-hide" style="flex-direction:row;align-items:center;gap:6px;padding-bottom:8px"><input id="d-hide" type="checkbox" ${d.hide ? "checked" : ""}>Hide stablecoins, wrapped tokens and tokenized funds</label></div></div>
  <div class="label" style="margin-bottom:6px">Sector</div>
  <div class="chipbar" id="d-sec">${SECTORS.map(([k, t]) => `<button type="button" data-sec="${k}" aria-pressed="${d.sector === k}">${t}</button>`).join("")}</div>
  <div class="label" style="margin-bottom:6px">Size tier</div>
  <div class="chipbar" id="d-tier">${TIERS.map(([k, t]) => `<button type="button" data-tier="${k}" aria-pressed="${d.tier === k}">${t}</button>`).join("")}</div>
  ${d.err ? `<div class="err">${esc(d.err)}</div>` : ""}
  ${d.loading && !d.data ? `<div class="empty">Loading coins…</div>` : ""}
  ${ideaTiers.length && d.tier === "all" ? `<div class="section"><h3>Starting points by size</h3><p class="note" style="margin:0 0 6px">Strongest recent trend with acceptable risk in each tier, from market data alone. A shortlist to analyze, not a buy list.</p>
    <div class="ideas">${ideaTiers.map(g => g.cand.map(r => ideaCard(r, g.t)).join("")).join("")}</div></div>` : ""}
  ${d.data ? `<div class="tablewrap"><table><tr><th>#</th><th>Coin</th><th class="r">Price</th><th class="r">7d</th><th class="r">30d</th><th class="r">1y</th><th class="r">From ATH</th><th>Tier</th><th>Risk</th><th>Pattern</th><th></th></tr>
  ${rows.map(({ m, s }) => {
    const inW = st.watch.includes(m.id);
    return `<tr>
    <td class="num muted">${m.market_cap_rank ?? "—"}</td>
    <td><button class="rm" type="button" style="text-decoration:none;color:var(--ink)" data-an="${esc(m.id)}"><span class="coinname">${coinLogo(m)}<b>${esc(m.name)}</b> <span class="muted">${esc(m.symbol.toUpperCase())}</span></span></button></td>
    <td class="r num">${eur(m.current_price)}</td><td class="r num ${cls(s.c7)}">${pc(s.c7)}</td><td class="r num ${cls(s.c30)}">${pc(s.c30)}</td><td class="r num ${cls(s.c1y)}">${pc(s.c1y, 0)}</td><td class="r num">${pc(s.ath, 0)}</td>
    <td class="muted" style="white-space:nowrap">${s.tier.t}</td><td>${pill(s.rk.k, s.rk.t)}</td><td>${pill(s.pat.k, s.pat.t)}${s.thin ? " " + pill("warn", "Thin", false) : ""}</td>
    <td><button class="btn sm" type="button" data-add="${esc(m.id)}" ${inW ? "disabled" : ""}>${inW ? "Watching" : "+ Watch"}</button></td></tr>`;
  }).join("")}
  ${!rows.length ? `<tr><td colspan="11" class="muted">No coins in this tier for this sector.</td></tr>` : ""}</table></div>` : ""}
  <p class="note" style="margin-top:12px">Risk here is a quick estimate from size, recent swings and distance from the all-time high. The full analysis uses a year of daily prices. Images: CoinGecko.</p>`;

  el.querySelectorAll<HTMLButtonElement>("[data-sec]").forEach(b => (b.onclick = () => act.setDiscover({ sector: b.dataset.sec! })));
  el.querySelectorAll<HTMLButtonElement>("[data-tier]").forEach(b => (b.onclick = () => act.setDiscover({ tier: b.dataset.tier! })));
  el.querySelector<HTMLSelectElement>("#d-sort")!.onchange = e => act.setDiscover({ sort: (e.target as HTMLSelectElement).value as DiscSort });
  el.querySelector<HTMLInputElement>("#d-hide")!.onchange = e => act.setDiscover({ hide: (e.target as HTMLInputElement).checked });
  el.querySelectorAll<HTMLButtonElement>("[data-add]").forEach(b => (b.onclick = () => act.addToWatch(b.dataset.add!)));
  el.querySelectorAll<HTMLButtonElement>("[data-an]").forEach(b => (b.onclick = () => act.analyzeFromDiscover(b.dataset.an!)));
}
