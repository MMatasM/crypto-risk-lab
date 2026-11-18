/** Number, money and text formatting for the screens. */
import type { Tone } from "../analysis/scoring";

const eurFmt = new Map<string, Intl.NumberFormat>();
function fmt(min: number, max: number, extra: Intl.NumberFormatOptions = {}) {
  const k = `${min}/${max}/${JSON.stringify(extra)}`;
  let f = eurFmt.get(k);
  if (!f) { f = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", minimumFractionDigits: min, maximumFractionDigits: max, ...extra }); eurFmt.set(k, f); }
  return f;
}

/** A EUR price. Tiny prices keep 3 significant digits (€0.000000282, not €0.000000). */
export const eur = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 100) return fmt(2, 2).format(v);
  if (a >= 1) return fmt(2, 3).format(v);
  if (a >= 0.01) return fmt(2, 4).format(v);
  if (a === 0) return fmt(2, 2).format(0);
  const digits = Math.min(20, Math.max(6, -Math.floor(Math.log10(a)) + 2));
  return fmt(2, digits).format(v);
};

/** A large EUR amount in short form (€1.1T, €230M). */
export const big = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? "—" : new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", notation: "compact", maximumFractionDigits: 1 }).format(v);

/** A signed percentage from a fraction (0.123 -> "+12.3%"). */
export const pc = (v: number | null | undefined, d = 1): string => {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = (v * 100).toFixed(d);
  if (Number(s) === 0) return (0).toFixed(d) + "%"; // not "-0.0%" for a stablecoin
  return (v > 0 ? "+" : "") + s + "%";
};

/** An unsigned percentage from a fraction. */
export const pcu = (v: number | null | undefined, d = 0): string =>
  v == null || !Number.isFinite(v) ? "—" : (v * 100).toFixed(d) + "%";

/** "up" or "down" CSS class for a signed number. */
export const cls = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? "" : v >= 0 ? "up" : "down");

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export const pill = (k: Tone | "tier", t: string, dot = true): string => `<span class="pill ${dot ? "dot " : ""}p-${k}">${esc(t)}</span>`;

/** Short EUR label for chart axes. */
export function eurShort(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return "€" + new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v);
  if (a >= 1) return "€" + v.toFixed(2);
  if (a >= 0.01) return "€" + v.toFixed(3);
  if (a === 0) return "€0";
  return "€" + v.toFixed(Math.min(20, -Math.floor(Math.log10(a)) + 1));
}

export const stamp = (t: number): string => new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** Month name of a YYYY-MM-DD or YYYY-MM date, read as UTC so time zones can't shift it. */
export const monthName = (d: string, withYear = false): string =>
  new Date(d.length === 7 ? d + "-01T00:00:00Z" : d + "T00:00:00Z").toLocaleString("en", { month: "short", ...(withYear ? { year: "2-digit" } : {}), timeZone: "UTC" });
