# Crypto Risk Lab

A watchlist with risk and trend scores, technical indicators, 30-day ranges, a backtester, a
Discover screener of the top 250 coins, and daily **paper trading** (fake money, real prices).
Prices come from the free CoinGecko API, in EUR. It is an installable web app (PWA): add it to a
phone's home screen and it opens offline with the last saved data.

There are no trading or exchange connections and no real money anywhere. Everything is computed
from past prices.

## Run it on Windows

You need Node.js (LTS). Open PowerShell in this folder:

```powershell
npm install        # once, and after pulling changes that touch package.json
npm run dev        # starts the app at http://localhost:5173 (Ctrl+C to stop)
npm test           # unit tests for the indicator, backtest, paper trading and data code
npm run build      # makes the publishable site in dist/
npm run preview    # serves dist/ at http://localhost:4173 to try the built app
npm run paper      # runs the paper trader once (normally GitHub does this every night)
```

The service worker (offline support) only runs in the built app (`build` then `preview`), not in `dev`.

## CoinGecko limits and the optional key

Without a key, CoinGecko's free API allows only about 4 requests a minute, so the first load of a
5-coin watchlist takes a minute or two (data is saved, so later visits are quick). A free
**Demo key** allows about 30 a minute: sign up at coingecko.com/en/api, open the Developer
Dashboard, create a Demo key (starts with `CG-`) and paste it under **Data settings**. The key is
stored only in that browser, on that device. The nightly paper trader uses its own copy of the key,
stored as a GitHub secret (see below).

## Paper trading

The goal: find out over the coming weeks and months whether any rule beats simply buying and
holding, with fake money and real prices. Open the **Paper trading** view in the app (or go to the
site's address with `#paper` at the end).

**What it trades.** Each coin in `public/paper/config.json` (bitcoin, ethereum, ripple (XRP),
solana, monero) gets six strategies, each with its own virtual €1,000:

| Strategy | Rule |
|---|---|
| Buy and hold | Buys on the first day, never sells. The baseline everything is compared with. |
| Weekly DCA | Buys 1/52 of the €1,000 every 7 days (the rest waits as cash), so it is fully invested after a year. |
| Above 50-day average | Holds while the close is above its 50-day average. |
| 20/50 crossover | Holds while the 20-day average is above the 50-day average. |
| MACD above signal | Holds while MACD (12/26/9) is above its signal line. |
| RSI 30/70 | Buys when RSI (14) falls below 30, sells when it rises above 70. |

These are the Backtest tab's default settings. The rules and the trading are the **same code** as
the Backtest tab (`rule` and `tradeDay` in `src/analysis/backtest.ts`), and a test checks that the
paper trader's daily values equal the backtester's to the last digit on the same prices.

**How a day works.** Every night at about 00:30 UTC (GitHub sometimes starts it later),
`.github/workflows/paper-trading.yml` runs `npm run paper`:

1. It fetches each coin's daily closes in EUR from CoinGecko. Only finished days count (today's
   price is still moving, so it is never traded).
2. For each finished day not yet traded, oldest first: the decision uses data up to the day before,
   and the trade happens at that day's close, exactly as in the Backtest tab. So the run at 00:30 on
   20 November trades the close of 19 November.
3. Costs per trade: a **0.25% fee** plus **0.10% slippage** (a buy fills 0.10% above the close, a
   sell 0.10% below). Both are in `config.json` (`fee`, `slippage`, as fractions).
4. It saves the results in `public/paper/` and commits them, then republishes the site, so the app
   shows the new day a few minutes later.

**Safe to re-run.** Running it twice in a day trades nothing the second time, and if it misses days
(GitHub down, CoinGecko down), the next run trades the missed days in order. You can start it by
hand any time: GitHub, **Actions** tab, **Paper trading**, **Run workflow**.

**When CoinGecko fails.** It retries with waits (and keeps within the rate limit). A coin whose data
still doesn't arrive, or looks wrong (prices that don't match the ones already saved, an implausible
jump), is skipped for that night and caught up on a later run. Nothing bad is written. If every coin
fails, the run is marked failed (red) and GitHub emails you.

