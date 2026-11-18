/**
 * The app controller: owns the state, loads data through the repository, recomputes the analysis
 * and redraws the screens. The screens only read state and call the actions defined here.
 */
import { analyze, MIN_DAYS } from "./analysis/scoring";
import { ApiError, CoinGeckoClient } from "./data/coingecko";
import { BACKGROUND, Repository, URGENT } from "./data/repository";
import { store } from "./data/storage";
import type { History, MarketCoin } from "./data/types";
import type { Overlays } from "./ui/charts";
import { renderDesk } from "./ui/desk";
import { renderDiscover } from "./ui/discover";
import { esc, stamp } from "./ui/format";
import type { Actions, AppState, DiscoverState } from "./ui/state";
import { renderList } from "./ui/watchlist";

const DEFAULT_WATCH = ["bitcoin", "ethereum", "ripple", "solana", "monero"];
const K = { key: "crl.key", watch: "crl.watch", sel: "crl.sel", ta: "crl.ta", disc: "crl.disc" };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The newest price from market data (refreshed every 5 minutes) replaces or extends the last daily
 * close (refreshed every 6 hours), so the desk and the watchlist show the same price.
 */
export function withLivePrice(h: History, m: MarketCoin | undefined): History {
  const px = m?.current_price, day = m?.last_updated?.slice(0, 10);
  const n = h.closes.length;
  if (!px || px <= 0 || !day || !n) return h;
  const lastDay = h.dates[n - 1];
  if (day === lastDay) return { dates: h.dates, closes: [...h.closes.slice(0, -1), px], volumes: h.volumes };
  if (day > lastDay) return { dates: [...h.dates, day], closes: [...h.closes, px], volumes: [...h.volumes, m?.total_volume ?? h.volumes[n - 1] ?? 0] };
  return h;
}

