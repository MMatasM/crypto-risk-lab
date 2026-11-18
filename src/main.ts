// Fonts are bundled with the app (no Google Fonts request), so the look is the same offline.
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/sora/latin-500.css";
import "@fontsource/sora/latin-600.css";
import "@fontsource/sora/latin-700.css";
import "./styles.css";
import { registerSW } from "virtual:pwa-register";
import { startApp } from "./app";

startApp();

// Offline support: the service worker caches the app itself; a new version installs on the next visit.
if ("serviceWorker" in navigator) registerSW({ immediate: true });
