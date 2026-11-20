/** File helpers shared by the nightly scripts. */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/** Reads a JSON file. A missing file gives `fallback` (when one is passed); anything else unreadable is an error. */
export async function loadJson<T>(path: string, fallback?: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (e) {
    if (missing(e) && fallback !== undefined) return fallback;
    throw new Error(`Can't read ${path}: ${(e as Error).message}`);
  }
}

/** Reads a text file, or null when it doesn't exist. */
export async function loadText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (e) { if (missing(e)) return null; throw new Error(`Can't read ${path}: ${(e as Error).message}`); }
}

/** JSON that stays readable in git: objects indented, lists of numbers or words on one line, one record per line. */
export function stringify(v: unknown, indent = ""): string {
  if (Array.isArray(v)) {
    if (v.every(x => x === null || typeof x !== "object")) return JSON.stringify(v);
    return "[\n" + v.map(x => indent + "  " + JSON.stringify(x)).join(",\n") + "\n" + indent + "]";
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    if (!entries.length) return "{}";
    return "{\n" + entries.map(([k, x]) => `${indent}  ${JSON.stringify(k)}: ${stringify(x, indent + "  ")}`).join(",\n") + "\n" + indent + "}";
  }
  return JSON.stringify(v);
}

/** Writes to a temporary file first, so a crash can never leave half a file. */
export async function saveText(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

export const saveJson = (path: string, data: unknown) => saveText(path, stringify(data) + "\n");

/** Prints the report and, on GitHub, adds it to the run's summary page. */
export async function report(text: string) {
  console.log("\n" + text);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text + "\n\n");
}

/** The current UTC day. Its close isn't final yet, so the nightly scripts never use it. */
export const utcToday = () => (process.env.RUN_DATE && /^\d{4}-\d{2}-\d{2}$/.test(process.env.RUN_DATE) ? process.env.RUN_DATE : new Date().toISOString().slice(0, 10));
