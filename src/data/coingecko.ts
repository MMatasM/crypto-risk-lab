/**
 * CoinGecko client with a paced request queue.
 *
 * - One request at a time, within a budget per rolling minute (keyless: 4; free Demo key: 28 of its 30).
 * - When CoinGecko throttles (HTTP 429, or a reply with no CORS headers, which the browser reports as a
 *   network error), it waits out the minute, lowers the budget and retries; the budget recovers after successes.
 * - Urgent requests (search, the coin you just clicked) jump ahead of background loading.
 * - Identical requests already waiting or in flight are shared.
 */

export const API_BASE = "https://api.coingecko.com/api/v3";

export type ApiErrorKind = "offline" | "network" | "rate" | "auth" | "notfound" | "http";

export class ApiError extends Error {
  constructor(public kind: ApiErrorKind, message: string, public status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  getKey: () => string;
  onStatus?: (text: string) => void;
  fetch?: (url: string) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isOnline?: () => boolean;
  base?: string;
}

/**
 * Request budget per rolling minute. Measured against the live API (Nov 2026): keyless CoinGecko
 * refused the 5th request inside ~26 seconds, so keyless allows 4 a minute; the free Demo key
 * allows 30, and the app uses 28 to leave room.
 */
export const PER_MIN_KEYLESS = 4;
export const PER_MIN_KEYED = 28;
/** Smallest spacing between two requests, even with budget left. */
export const MIN_GAP_KEYLESS = 1500;
export const MIN_GAP_KEYED = 500;
const WINDOW = 61000;
const MAX_ATTEMPTS = 5;

interface Job { path: string; priority: number; seq: number; resolve: (v: unknown) => void; reject: (e: unknown) => void }

export class CoinGeckoClient {
  private queue: Job[] = [];
  private running = false;
  /** Start times of recent requests (for the per-minute budget). */
  private recent: number[] = [];
  /** Lowered after CoinGecko throttles us, raised back slowly after successes. */
  private penalty = 0;
  private okStreak = 0;
  private seq = 0;
  private shared = new Map<string, Promise<unknown>>();
  private readonly fetchFn: (url: string) => Promise<Response>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly isOnline: () => boolean;
  private readonly base: string;

  constructor(private opts: ClientOptions) {
    this.fetchFn = opts.fetch ?? ((url: string) => fetch(url));
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.isOnline = opts.isOnline ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
    this.base = opts.base ?? API_BASE;
  }

  /** Requests allowed per rolling minute right now. */
  perMinute(): number {
    const base = this.opts.getKey() ? PER_MIN_KEYED : PER_MIN_KEYLESS;
    return Math.max(this.opts.getKey() ? 5 : 2, base - this.penalty);
  }

  /** How long to wait before the next request may start (0 = now). */
  waitTime(): number {
    const now = this.now();
    this.recent = this.recent.filter(t => now - t < WINDOW);
    const minGap = this.opts.getKey() ? MIN_GAP_KEYED : MIN_GAP_KEYLESS;
    const last = this.recent[this.recent.length - 1] ?? -Infinity;
    let wait = last + minGap - now;
    const limit = this.perMinute();
    if (this.recent.length >= limit) wait = Math.max(wait, this.recent[this.recent.length - limit] + WINDOW - now);
    return Math.max(0, wait);
  }

  /** Requests waiting (not counting the one in flight). */
  get waiting(): number { return this.queue.length; }

  /** GET a path such as "/coins/markets?vs_currency=eur". Higher priority runs first. */
  get<T>(path: string, priority = 0): Promise<T> {
    const existing = this.shared.get(path);
    if (existing) {
      // Promote a waiting duplicate if this caller is more urgent.
      const job = this.queue.find(j => j.path === path);
      if (job && priority > job.priority) job.priority = priority;
      return existing as Promise<T>;
    }
    const p = new Promise<unknown>((resolve, reject) => {
      this.queue.push({ path, priority, seq: this.seq++, resolve, reject });
    }).finally(() => this.shared.delete(path));
    this.shared.set(path, p);
    void this.pump();
    return p as Promise<T>;
  }

  private status(text: string) { this.opts.onStatus?.(text); }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
        const job = this.queue.shift()!;
        try { job.resolve(await this.run(job.path)); } catch (e) { job.reject(e); }
      }
    } finally {
      this.running = false;
    }
  }

  private url(path: string): string {
    const key = this.opts.getKey();
    return this.base + path + (key ? (path.includes("?") ? "&" : "?") + "x_cg_demo_api_key=" + encodeURIComponent(key) : "");
  }

  private async run(path: string): Promise<unknown> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (!this.isOnline()) throw new ApiError("offline", "You're offline. Showing saved data where there is some.");
      const wait = this.waitTime();
      if (wait > 0) {
        const q = this.queue.length + 1;
        this.status(`Waiting for CoinGecko's free limit… ${Math.ceil(wait / 1000)}s (${q} request${q > 1 ? "s" : ""} queued)`);
        await this.sleep(wait);
      }
      this.recent.push(this.now());
      let res: Response;
      try {
        res = await this.fetchFn(this.url(path));
      } catch {
        if (!this.isOnline()) throw new ApiError("offline", "You're offline. Showing saved data where there is some.");
        // A throttled reply arrives without CORS headers, so the browser reports a network error.
        if (attempt < MAX_ATTEMPTS) { await this.backOff(attempt, "CoinGecko didn't answer (usually its free rate limit)."); continue; }
        throw new ApiError("network", "Couldn't reach CoinGecko. Check your connection, wait a minute, then press Refresh.");
      }
      if (res.ok) {
        if (++this.okStreak >= 8 && this.penalty > 0) { this.penalty--; this.okStreak = 0; }
        try { return await res.json(); }
        catch { throw new ApiError("http", "CoinGecko sent a reply the app couldn't read."); }
      }
      if (res.status === 429) { if (attempt < MAX_ATTEMPTS) { await this.backOff(attempt, "CoinGecko rate limit."); continue; } break; }
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key|pro-api/i.test(body))) {
        throw new ApiError("auth", /pro-api/i.test(body)
          ? "That looks like a paid Pro key. This app uses the free Demo key; get one at coingecko.com/en/api, or remove the key in Data settings."
          : "CoinGecko rejected the API key. Check it in Data settings, or remove it to use the keyless limit.", res.status);
      }
      if (res.status === 404) throw new ApiError("notfound", "CoinGecko doesn't know this coin (it may have been delisted or renamed).", 404);
      if (res.status >= 500 && attempt < 3) { await this.backOff(attempt, `CoinGecko had a server error (${res.status}).`); continue; }
      throw new ApiError("http", `CoinGecko answered with error ${res.status}.`, res.status);
    }
    throw new ApiError("rate", "CoinGecko keeps rate-limiting. Wait a couple of minutes, or add a free key in Data settings.");
  }

  /** After a throttle: use a smaller budget for a while and wait out CoinGecko's one-minute window. */
  private async backOff(attempt: number, why: string) {
    this.penalty = Math.min(this.penalty + 1, 26);
    this.okStreak = 0;
    const w = Math.min(60000, 20000 * attempt);
    this.status(`${why} Retrying in ${w / 1000}s…`);
    await this.sleep(w);
  }
}
