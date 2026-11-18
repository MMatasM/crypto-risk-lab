/** A repeatable pseudo-random price series (same seed, same prices), for tests. */
export function randomWalk(n: number, seed: number, start = 100, dailyVol = 0.04): number[] {
  let s = seed >>> 0 || 1;
  const rand = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const out = [start];
  for (let i = 1; i < n; i++) {
    // Box-Muller for a normal shock
    const z = Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
    out.push(out[i - 1] * Math.exp(dailyVol * z));
  }
  return out;
}

export function dates(n: number, from = "2025-01-01"): string[] {
  const t0 = Date.parse(from + "T00:00:00Z");
  return Array.from({ length: n }, (_, i) => new Date(t0 + i * 864e5).toISOString().slice(0, 10));
}
