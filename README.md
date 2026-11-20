# Crypto Risk Lab

A watchlist with risk and trend scores, technical indicators, 30-day ranges, a backtester, a
Discover screener of the top 250 coins, a nightly **scan** of the top 150 with an honestly tested
**forecasting model**, and daily **paper trading** (fake money, real prices).
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
npm run scan       # runs the market scan once (normally GitHub does this every night)
npm run forecast   # retrains and tests the forecasting model on the saved prices (no network needed)
npm run paper      # runs the paper trader once (normally GitHub does this every night)
npm run notify     # prints the Telegram summary for the last night (sends it only if the bot is set up)
```

The service worker (offline support) only runs in the built app (`build` then `preview`), not in `dev`.

## CoinGecko limits and the optional key

Without a key, CoinGecko's free API allows only about 4 requests a minute, so the first load of a
5-coin watchlist takes a minute or two (data is saved, so later visits are quick). A free
**Demo key** allows about 30 a minute: sign up at coingecko.com/en/api, open the Developer
Dashboard, create a Demo key (starts with `CG-`) and paste it under **Data settings**. The key is
stored only in that browser, on that device. The nightly paper trader uses its own copy of the key,
stored as a GitHub secret (see below).

## Signals, tracking and the Forecast tab

**Signals** (the third view; the site's address with `#signals` at the end) shows last night's scan: the
model's verdict first, then what changed since the scan before, then the ranked list with filters for size
tier, sector and risk, and each coin's 7- and 30-day chance of a rise with the range it moves in.
"How the model was tested, and its live record" opens the full tables.

