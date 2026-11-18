# Putting Crypto Risk Lab online (free) and on your phone

**Recommended: GitHub Pages.** You already have a GitHub account and this folder is already a git
repository. The included workflow rebuilds and republishes the app every time you push, and only
publishes if the tests pass. The address will be `https://<your-github-name>.github.io/crypto-risk-lab/`.

One catch: on a free GitHub account, Pages only works for **public** repositories, so anyone could
read the code. The code has no secrets (your CoinGecko key is never in it; it stays in your
browser). If you'd rather keep the repository private, use Cloudflare Pages instead (section B).

## A. GitHub Pages (about 10 minutes, once)

1. Go to https://github.com/new and sign in.
2. Repository name: `crypto-risk-lab`. Choose **Public**. Leave "Add a README", ".gitignore" and
   "license" all unticked (the project already has them). Click **Create repository**.
3. In PowerShell, in the project folder (`C:\(((((Pinigai)\Investicijos\1. Crypto\crypto-risk-lab`), run
   these two commands, putting your GitHub user name in the first one:

   ```powershell
   git remote add origin https://github.com/<your-github-name>/crypto-risk-lab.git
   ```

   ```powershell
   git push -u origin main
   ```

   A browser window may ask you to sign in to GitHub the first time. Allow it.
4. On the repository page on GitHub, click **Settings** (top bar), then **Pages** (left menu).
5. Under "Build and deployment", set **Source** to **GitHub Actions**. Nothing else to change.
6. Click the **Actions** tab. If the "Deploy to GitHub Pages" run failed or did not start (it can
   start before step 5), click it, then **Re-run all jobs**. Wait for the green tick (2–3 minutes).
7. Back in **Settings > Pages**, the address is shown at the top ("Your site is live at …"). Open it.

**Updating later:** change the code, commit, then `git push`. The site updates itself in a few
minutes, and phones pick up the new version the next time the app is opened (sometimes the
second time).

## B. Cloudflare Pages (if you want the repository private)

1. Do steps A1–A3, but choose **Private** in step 2.
2. Go to https://dash.cloudflare.com, sign up (free) and sign in.
3. Open **Workers & Pages**, click **Create**, choose the **Pages** tab, then **Connect to Git**.
4. Connect your GitHub account, allow access to the `crypto-risk-lab` repository only, and select it.
5. Build settings: Framework preset **None**, Build command `npm run build`, Build output
   directory `dist`. Click **Save and Deploy**.
6. When it finishes you get an address like `https://crypto-risk-lab.pages.dev`. Every push to
   `main` republishes it. (The GitHub workflow will also run and fail without Pages switched on;
   you can delete `.github/workflows/deploy.yml` if you use Cloudflare.)

## C. Install it on your Samsung S24 FE

1. On the phone, open **Chrome** and go to your site's address.
2. Wait until the watchlist has loaded once (this also saves the app for offline use).
3. Tap the **⋮** menu (top right), then **Add to home screen** (or **Install app** if Chrome offers
   it), then **Install**.
4. The **Risk Lab** icon appears on the home screen and opens full screen, like an app.
5. Optional: open **Data settings** in the app and paste your free CoinGecko Demo key. Each device
   needs its own copy of the key, since it is stored only on that device.

In Samsung Internet the menu is **≡ > Add page to > Home screen**.

Offline, the app opens and shows the last data it saved, with a note saying how old it is.
New prices need a connection.
