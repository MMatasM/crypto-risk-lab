/**
 * The heavy part of the long-term test: the walk-forward forecasts on seven years of Bitvavo history.
 * The weekly steps don't depend on each other, so they are shared out over several processes; the result
 * is kept in .cache/ (not in the repository) so the report can be rebuilt without training again.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { History } from "../../src/data/types";
import { buildSamples, type Horizon, type Sample } from "../../src/model/features";
import { GBT_DEFAULTS } from "../../src/model/gbt";
import { MODEL_DEFAULTS, walkForwardStarts, walkForwardStep, type Tested } from "../../src/model/walkforward";
import type { BitvavoIndex } from "../../src/research/bitvavo";
import { buildUniverse, type Universe } from "../../src/research/universe";
import { parseCsv } from "../../src/scan/history";
import { loadJson, loadText } from "./io";

export const BITVAVO_DIR = process.env.BITVAVO_DIR || join("data", "bitvavo");
export const CACHE_DIR = process.env.LONGTEST_CACHE || join(".cache", "longtest");

export async function loadUniverse(): Promise<{ index: BitvavoIndex; universe: Universe }> {
  const index = await loadJson<BitvavoIndex>(join(BITVAVO_DIR, "index.json"));
  const raw = new Map<string, History>();
  for (const m of index.markets) { const text = await loadText(join(BITVAVO_DIR, m.market + ".csv")); if (text) raw.set(m.market, parseCsv(text)); }
  return { index, universe: buildUniverse(index, raw) };
}

export interface WalkResult { rows: Tested[]; folds: number; firstTrainRows: number; lastTrainRows: number }
interface Part { start: number; rows: Tested[]; trainRows: number }

/** A worker process: the steps whose number leaves remainder `k` when divided by `of`. */
export async function runWorker(h: Horizon, k: number, of: number, out: string): Promise<void> {
  const { universe } = await loadUniverse();
  const labelled = buildSamples(universe.histories).filter(s => s.fwd[h] != null);
  const starts = walkForwardStarts(labelled, h), parts: Part[] = [];
  for (let i = k; i < starts.length; i += of) {
    const step = walkForwardStep(labelled, h, starts[i]);
    if (step) parts.push({ start: starts[i], rows: step.rows, trainRows: step.trainRows });
  }
  await writeFile(out, JSON.stringify(parts));
}

/** The walk-forward forecasts for one horizon, from the cache when the data and settings are unchanged. */
export async function longWalkForward(samples: readonly Sample[], h: Horizon, script: string, fresh = false): Promise<WalkResult> {
  await mkdir(CACHE_DIR, { recursive: true });
  const labelled = samples.filter(s => s.fwd[h] != null);
  const key = JSON.stringify([labelled.length, labelled[labelled.length - 1]?.day, labelled.reduce((s, x) => s + (x.fwd[h] as number), 0), MODEL_DEFAULTS, GBT_DEFAULTS]);
  const file = join(CACHE_DIR, `walk-${h}.json`);
  if (!fresh) {
    try { const saved = JSON.parse(await readFile(file, "utf8")) as { key: string; result: WalkResult }; if (saved.key === key) return saved.result; } catch { /* no cache yet */ }
  }
  const workers = Math.max(1, Math.min(Number(process.env.LONGTEST_WORKERS) || availableParallelism() - 1, 12));
  const started = Date.now();
  console.log(`  ${h}-day: ${walkForwardStarts(labelled, h).length} weekly steps on ${labelled.length} coin-days, ${workers} processes…`);
  const outs = Array.from({ length: workers }, (_, k) => join(CACHE_DIR, `part-${h}-${k}.json`));
  await Promise.all(outs.map((out, k) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, script, "--worker", String(h), String(k), String(workers), out], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`worker ${k} stopped with code ${code}`))));
  })));
  const parts: Part[] = [];
  for (const out of outs) parts.push(...JSON.parse(await readFile(out, "utf8")) as Part[]);
  parts.sort((a, b) => a.start - b.start);
  const result: WalkResult = { rows: parts.flatMap(p => p.rows), folds: parts.length, firstTrainRows: parts[0]?.trainRows ?? 0, lastTrainRows: parts[parts.length - 1]?.trainRows ?? 0 };
  await writeFile(file, JSON.stringify({ key, result }));
  console.log(`  ${h}-day: ${result.rows.length} forecasts in ${result.folds} steps (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  return result;
}