export function startApp() {
  let apiKey = store.get<string>(K.key, "");
  let watch = store.get<string[]>(K.watch, DEFAULT_WATCH).filter(x => typeof x === "string" && x);
  if (!watch.includes("bitcoin")) watch.unshift("bitcoin");
  watch = [...new Set(watch)];
  const discPrefs = store.get<Partial<DiscoverState>>(K.disc, {});

  const s: AppState = {
    watch,
    selected: store.get(K.sel, "bitcoin"),
    tab: "overview",
    view: "analyze",
    markets: {},
    hists: {},
    analyses: {},
    techs: {},
    coinErr: {},
    lastErr: null,
    staleSince: null,
    taShow: { ema: true, bb: false, lv: true, fib: false, ...store.get<Partial<Overlays>>(K.ta, {}) },
    disc: {
      sector: discPrefs.sector ?? "", tier: discPrefs.tier ?? "all", sort: discPrefs.sort ?? "mcap", hide: discPrefs.hide ?? true,
      data: null, at: null, stale: false, err: null, loading: false,
    },
  };
  if (!s.watch.includes(s.selected)) s.selected = "bitcoin";
  /** Raw daily history as loaded; s.hists holds it with the live price spliced in. */
  const raw: Record<string, History> = {};

  const setStatus = (t: string) => { $("status").textContent = t; };
  const client = new CoinGeckoClient({ getKey: () => apiKey, onStatus: setStatus });
  const repo = new Repository(client, store);

  const renderAll = () => { renderList(s, actions); renderDesk(s, actions); };
  const finalStatus = () => setStatus(s.staleSince ? `Offline: showing data saved ${stamp(s.staleSince)}` : "Updated " + stamp(Date.now()));
  const markStale = (at: number) => { s.staleSince = s.staleSince ? Math.min(s.staleSince, at) : at; };

  function compute(id: string) {
    const h0 = raw[id];
    if (!h0) return;
    const h = withLivePrice(h0, s.markets[id]);
    s.hists[id] = h;
    if (h.closes.length >= MIN_DAYS) s.analyses[id] = analyze(h, s.hists.bitcoin, s.markets[id]);
    else delete s.analyses[id];
    s.techs[id] = null;
  }
  const computeAll = () => { if (raw.bitcoin) compute("bitcoin"); for (const id of s.watch) if (id !== "bitcoin") compute(id); };

  async function loadMarkets(force: boolean) {
    const mk = await repo.markets(s.watch, force, URGENT);
    s.markets = { ...s.markets, ...mk.data };
    if (mk.stale) markStale(mk.at);
  }

  /** Load one coin's history. Problems that only affect this coin are noted on it; others are thrown. */
  async function loadCoin(id: string, force: boolean, priority: number) {
    try {
      const r = await repo.history(id, force, priority);
      raw[id] = r.data;
      delete s.coinErr[id];
      if (r.stale) markStale(r.at);
    } catch (e) {
      if (e instanceof ApiError && e.kind === "notfound") s.coinErr[id] = e.message;
      else if (e instanceof ApiError && e.kind === "offline") { if (!raw[id]) s.coinErr[id] = "No saved data for this coin yet. Connect to the internet and press Refresh."; s.lastErr = e.message; }
      else throw e;
    }
    if (id === "bitcoin") computeAll(); else compute(id);
    renderList(s, actions);
    if (id === s.selected || id === "bitcoin") renderDesk(s, actions);
  }

  let loading = false;
  async function loadAll(force: boolean) {
    if (loading) return;
    loading = true;
    s.lastErr = null;
    s.staleSince = null;
    try {
      await loadMarkets(force);
      computeAll();
      renderAll();
      const order = [...new Set([s.selected, "bitcoin", ...s.watch])];
      for (const id of order) {
        if (!s.watch.includes(id)) continue; // removed while loading
        await loadCoin(id, force, id === s.selected ? URGENT : BACKGROUND);
      }
      finalStatus();
    } catch (e) {
      s.lastErr = errText(e);
      setStatus("Data load stopped");
    }
    loading = false;
    renderAll();
  }

  async function ensureCoin(id: string, priority = URGENT) {
    try {
      if (!s.markets[id]) await loadMarkets(true);
      if (!raw[id]) await loadCoin(id, false, priority);
      else compute(id);
      if (!loading) finalStatus();
    } catch (e) {
      s.lastErr = errText(e);
    }
    renderAll();
    if (s.view === "discover") renderDiscover(s, actions);
  }

  async function loadDiscover(force = false) {
    const d = s.disc, sector = d.sector;
    d.loading = true; d.err = null;
    renderDiscover(s, actions);
    try {
      const r = await repo.discover(sector, force);
      if (sector !== d.sector) return; // the user picked another sector meanwhile
      d.data = r.data; d.at = r.at; d.stale = r.stale;
      // The Discover list doubles as fresh market data for watched coins.
      for (const m of r.data) if (s.watch.includes(m.id) && !r.stale) s.markets[m.id] = m;
      setStatus(r.stale ? `Offline: showing data saved ${stamp(r.at)}` : "Updated " + stamp(Date.now()));
    } catch (e) {
      if (sector === d.sector) d.err = errText(e);
    }
    if (sector === d.sector) { d.loading = false; renderDiscover(s, actions); }
  }

  const saveWatch = () => store.set(K.watch, s.watch);

  const actions: Actions = {
    selectCoin(id) {
      s.selected = id;
      store.set(K.sel, id);
      renderAll();
      if (!raw[id] || s.coinErr[id]) void ensureCoin(id);
      if (innerWidth < 940) $("desk").scrollIntoView({ behavior: "smooth" });
    },
    addToWatch(id) {
      if (s.watch.includes(id)) return;
      s.watch.push(id);
      saveWatch();
      const dm = (s.disc.data || []).find(x => x.id === id);
      if (dm) s.markets[id] = dm;
      renderList(s, actions);
      if (s.view === "discover") { renderDiscover(s, actions); void ensureCoin(id, BACKGROUND); }
    },
    removeSelected() {
      const id = s.selected;
      if (id === "bitcoin") return;
      s.watch = s.watch.filter(x => x !== id);
      saveWatch();
      repo.forgetHistory(id);
      delete raw[id]; delete s.hists[id]; delete s.analyses[id]; delete s.techs[id]; delete s.coinErr[id];
      s.selected = "bitcoin";
      store.set(K.sel, s.selected);
      s.tab = "overview";
      renderAll();
    },
    setTab(tab) { s.tab = tab; renderDesk(s, actions); },
    setView(v) {
      s.view = v;
      $("view-analyze").hidden = v !== "analyze";
      $("view-discover").hidden = v !== "discover";
      $("v-analyze").setAttribute("aria-pressed", String(v === "analyze"));
      $("v-discover").setAttribute("aria-pressed", String(v === "discover"));
      if (v === "discover") { if (!s.disc.data && !s.disc.loading) void loadDiscover(); else renderDiscover(s, actions); }
      else renderAll();
    },
    toggleOverlay(k) { s.taShow[k] = !s.taShow[k]; store.set(K.ta, s.taShow); renderDesk(s, actions); },
    setDiscover(patch) {
      const d = s.disc;
      const sectorChanged = patch.sector !== undefined && patch.sector !== d.sector;
      Object.assign(d, patch);
      store.set(K.disc, { sector: d.sector, tier: d.tier, sort: d.sort, hide: d.hide });
      if (sectorChanged) { d.data = null; d.stale = false; void loadDiscover(); }
      else renderDiscover(s, actions);
    },
    analyzeFromDiscover(id) { actions.addToWatch(id); actions.setView("analyze"); actions.selectCoin(id); },
    retryCoin(id) { delete s.coinErr[id]; s.lastErr = null; renderDesk(s, actions); void ensureCoin(id); },
  };

  // ----- Search -----
  const sIn = $<HTMLInputElement>("search"), sOut = $("results");
  let qTimer: ReturnType<typeof setTimeout> | undefined, qSeq = 0;
  sIn.oninput = () => {
    clearTimeout(qTimer);
    const q = sIn.value.trim();
    if (q.length < 2) { sOut.hidden = true; return; }
    qTimer = setTimeout(async () => {
      const mine = ++qSeq;
      sOut.innerHTML = `<div class="note" style="padding:10px">Searching…</div>`;
      sOut.hidden = false;
      try {
        const list = (await repo.search(q)).slice(0, 8);
        if (mine !== qSeq) return;
        sOut.innerHTML = list.length
          ? list.map(c => `<button type="button" data-id="${esc(c.id)}"><span style="font-weight:600">${esc(c.name)}</span><span class="muted">${esc(c.symbol)}</span><span class="muted" style="margin-left:auto">#${c.market_cap_rank ?? "—"}</span></button>`).join("")
          : `<div class="note" style="padding:10px">No match.</div>`;
        sOut.querySelectorAll<HTMLButtonElement>("button").forEach(b => (b.onclick = () => {
          sOut.hidden = true; sIn.value = "";
          actions.addToWatch(b.dataset.id!); actions.selectCoin(b.dataset.id!);
        }));
      } catch (e) {
        if (mine === qSeq) sOut.innerHTML = `<div class="note" style="padding:10px">${esc(errText(e))}</div>`;
      }
    }, 500);
  };
  document.addEventListener("click", e => { if (!(e.target as Element).closest(".add")) sOut.hidden = true; });
  document.addEventListener("keydown", e => { if (e.key === "Escape") sOut.hidden = true; });

  // ----- Views, refresh, settings -----
  $("v-analyze").onclick = () => actions.setView("analyze");
  $("v-discover").onclick = () => actions.setView("discover");
  $("refresh").onclick = () => { if (s.view === "discover") void loadDiscover(true); else void loadAll(true); };

  const sb = $("settings-btn"), sp = $("settings"), kIn = $<HTMLInputElement>("key"), kMsg = $("key-msg");
  const keyMsg = (t: string, ok: boolean | null) => { kMsg.textContent = t; kMsg.className = "key-msg" + (ok === true ? " ok" : ok === false ? " bad" : ""); };
  kIn.value = apiKey;
  sb.onclick = () => { sp.hidden = !sp.hidden; sb.setAttribute("aria-expanded", String(!sp.hidden)); };
  $("key-save").onclick = async () => {
    const k = kIn.value.trim();
    if (!k) { keyMsg("Paste a key first, or press Remove to use the keyless limit.", false); return; }
    apiKey = k;
    keyMsg(k.startsWith("CG-") ? "Checking the key…" : "Checking the key… (Demo keys usually start with CG-)", null);
    try {
      await client.get("/ping", URGENT + 1);
      store.set(K.key, apiKey);
      keyMsg("Key works and is saved. Faster loading enabled.", true);
      setStatus("Key saved. Faster loading enabled.");
      s.lastErr = null;
      void loadAll(false);
    } catch (e) {
      if (e instanceof ApiError && e.kind === "auth") { apiKey = store.get(K.key, ""); keyMsg(e.message, false); }
      else { store.set(K.key, apiKey); keyMsg("Saved, but CoinGecko couldn't be reached to check it: " + errText(e), null); }
    }
  };
  $("key-clear").onclick = () => {
    apiKey = ""; kIn.value = ""; store.del(K.key);
    keyMsg("Key removed. Using the keyless limit.", null);
    setStatus("Key removed. Using the keyless limit.");
  };

  addEventListener("online", () => { if (s.staleSince || s.lastErr) { setStatus("Back online. Updating…"); void loadAll(false); } });
  addEventListener("offline", () => setStatus("Offline: showing saved data"));

  renderAll();
  void loadAll(false);
}
