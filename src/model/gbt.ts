/**
 * Gradient-boosted decision trees for a yes/no target (the chance of a rise): many small trees, each one
 * correcting the mistakes of the ones before. Unlike logistic regression it can pick up "only when" rules,
 * such as "momentum matters only when Bitcoin is above its average".
 *
 * Standard second-order boosting on log-loss (the XGBoost recipe), with inputs sorted into quantile bins.
 * The same seed always gives the same model.
 */
import { sigmoid } from "./linear";

export interface GbtOptions {
  trees: number;
  /** Splits from the root to a leaf (3 = at most 8 leaves). */
  depth: number;
  /** How much of each tree's correction is applied. */
  rate: number;
  /** The fewest rows a leaf may hold, as a share of the training rows. */
  minLeafShare: number;
  /** L2 penalty on leaf values. */
  lambda: number;
  /** Share of rows each tree sees. */
  subsample: number;
  bins: number;
  seed: number;
}

/** Chosen before looking at any results and not tuned: small, slow-learning trees with big leaves. */
export const GBT_DEFAULTS: GbtOptions = { trees: 100, depth: 3, rate: 0.05, minLeafShare: 0.02, lambda: 1, subsample: 0.7, bins: 32, seed: 1 };

/** A split (rows with x[f] <= thr go left) or, when f is -1, a leaf. `value` is the node's own correction. */
interface Node { f: number; thr: number; left: number; right: number; value: number }

export interface GbtModel {
  /** The starting log-odds (the share of rises in the training rows). */
  base: number;
  rate: number;
  trees: Node[][];
  /** How much each input improved the fit, as shares adding up to 1. */
  importance: number[];
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Up to `bins - 1` cut points per input, at evenly spaced quantiles of the training values. */
function cutPoints(X: readonly number[][], j: number, bins: number): number[] {
  const v = X.map(x => x[j]).sort((a, b) => a - b), out: number[] = [];
  for (let b = 1; b < bins; b++) {
    const t = v[Math.min(v.length - 1, Math.floor(b * v.length / bins))];
    if (t < v[v.length - 1] && (!out.length || t > out[out.length - 1])) out.push(t);
  }
  return out;
}

export function fitGbt(X: readonly number[][], y: readonly number[], options: Partial<GbtOptions> = {}): GbtModel {
  const o = { ...GBT_DEFAULTS, ...options }, n = X.length, p = X[0].length;
  const cuts = Array.from({ length: p }, (_, j) => cutPoints(X, j, o.bins));
  const B = new Uint8Array(n * p);
  for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) {
    const c = cuts[j], x = X[i][j];
    let lo = 0, hi = c.length; // the bin is the number of cut points below x
    while (lo < hi) { const mid = (lo + hi) >> 1; if (x > c[mid]) lo = mid + 1; else hi = mid; }
    B[i * p + j] = lo;
  }
  const up = Math.min(0.999, Math.max(0.001, y.reduce((s, v) => s + v, 0) / n));
  const base = Math.log(up / (1 - up));
  const F = new Float64Array(n).fill(base), g = new Float64Array(n), h = new Float64Array(n);
  const minLeaf = Math.max(1, Math.floor(o.minLeafShare * n * o.subsample));
  const rand = rng(o.seed), gain = new Array(p).fill(0), trees: Node[][] = [];
  const hg = new Float64Array(o.bins), hh = new Float64Array(o.bins), hc = new Int32Array(o.bins);

  for (let t = 0; t < o.trees; t++) {
    for (let i = 0; i < n; i++) { const pr = sigmoid(F[i]); g[i] = pr - y[i]; h[i] = Math.max(1e-9, pr * (1 - pr)); }
    const rows: number[] = [];
    for (let i = 0; i < n; i++) if (o.subsample >= 1 || rand() < o.subsample) rows.push(i);
    const nodes: Node[] = [];
    const grow = (idx: number[], depth: number): number => {
      let G = 0, H = 0;
      for (const i of idx) { G += g[i]; H += h[i]; }
      const me = nodes.length;
      nodes.push({ f: -1, thr: 0, left: -1, right: -1, value: -G / (H + o.lambda) });
      if (depth >= o.depth || idx.length < 2 * minLeaf) return me;
      const parent = G * G / (H + o.lambda);
      let best = 1e-10, bf = -1, bb = -1;
      for (let j = 0; j < p; j++) {
        const nb = cuts[j].length + 1;
        if (nb < 2) continue;
        hg.fill(0, 0, nb); hh.fill(0, 0, nb); hc.fill(0, 0, nb);
        for (const i of idx) { const b = B[i * p + j]; hg[b] += g[i]; hh[b] += h[i]; hc[b]++; }
        let GL = 0, HL = 0, nL = 0;
        for (let b = 0; b < nb - 1; b++) {
          GL += hg[b]; HL += hh[b]; nL += hc[b];
          if (nL < minLeaf) continue;
          if (idx.length - nL < minLeaf) break;
          const gn = GL * GL / (HL + o.lambda) + (G - GL) ** 2 / (H - HL + o.lambda) - parent;
          if (gn > best) { best = gn; bf = j; bb = b; }
        }
      }
      if (bf < 0) return me;
      const L: number[] = [], R: number[] = [];
      for (const i of idx) (B[i * p + bf] <= bb ? L : R).push(i);
      gain[bf] += best;
      nodes[me].f = bf; nodes[me].thr = cuts[bf][bb];
      nodes[me].left = grow(L, depth + 1);
      nodes[me].right = grow(R, depth + 1);
      return me;
    };
    grow(rows, 0);
    trees.push(nodes);
    for (let i = 0; i < n; i++) F[i] += o.rate * leafValue(nodes, X[i]);
  }
  const total = gain.reduce((s, v) => s + v, 0) || 1;
  return { base, rate: o.rate, trees, importance: gain.map(v => v / total) };
}

function leafValue(nodes: Node[], x: readonly number[]): number {
  let k = 0;
  while (nodes[k].f >= 0) k = x[nodes[k].f] <= nodes[k].thr ? nodes[k].left : nodes[k].right;
  return nodes[k].value;
}

export function predictGbt(m: GbtModel, x: readonly number[]): number {
  let F = m.base;
  for (const t of m.trees) F += m.rate * leafValue(t, x);
  return sigmoid(F);
}

/**
 * How much each input moved this prediction's log-odds: every split a row passes through hands the change
 * in value from parent to child to the input it split on. The parts, plus `base` and the trees' root values,
 * add up to the prediction's log-odds.
 */
export function gbtContributions(m: GbtModel, x: readonly number[]): number[] {
  const out = new Array(x.length).fill(0);
  for (const nodes of m.trees) {
    let k = 0;
    while (nodes[k].f >= 0) {
      const next = x[nodes[k].f] <= nodes[k].thr ? nodes[k].left : nodes[k].right;
      out[nodes[k].f] += m.rate * (nodes[next].value - nodes[k].value);
      k = next;
    }
  }
  return out;
}