**Start date.** The first run starts it: each coin's first trade is at the latest finished close at
that time. The app shows "Started on …, N days of data". A few weeks is far too short to trust a
winner; give it many months, and judge the worst drop as well as the return.

**The files** (in `public/paper/`, published with the site):

| File | What is in it |
|---|---|
| `config.json` | Coins, strategies, fee, slippage and settings. Edit by hand. |
| `prices.json` | The daily closes the trader used. Only ever extended; old closes are never rewritten. |
| `state.json` | Each strategy-coin pair: cash, coins held, value after every day. |
| `trades.json` | Every trade: date, coin, strategy, buy/sell, price, amount, fee, slippage, reason. |

**Changing the config.** A coin or strategy added to `config.json` starts on the next night.
A pair keeps the fee and settings it started with, so its record stays comparable; changed fees or
settings only apply to pairs that start afterwards. To start everything again from scratch with new
settings, delete `state.json`, `trades.json` and `prices.json` from `public/paper/`, commit and push.

**Pull before you push.** The nightly job commits to the repository, so before pushing your own
changes from this PC, run `git pull` first.

**If it stops.** GitHub pauses scheduled workflows in a repository with no activity for 60 days
(the nightly commits should count as activity). If it ever happens, GitHub emails you; re-enable it
in the **Actions** tab, **Paper trading**, **Enable workflow**.

### Adding the CoinGecko key to GitHub (optional, recommended)

Without a key it still works, but at the slow keyless limit, which GitHub's shared servers may hit
more often. With the free Demo key it is more reliable.

1. Get a free Demo key if you don't have one: go to coingecko.com/en/api, sign up or sign in, open
   the **Developer Dashboard** and create a **Demo** key. Copy it (it starts with `CG-`).
2. Go to https://github.com/MMatasM/crypto-risk-lab and sign in.
3. Click **Settings** (in the bar under the repository name; the gear icon).
4. In the left menu, click **Secrets and variables**, then **Actions**.
5. Click the green **New repository secret** button.
6. In **Name**, type exactly: `COINGECKO_DEMO_KEY`
7. In **Secret**, paste the key. No spaces before or after it.
8. Click **Add secret**.

GitHub keeps the key hidden: nobody can read it back (not even you), it never appears in the code or
the logs, and only this repository's workflows can use it. To change it later, open the same page,
click the pencil next to `COINGECKO_DEMO_KEY` and paste the new key.

## Code layout

| Folder | What is in it |
|---|---|
| `src/data/` | `coingecko.ts` (request queue: per-minute budget, retries, priorities), `repository.ts` (what the app asks for, cached in browser storage, with stale fallback), `storage.ts`, `types.ts` |
| `src/analysis/` | Pure maths, no screen code: `indicators.ts` (SMA, EMA, RSI, MACD, Bollinger, OBV, drawdown), `scoring.ts` (risk/trend scores and rules), `technicals.ts`, `screen.ts` (Discover), `backtest.ts` (the strategy rules and the trading, shared with paper trading) |
| `src/paper/` | Paper trading, pure functions: `trader.ts` (trades each new day, checks fetched prices), `summary.ts` (leaderboards, curves), `types.ts` (the file formats) |
| `src/ui/` | Screens: watchlist, desk and its tabs, Discover, Paper trading (`paper.ts`), charts, formatting |
| `src/app.ts` | Connects data, analysis and screens |
| `scripts/paper-trade.ts` | The nightly job: fetches prices, runs `src/paper/trader.ts`, saves `public/paper/` |
| `tests/` | Vitest unit tests |
| `public/` | Icons (`npm run icons` rebuilds the PNGs from `favicon.svg`) and `paper/` (paper trading files) |

## Publishing

`.github/workflows/deploy.yml` builds, tests and publishes the app to GitHub Pages on every push to
`main` (and after each nightly paper trading run). See the step-by-step guide in `HOSTING.md`.
