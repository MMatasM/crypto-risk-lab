/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// base "./" makes the built site work from any folder or host
// (GitHub Pages serves it under /<repo-name>/, Netlify and Cloudflare at /).
export default defineConfig({
  base: "./",
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false, // registered in src/main.ts
      manifest: {
        name: "Crypto Risk Lab",
        short_name: "Risk Lab",
        description: "Watchlist, risk and trend scores, indicators, 30-day ranges, backtests and a top-250 screener (CoinGecko data, EUR).",
        lang: "en",
        start_url: "./",
        scope: "./",
        display: "standalone",
        orientation: "any",
        background_color: "#16202A",
        theme_color: "#16202A",
        categories: ["finance", "utilities"],
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // The app shell (HTML, JS, CSS, fonts, icons) is precached so the app opens offline.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Coin logos: keep them so Discover and the watchlist look right offline.
            urlPattern: ({ url }) => url.hostname.endsWith("coingecko.com") && url.pathname.includes("/coins/images/"),
            handler: "CacheFirst",
            options: {
              cacheName: "coin-images",
              expiration: { maxEntries: 600, maxAgeSeconds: 30 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
        // Price data is NOT cached by the service worker: the app keeps its own copy
        // (with timestamps) in browser storage and shows it, marked as offline, when the network is gone.
      },
    }),
  ],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