**Track** (the ☆ in Signals, or the Track button on a coin's page) is saved in this browser: the coin joins
your watchlist and is highlighted in Signals. The nightly job can't see your browser, so for a coin outside
the top 150 to be scanned every night (and included in Telegram alerts), also add it to `watchlist` in
`public/data/scan/config.json`.

**Forecast** (a tab on each coin's page) shows tonight's two chances with their ranges, the return estimate,
the inputs that moved the forecast most, and how the model has done on that coin so far.

## The nightly run

Every night at about 00:30 UTC (GitHub sometimes starts it later), `.github/workflows/paper-trading.yml`
("Nightly run" in the Actions tab) does these jobs in order, saves the results in the repository and
republishes the site, all without your PC:

1. **Market scan** (`npm run scan`)
2. **Forecast** (`npm run forecast`)
3. **Paper trading** (`npm run paper`)
4. **Telegram summary** (`npm run notify`), if you have set it up (see below)

A job that fails doesn't stop the ones after it, and the run is still marked failed (red) so GitHub emails
you. You can start it by hand any time: GitHub, **Actions** tab, **Nightly run**, **Run workflow**. Running it
twice in a day changes nothing the second time.

## Market scan

Each night the scan takes the top 150 coins by market cap (after leaving out stablecoins, wrapped and staked
tokens and tokenized funds, with the same filter as the Discover view) plus every coin in the watchlist, and
for each one works out the same risk, trend and composite scores and the same technical consensus that the
coin page shows. They are ranked by composite score, best first.

**The files.**

| File | What is in it |
|---|---|
| `public/data/scan/config.json` | `topN` (how many coins), `watchlist` (CoinGecko ids always scanned and marked as tracked), `historyDays`. Edit by hand. |
| `public/data/scan/latest.json` | The newest ranked list, and what changed since the scan before: a new classification, a new technical consensus, a rank move of 15 places or more, a one-day move more than twice the coin's usual daily move, coins that entered or left. |
| `public/data/scan/history.json` | A compact copy of the last 45 scans. |
| `data/history/<coin>.csv` | Each coin's daily close and volume in EUR. Only ever extended; old days are never rewritten. |
| `data/sectors.json` | Which sector lists each coin is in (refreshed weekly). |

**CoinGecko calls.** The price history lives in the repository, so each night only the newest days are
fetched. CoinGecko has no way to ask for many coins' history at once, so that is still one call per coin:
about 155 calls a night (1 for the market list, 150 or so for the coins, 5 for paper trading, and 7 more once
a week for the sector lists), **roughly 5,000 a month, half of the free Demo key's 10,000**. To use fewer,
lower `topN` in `config.json` (100 coins is about 3,400 a month).

**The key matters here.** Without a Demo key CoinGecko allows only 2 to 4 calls a minute, so a scan of 150
coins takes over an hour, and coins not reached within 100 minutes wait for the next night. With the free
key it takes about 6 minutes. See "Adding the CoinGecko key to GitHub" below.

**To watch another coin every night**, add its CoinGecko id (the last part of its coingecko.com address,
such as `monero`) to `watchlist` in `public/data/scan/config.json`, commit and push.

## Forecasting model

An experiment, scored in the open: can anything in a coin's own price history say whether it will be higher
in 7 or in 30 days? **Read the verdict in the app (Signals view) before reading any forecast.** If the model
doesn't beat the simple baselines, the app says so in plain words at the top.

**What it predicts**, for every scanned coin, every night: the chance that the price is higher 7 days later
and 30 days later, plus an estimate of the return with a range around it.

**What it looks at** (16 inputs per coin per day, all from daily closes and volumes): returns over 1, 7, 30 and
90 days; 30-day volatility; RSI; MACD (against zero and against its signal line); distance from the 20-, 50-
and 200-day averages (the "200-day" average uses all of a coin's history until it has 200 days); last week's
trading volume against last month's; the fall from the 1-year high; and Bitcoin's own trend (30-day return,
distance from its 50- and 200-day averages) as the market's mood. Nothing else: no news, no order books.

**The models.** A regularised logistic regression (the simple one) and gradient-boosted trees (many small
decision trees, which can pick up "only when" patterns). Both are trained, tested, logged and scored every
night. Which of the two the app shows and the paper strategies trade on is set in
`public/data/model/config.json` (`primary`: `logit` or `gbt`), together with a note saying why. A ridge regression gives the return estimate; its range comes from the size of its own past
errors, scaled by each coin's volatility. Settings were fixed in advance and are not tuned to the results.

**Why TypeScript and not Python.** Training runs in the same language as the rest of the app, so the nightly
job needs nothing beyond `npm ci`: no second toolchain to install and keep working on GitHub. The inputs are
computed by the app's own indicator code, so training, the nightly forecast and the charts can never
disagree about what "RSI" means. The data is small (tens of thousands of rows, 16 columns), so the heavy
Python libraries would buy nothing; both models are a few hundred lines here and are unit-tested against
data with known answers (`tests/model/`), including tests that they do *not* find skill in pure noise.

**How it is tested (walk-forward).** For each week in the past: train only on outcomes that were already
known before that week, leaving a gap of the full 7 or 30 days so that no training outcome overlaps the week
being forecast; forecast that week; move on a week; repeat. Nothing from the future is ever used, and a test
checks that changing later prices leaves earlier inputs untouched. The forecasts are then scored on:

- **accuracy** (how often the forecast was on the right side of 50%),
- **Brier score** (the mean squared gap between the forecast chance and what happened; lower is better, and
  always saying 50% scores 0.25),
- **calibration** (when it said 60%, did it happen about 60% of the time?),

against three baselines: **always up** (as a probability: the share of rises seen so far), **simple
momentum** (the share of rises seen so far after an up month, or after a down month) and a **coin flip**.

**The verdict rule.** Coins move together and forecasts a day apart share most of their outcome, so thousands
of rows are worth only a few dozen independent observations. The comparison therefore groups the test days
into blocks two horizons long (14 days for 7-day forecasts, 60 for 30-day), counts each block once, and puts
a 95% range on the difference. The model "beats the baselines" only if that whole range is on the better
side of the best baseline. With fewer than 4 blocks the verdict is "too little history to say", which is
where 30-day forecasts stand until about a year more history has built up.

**Known weaknesses, stated up front.** CoinGecko's free data goes back one year, which is one market phase.
The test uses today's top coins; coins that collapsed and left the list are missing, which flatters every
number (the live record doesn't have this problem). And prices alone may simply not contain a usable signal.

**The live record.** Every night the forecasts are written to `data/model/log/<month>/<day>.csv`. A night's
file is written once and never changed. When the 7 or 30 days have passed, each forecast is scored with the
same code as the walk-forward test. This record can't have been fitted to the past; it is the one to watch.

| File | What is in it |
|---|---|
| `public/data/model/latest.json` | Tonight's forecasts: chance, range, return estimate and the inputs that moved it most, per coin. |
| `public/data/model/validation.json` | The walk-forward test: both models and the baselines, calibration, the verdicts, per-coin accuracy. |
| `public/data/model/track.json` | The live record: logged forecasts whose outcome is known, scored the same way. |
| `data/model/log/` | Every forecast ever made, one file per night. |

## Long history from Bitvavo (research only)

CoinGecko's free data stops at one year, so the long-term test uses **Bitvavo's public market data**: daily
EUR candles for every market Bitvavo lists, back to March 2019. Public endpoints only: no API key, no
account, no orders. The nightly run doesn't fetch or read these files.

```powershell
npm run bitvavo    # downloads the history (about 4 minutes the first time; later runs only add new days)
```

| File | What is in it |
|---|---|
| `data/bitvavo/<TICKER>.csv` | One market's daily close and volume in EUR, the same format as `data/history/`. |
| `data/bitvavo/index.json` | Every market with its first and last day, the assets Bitvavo no longer has a market for, and which market each scanned coin is. |

**What it covers (20 Nov 2026).** 418 coins after leaving out 6 stablecoins: 29 with 7 or more years, 61 with
5 to 7, 50 with 3 to 5, 109 with 2 to 3, 97 with 1 to 2 and 72 with under a year. Of the 148 scanned coins,
100 trade on Bitvavo in EUR; 48 don't (among them Monero, Zcash, Dash and the exchange tokens such as OKB
and LEO). A scanned coin is matched to a market only when its prices agree with CoinGecko's, never by ticker
alone (Terra Luna Classic trades as `LUNA`, IOTA as `MIOTA`).

**Survivorship bias: reduced, not gone.** The test uses every coin Bitvavo lists today, each from its first
day there, not just today's top coins. That brings in the losers that are still listed: 276 of the 418 now
trade more than 90% below their own Bitvavo high (FTX's token and Terra Luna Classic among them). What is
still missing: coins Bitvavo has removed. Its public API returns nothing for a delisted market. The asset
list still names 59 coins without an EUR market (32 marked delisted, the rest suspended), and coins removed
longer ago aren't named at all. So at least one coin in eight that could once be bought there is absent, and
those are mostly failures; every "buy and hold everything" number is therefore still somewhat too rosy.

## Long-term test (seven years, per market phase)

The one-year test above covers a single market phase. `npm run longtest` re-runs the **same models, the same
16 inputs and the same strict walk-forward method** on the Bitvavo history: 418 coins, September 2019 to
November 2026, about 390,000 forecasts per horizon. It also trades the paper strategies over those years with
the paper trader's own code. No network; nothing is tuned to the results; the nightly run doesn't call it.

```powershell
npm run longtest             # about 15 minutes the first time (it trains ~740 weekly models on several CPU cores)
npm run longtest -- --fresh  # train again instead of reusing the saved forecasts in .cache/
```

It writes `public/data/longtest/report.json`, shown in the app under **Signals**.

**How it is scored.** Overall, per calendar year, with Bitcoin above or below its 200-day average, and for
today's scanned coins against all the others: hit rate, Brier score, calibration and the rank correlation
between forecast and outcome, each next to the same baselines as the nightly test. **Significance:** a block
bootstrap by week. Whole calendar weeks are redrawn at random 2,000 times, in runs of 2 weeks (7-day
forecasts) or 9 (30-day) so overlapping forecasts stay together; "beat the baseline" is only said when the
whole 95% range of the difference is on the better side of zero. Strategies get the same check on how much
faster they grew than their benchmark.

**How the strategies are run.** Fee 0.25% and slippage 0.10% per trade, decided after one close and traded
at the next, exactly as in paper trading. To include coins listed later and coins that later collapsed, the
money is split afresh every 1 January over every coin tradable that day. The weekly top-5 picks from the 50
most traded coins on Bitvavo (its public data has no market caps, so volume stands in for size).

**Results (run of 20 Nov 2026).**

- **7-day forecasts:** prices rose in only 43.5% of cases. Boosted trees were right 55.5% of the time (Brier
  0.2497), logistic regression 54.8% (0.2477); simply using the share of rises seen so far was right 56.2%
  (0.2469). Neither model beat that baseline overall or in any single year; the trees were clearly worse in
  2020 and whenever Bitcoin was below its 200-day average.
- **30-day forecasts:** the trees were clearly *worse* than the baseline (0.2611 against 0.2439) and off by
  11 percentage points in calibration; logistic regression was no different from the baseline.
- **Ranking coins:** a small, real skill. Rank correlation 0.06 (95% range 0.05 to 0.08) for the trees; the
  fifth of coins they rated highest did 0.33 percentage points better over the next week than the average
  coin (range 0.11 to 0.55). A weekly switch costs about 0.7 points in fee and slippage, so it doesn't pay.
- **Strategies:** buying and holding Bitcoin made about 31% a year with a worst drop of 74%. Buying and
  holding every coin made 3% a year with a worst drop of 94%. The trend rules and the model strategies fell
  less (worst drops of 50% to 73% on the whole market) but none grew faster than its benchmark by more than
  luck would explain: every 95% range includes zero. The top-5 rotation's big total (boosted trees) was made
  in 2020 and 2021; it trailed Bitcoin in each of 2023, 2024 and 2025, and the same rotation on the logistic
  model ended below Bitcoin.

## Telegram alerts (optional)

One message a night at most, and only when something happened: a tracked coin (the `watchlist` in
`public/data/scan/config.json`) changed classification or moved more than twice its usual daily move, the
model's 7-day chance for a tracked coin crossed the 55% trading threshold, or a paper strategy traded.
On a quiet night nothing is sent. It costs nothing.

**Set it up once (about five minutes).**

1. In Telegram, search for **@BotFather** (the one with the blue tick), open it and press **Start**.
2. Send it `/newbot`. It asks for a name (anything, for example `Risk Lab alerts`) and then a username, which
   must end in `bot` (for example `matas_risklab_bot`).
3. BotFather replies with a **token**: a long line such as `1234567890:AAH...`. Treat it like a password:
   anyone who has it can send messages as your bot. Don't paste it into chats or commit it anywhere.
4. Tap the link to your new bot in BotFather's reply, press **Start**, and send it any message (`hi`).
   A bot can't write to you until you have written to it.
5. Find your **chat ID**: in a browser open `https://api.telegram.org/bot<TOKEN>/getUpdates`, with your token
   in place of `<TOKEN>`. In the text that appears, find `"chat":{"id":123456789`. That number is your chat ID.
   (If the page shows `"result":[]`, send the bot another message and reload.)
6. On GitHub open the repository, **Settings**, **Secrets and variables**, **Actions**, **New repository
   secret**. Add two secrets: name `TELEGRAM_BOT_TOKEN` with the token, and name `TELEGRAM_CHAT_ID` with
   the number. (Same page as the CoinGecko key.)
7. Test it: **Actions** tab, **Nightly run**, **Run workflow**, tick **Send a Telegram test message**, **Run
   workflow**. A test message should arrive within a few minutes.

GitHub hides secrets from everyone, including the logs. To stop the alerts, delete the two secrets.

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

A seventh strategy and a portfolio trade on the forecasting model (see "Model strategies" below).

The six above use the Backtest tab's default settings. The rules and the trading are the **same code** as
the Backtest tab (`rule` and `tradeDay` in `src/analysis/backtest.ts`), and a test checks that the
paper trader's daily values equal the backtester's to the last digit on the same prices.

**How a day works.** Every night the nightly run (above) runs `npm run paper`:

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
hand any time: GitHub, **Actions** tab, **Nightly run**, **Run workflow**.

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

**Model strategies.** Both started on their first nightly run with fresh money; the six older strategies and
their start date were not touched. They use the same fee and slippage and the same timing as everything
else: the decision for a day comes from the scan and forecast made after the *previous* day's close, and the
trade happens at that day's close.

- **Model (per coin):** holds the coin while the model's 7-day chance of a rise is above
  `settings.modelThreshold` (55%), otherwise cash. One per coin, €1,000 each, like the other strategies. Because
  it started later, its "vs buy and hold" column compares it with buying and holding from its own first day.
- **Top-k rotation (portfolio):** one pot of €1,000. Every 7 days it ranks the 50 biggest scanned coins by
  the average of two percentile ranks (the scan's composite score and the model's 7-day chance of a rise),
  holds the best 5 in equal parts, never more than 40% of the pot in one coin, and goes to cash while
  Bitcoin's close is below its 50-day average. The numbers are in `config.json` under `portfolio`.
  It is compared with two portfolios that started the same day with the same €1,000: **buy and hold
  Bitcoin**, and **equal weight** (an equal amount of each of the 50 biggest coins, bought once and held).
  Files: `portfolio.json` (the three portfolios day by day) and `portfolio-trades.json`.

If the forecast is missing for a night, the per-coin model strategy keeps its position and a due weekly
rebalance waits a day. If the model is no better than a coin flip, expect these two to lose to buy and hold
by roughly their trading costs. Finding that out with fake money is the point.

**Changing the config.** A coin or strategy added to `config.json` starts on the next night.
A pair keeps the fee and settings it started with, so its record stays comparable; changed fees or
settings only apply to pairs that start afterwards. To start everything again from scratch with new
settings, delete `state.json`, `trades.json` and `prices.json` from `public/paper/`, commit and push.

**Pull before you push.** The nightly job commits to the repository, so before pushing your own
changes from this PC, run `git pull` first.

**If it stops.** GitHub pauses scheduled workflows in a repository with no activity for 60 days
(the nightly commits should count as activity). If it ever happens, GitHub emails you; re-enable it
in the **Actions** tab, **Nightly run**, **Enable workflow**.

### Adding the CoinGecko key to GitHub (strongly recommended)

Without a key the nightly run still works, but at the slow keyless limit: the market scan then takes over an
hour and may not reach every coin. With the free Demo key it takes a few minutes.

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
| `src/scan/` | The nightly market scan, pure functions: `scan.ts` (which coins, scores, ranking, what changed), `history.ts` (the price files), `types.ts` (the file formats) |
| `src/model/` | The forecasting model, pure functions: `features.ts` (inputs and targets), `linear.ts` (logistic and ridge regression), `gbt.ts` (boosted trees), `walkforward.ts` (training, forecasting, the walk-forward test), `metrics.ts` and `report.ts` (scoring against baselines), `track.ts` (the forecast log and live record) |
| `src/alerts/` | `summary.ts`: what goes into the nightly Telegram message |
| `src/paper/` | Paper trading, pure functions: `trader.ts` (trades each new day, checks fetched prices), `portfolio.ts` (the weekly top-k portfolio and its benchmarks), `summary.ts` (leaderboards, curves), `types.ts` (the file formats) |
| `src/ui/` | Screens: watchlist, desk and its tabs (including `tabs/forecastTab.ts`), Discover, Signals (`signals.ts`), Paper trading (`paper.ts`), charts, formatting |
| `src/app.ts` | Connects data, analysis and screens |
| `scripts/scan.ts` | The nightly market scan: fetches the newest days, runs `src/scan/scan.ts`, saves `data/history/` and `public/data/scan/` |
| `scripts/forecast.ts` | The nightly forecast: retrains, re-tests, forecasts, logs, scores; saves `public/data/model/` and `data/model/log/` |
| `scripts/notify.ts` | Sends the nightly Telegram summary, once per night |
| `scripts/paper-trade.ts` | The nightly paper trader: fetches prices, runs `src/paper/trader.ts`, saves `public/paper/` |
| `tests/` | Vitest unit tests |
| `public/` | Icons (`npm run icons` rebuilds the PNGs from `favicon.svg`), `paper/` (paper trading files) and `data/` (scan results and forecasts) |
| `data/` | Price history and other files the nightly run keeps but the site doesn't publish |

## Publishing

`.github/workflows/deploy.yml` builds, tests and publishes the app to GitHub Pages on every push to
`main` (and after each nightly run). See the step-by-step guide in `HOSTING.md`.
