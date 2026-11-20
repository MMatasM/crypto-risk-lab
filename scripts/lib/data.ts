/** Loading the files the nightly scripts share: the price histories and the forecast log. */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { History } from "../../src/data/types";
import { parseLog } from "../../src/model/track";
import { DEFAULT_MODEL_CONFIG, type LogRow, type ModelConfig } from "../../src/model/types";
import { parseCsv } from "../../src/scan/history";
import { loadJson, loadText } from "./io";

export const HISTORY_DIR = process.env.HISTORY_DIR || join("data", "history");
export const MODEL_LOG_DIR = process.env.MODEL_LOG_DIR || join("data", "model", "log");
export const MODEL_DIR = process.env.MODEL_DIR || join("public", "data", "model");

/** Which model the app shows and the paper strategies trade on (public/data/model/config.json). */
export async function loadModelConfig(): Promise<ModelConfig> {
  const c = await loadJson<ModelConfig>(join(process.env.MODEL_CONFIG_DIR || join("public", "data", "model"), "config.json"), DEFAULT_MODEL_CONFIG);
  if (c.primary !== "logit" && c.primary !== "gbt") throw new Error('public/data/model/config.json: primary must be "logit" or "gbt"');
  return { primary: c.primary, note: typeof c.note === "string" ? c.note : "" };
}

const list = async (dir: string) => { try { return (await readdir(dir)).sort(); } catch { return []; } };

/** Every coin's saved daily history, by CoinGecko id. A file that can't be read is left out with a warning. */
export async function loadHistories(dir = HISTORY_DIR): Promise<Map<string, History>> {
  const out = new Map<string, History>();
  for (const f of (await list(dir)).filter(f => f.endsWith(".csv"))) {
    try { out.set(f.slice(0, -4), parseCsv((await loadText(join(dir, f)))!)); }
    catch (e) { console.log(`::warning::${f} can't be read and was left out: ${(e as Error).message}`); }
  }
  return out;
}

/** Every forecast ever logged, oldest night first. */
export async function loadLog(dir = MODEL_LOG_DIR): Promise<LogRow[]> {
  const out: LogRow[] = [];
  for (const month of await list(dir)) for (const f of (await list(join(dir, month))).filter(f => f.endsWith(".csv"))) out.push(...parseLog((await loadText(join(dir, month, f)))!));
  return out;
}
