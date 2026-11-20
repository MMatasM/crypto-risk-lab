/**
 * The simple models: logistic regression (the chance of a rise) and ridge regression (the size of the move),
 * both with an L2 penalty that pulls the weights towards zero. Inputs are standardised with the training
 * rows' own mean and spread, and clipped, so one freak day can't dominate.
 */

/** Standardised inputs are clipped to this many standard deviations. */
const CLIP = 4;

export interface Scaler { mean: number[]; sd: number[] }

export function fitScaler(X: readonly number[][]): Scaler {
  const n = X.length, p = X[0].length, mean = new Array(p).fill(0), sd = new Array(p).fill(0);
  for (const x of X) for (let j = 0; j < p; j++) mean[j] += x[j];
  for (let j = 0; j < p; j++) mean[j] /= n;
  for (const x of X) for (let j = 0; j < p; j++) sd[j] += (x[j] - mean[j]) ** 2;
  for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j] / Math.max(1, n - 1)) || 1; // a constant column gets weight on nothing
  return { mean, sd };
}

export function scale(x: readonly number[], s: Scaler): number[] {
  return x.map((v, j) => Math.max(-CLIP, Math.min(CLIP, (v - s.mean[j]) / s.sd[j])));
}

/** Solves A x = b for a symmetric positive-definite A (Cholesky). A and b are not changed. */
export function solve(A: readonly number[][], b: readonly number[]): number[] {
  const n = b.length, L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) { if (!(s > 0)) throw new Error("the equations can't be solved (the inputs are degenerate)"); L[i][i] = Math.sqrt(s); }
      else L[i][j] = s / L[j][j];
    }
  }
  const y = new Array(n).fill(0), x = new Array(n).fill(0);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return x;
}

export const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

export interface LinearModel {
  scaler: Scaler;
  /** One weight per standardised input. */
  w: number[];
  b: number;
}

/**
 * Logistic regression minimising  mean log-loss + (lambda / 2) * sum(w^2)  (the intercept isn't penalised),
 * by Newton's method. With lambda = 0.01 the penalty weighs about as much as 100 rows of data.
 */
export function fitLogistic(X: readonly number[][], y: readonly number[], lambda: number): LinearModel {
  const scaler = fitScaler(X), Z = X.map(x => scale(x, scaler)), n = Z.length, p = Z[0].length, q = p + 1;
  const up = y.reduce((s, v) => s + v, 0) / n;
  const beta = new Array(q).fill(0); // weights, then the intercept
  beta[p] = Math.log(Math.min(0.999, Math.max(0.001, up)) / (1 - Math.min(0.999, Math.max(0.001, up))));
  for (let iter = 0; iter < 30; iter++) {
    const g = new Array(q).fill(0), H: number[][] = Array.from({ length: q }, () => new Array(q).fill(0));
    for (let i = 0; i < n; i++) {
      const z = Z[i];
      let eta = beta[p];
      for (let j = 0; j < p; j++) eta += beta[j] * z[j];
      const pr = sigmoid(eta), e = pr - y[i], wgt = Math.max(1e-9, pr * (1 - pr));
      for (let j = 0; j < p; j++) {
        g[j] += e * z[j];
        const wz = wgt * z[j], row = H[j];
        for (let k = 0; k <= j; k++) row[k] += wz * z[k];
        H[p][j] += wz;
      }
      g[p] += e; H[p][p] += wgt;
    }
    for (let j = 0; j < q; j++) {
      g[j] = g[j] / n + (j < p ? lambda * beta[j] : 0);
      for (let k = 0; k <= j; k++) { H[j][k] = H[j][k] / n + (j === k && j < p ? lambda : 0); H[k][j] = H[j][k]; }
    }
    H[p][p] += 1e-12;
    const d = solve(H, g);
    let big = 0;
    for (let j = 0; j < q; j++) { beta[j] -= d[j]; big = Math.max(big, Math.abs(d[j])); }
    if (big < 1e-9) break;
  }
  return { scaler, w: beta.slice(0, p), b: beta[p] };
}

/** The linear score (log-odds for logistic regression, the predicted value for ridge). */
export function score(m: LinearModel, x: readonly number[]): number {
  const z = scale(x, m.scaler);
  let s = m.b;
  for (let j = 0; j < z.length; j++) s += m.w[j] * z[j];
  return s;
}

export const predictLogistic = (m: LinearModel, x: readonly number[]) => sigmoid(score(m, x));

/** How much each input moved this prediction away from the average one (weight times standardised value). */
export function contributions(m: LinearModel, x: readonly number[]): number[] {
  return scale(x, m.scaler).map((z, j) => m.w[j] * z);
}

/**
 * Ridge regression minimising  mean squared error / (2 * var(y)) + (lambda / 2) * sum(w^2)  on standardised
 * inputs, so `lambda` means the same as in `fitLogistic`. Solved exactly.
 */
export function fitRidge(X: readonly number[][], y: readonly number[], lambda: number): LinearModel {
  const scaler = fitScaler(X), Z = X.map(x => scale(x, scaler)), n = Z.length, p = Z[0].length;
  const my = y.reduce((s, v) => s + v, 0) / n;
  const vy = y.reduce((s, v) => s + (v - my) ** 2, 0) / n || 1;
  const zm = new Array(p).fill(0);
  for (const z of Z) for (let j = 0; j < p; j++) zm[j] += z[j] / n; // clipping can move the mean a little off zero
  const A: number[][] = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const z = Z[i], e = y[i] - my;
    for (let j = 0; j < p; j++) {
      const zj = z[j] - zm[j];
      b[j] += zj * e;
      for (let k = 0; k <= j; k++) A[j][k] += zj * (z[k] - zm[k]);
    }
  }
  for (let j = 0; j < p; j++) {
    b[j] /= n * vy;
    for (let k = 0; k <= j; k++) { A[j][k] = A[j][k] / (n * vy) + (j === k ? lambda : 0); A[k][j] = A[j][k]; }
  }
  const w = solve(A, b);
  return { scaler, w, b: my - w.reduce((s, wj, j) => s + wj * zm[j], 0) };
}
