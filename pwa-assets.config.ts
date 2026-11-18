import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

// `npm run icons` turns public/favicon.svg into every PNG the app and phone need.
export default defineConfig({
  headLinkOptions: { preset: "2023" },
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, padding: 0.3, resizeOptions: { background: "#16202A" } },
    apple: { ...minimal2023Preset.apple, padding: 0.3, resizeOptions: { background: "#16202A" } },
  },
  images: ["public/favicon.svg"],
});
