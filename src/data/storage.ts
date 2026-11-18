/**
 * A small wrapper around localStorage. Reads and writes never throw (private windows and full
 * storage just behave like an empty store). When storage is full, old cached data is dropped first.
 */
export interface Store {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): boolean;
  del(key: string): void;
  keys(prefix: string): string[];
}

/** Keys holding cached API data (safe to drop; they are fetched again). Settings use other keys. */
export const CACHE_PREFIX = "crl3.c.";

function makeStore(ls: Storage | null): Store {
  const keys = (prefix: string) => {
    if (!ls) return [];
    const out: string[] = [];
    try { for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.startsWith(prefix)) out.push(k); } } catch { /* ignore */ }
    return out;
  };
  const evictOldest = (count: number) => {
    const entries = keys(CACHE_PREFIX).map(k => {
      try { return { k, t: (JSON.parse(ls!.getItem(k) || "{}") as { t?: number }).t ?? 0 }; } catch { return { k, t: 0 }; }
    }).sort((a, b) => a.t - b.t);
    for (const e of entries.slice(0, Math.max(1, count))) { try { ls!.removeItem(e.k); } catch { /* ignore */ } }
    return entries.length > 0;
  };
  return {
    get<T>(key: string, fallback: T): T {
      try { const v = ls?.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
    },
    set(key: string, value: unknown): boolean {
      if (!ls) return false;
      const text = JSON.stringify(value);
      for (let attempt = 0; attempt < 4; attempt++) {
        try { ls.setItem(key, text); return true; }
        catch { if (!evictOldest(4)) return false; }
      }
      return false;
    },
    del(key: string) { try { ls?.removeItem(key); } catch { /* ignore */ } },
    keys,
  };
}

function browserStorage(): Storage | null {
  try { return typeof window !== "undefined" && window.localStorage ? window.localStorage : null; } catch { return null; }
}

export const store: Store = makeStore(browserStorage());

/** An in-memory store, for tests. */
export function memoryStore(): Store {
  const m = new Map<string, string>();
  const fake = {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  } as Storage;
  return makeStore(fake);
}
