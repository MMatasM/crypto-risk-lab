# Crypto Risk Lab

A watchlist with risk and trend scores, technical indicators, 30-day ranges, a backtester and a
Discover screener of the top 250 coins. Prices come from the free CoinGecko API, in EUR. It is an
installable web app (PWA): add it to a phone's home screen and it opens offline with the last
saved data.

There are no trading or exchange connections. Everything is computed from past prices.

## Run it on Windows

You need Node.js (LTS). Open PowerShell in this folder:

```powershell
npm install        # once, and after pulling changes that touch package.json
npm run dev        # starts the app at http://localhost:5173 (Ctrl+C to stop)
npm test           # unit tests for the indicator, backtest and data code
npm run build      # makes the publishable site in dist/
npm run preview    # serves dist/ at http://localhost:4173 to try the built app
```

The service worker (offline support) only runs in the built app (`build` then `preview`), not in `dev`.

## CoinGecko limits and the optional key

Without a key, CoinGecko's free API allows only about 4 requests a minute, so the first load of a
5-coin watchlist takes a minute or two (data is saved, so later visits are quick). A free
**Demo key** allows about 30 a minute: sign up at coingecko.com/en/api, open the Developer
Dashboard, create a Demo key (starts with `CG-`) and paste it under **Data settings**. The key is
stored only in that browser, on that device.

## Code layout

| Folder | What is in it |
|---|---|
| `src/data/` | `coingecko.ts` (request queue: per-minute budget, retries, priorities), `repository.ts` (what the app asks for, cached in browser storage, with stale fallback), `storage.ts`, `types.ts` |
| `src/analysis/` | Pure maths, no screen code: `indicators.ts` (SMA, EMA, RSI, MACD, Bollinger, OBV, drawdown), `scoring.ts` (risk/trend scores and rules), `technicals.ts`, `screen.ts` (Discover), `backtest.ts` |
| `src/ui/` | Screens: watchlist, desk and its tabs, Discover, charts, formatting |
| `src/app.ts` | Connects data, analysis and screens |
| `tests/` | Vitest unit tests |
| `public/` | Icons (`npm run icons` rebuilds the PNGs from `favicon.svg`) |

## Publishing

`.github/workflows/deploy.yml` builds, tests and publishes the app to GitHub Pages on every push to
`main`. See the step-by-step guide in `HOSTING.md`.
