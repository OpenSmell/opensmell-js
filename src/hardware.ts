/** Hardware sufficiency gate (§10.10 N→M limit).
 *
 * Zero-shot feature transfer is only sanctioned when
 * `min_effective_dimensions(model) <= effective_dims(rig)`. Same-family MOX
 * channels covary (humidity/temperature are common-mode), so the effective
 * dimensionality of a rig grows far slower than its channel count: two ≈ 1,
 * three ≈ 1.5–2, four ≈ 2–3. Lower bounds are used so the gate warns early.
 *
 * This module is Warn-and-Proceed: an insufficient rig logs a warning and
 * prediction continues. It never silently pads missing channels.
 */

export class HardwareInsufficiencyWarning extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HardwareInsufficiencyWarning";
  }
}

const FEATURES_PER_CHANNEL = 28;
const GLOBAL_FEATURES = 4;

export function effectiveDims(nChannels: number): number {
  const n = Math.trunc(nChannels);
  if (n <= 1) return 0.5;
  if (n === 2) return 1.0;
  if (n === 3) return 1.5;
  if (n === 4) return 2.0;
  return 2.5;
}

/** Channel count implied by a canonical framework feature count
 * (`28c + c(c−1)/2 + 4 = n`), else undefined for hand-crafted feature sets. */
export function impliedChannels(nFeatures: number): number | undefined {
  if (!Number.isInteger(nFeatures) || nFeatures < 32) return undefined;
  const disc = 55 * 55 + 4 * (2 * nFeatures - 8);
  let root = Math.floor(Math.sqrt(disc));
  while (root * root > disc) root -= 1;
  while ((root + 1) * (root + 1) <= disc) root += 1;
  if (root * root !== disc) return undefined;
  const c = (-55 + root) / 2;
  if (c < 1 || !Number.isInteger(c)) return undefined;
  if (FEATURES_PER_CHANNEL * c + (c * (c - 1)) / 2 + GLOBAL_FEATURES !== nFeatures) return undefined;
  return c;
}

/** Number of singular directions of X explaining `variance` of energy.
 * Used to size `minEffectiveDimensions` for non-canonical feature sets. */
export function effectiveRank(X: number[][], variance = 0.95): number {
  if (!Array.isArray(X) || X.length < 2) return 1.0;
  const m = X.length;
  const n = X[0]!.length;
  if (n === 0) return 1.0;

  const centered = X.map((row) => [...row]);
  for (let j = 0; j < n; j++) {
    let sum = 0;
    for (let i = 0; i < m; i++) sum += centered[i]![j]!;
    const avg = sum / m;
    for (let i = 0; i < m; i++) centered[i]![j] = centered[i]![j]! - avg;
  }

  const gram = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let r = 0; r < m; r++) s += centered[r]![i]! * centered[r]![j]!;
      gram[i]![j] = s;
      gram[j]![i] = s;
    }
  }

  const eig = jacobiEigenvalues(gram).map((e) => Math.max(0, e)).sort((a, b) => b - a);
  const s2 = eig.map((e) => Math.sqrt(e) ** 2);
  const total = s2.reduce((a, b) => a + b, 0);
  if (total <= 0) return 1.0;
  let cum = 0;
  for (let k = 0; k < s2.length; k++) {
    cum += s2[k]! / total;
    if (cum >= variance) return k + 1;
  }
  return s2.length;
}

/** Symmetric real eigenvalues via cyclic Jacobi rotations. */
function jacobiEigenvalues(a: number[][]): number[] {
  const n = a.length;
  const A = a.map((r) => [...r]);
  const maxIter = 100 * n * n;
  for (let iter = 0; iter < maxIter; iter++) {
    let p = 0;
    let q = 1;
    let max = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const v = Math.abs(A[i]![j]!);
        if (v > max) {
          max = v;
          p = i;
          q = j;
        }
      }
    }
    if (max < 1e-14) break;
    const app = A[p]![p]!;
    const aqq = A[q]![q]!;
    const apq = A[p]![q]!;
    const tau = (aqq - app) / (2 * apq);
    const t = Math.sign(tau) / (Math.abs(tau) + Math.sqrt(tau * tau + 1));
    const c = 1 / Math.sqrt(t * t + 1);
    const s = t * c;
    const c2 = c * c;
    const s2 = s * s;
    const cs = c * s;
    A[p]![p] = c2 * app - 2 * cs * apq + s2 * aqq;
    A[q]![q] = s2 * app + 2 * cs * apq + c2 * aqq;
    A[p]![q] = 0;
    A[q]![p] = 0;
    for (let k = 0; k < n; k++) {
      if (k === p || k === q) continue;
      const akp = A[k]![p]!;
      const akq = A[k]![q]!;
      A[k]![p] = c * akp - s * akq;
      A[k]![q] = s * akp + c * akq;
      A[p]![k] = A[k]![p]!;
      A[q]![k] = A[k]![q]!;
    }
  }
  return Array.from({ length: n }, (_, i) => A[i]![i]!);
}

type ModelLike = {
  min_effective_dimensions?: number | undefined;
  minEffectiveDimensions?: number | undefined;
  n_features_in_?: number | undefined;
  nFeaturesIn?: number | undefined;
  namedSteps?: Record<string, unknown> | undefined;
  named_steps?: Record<string, unknown> | undefined;
  n_classes_?: number | undefined;
  nClasses?: number | undefined;
};

/** Minimum effective dimensions the model requires to transfer.
 * Resolution: stored `min_effective_dimensions`, then the dims implied by the
 * canonical feature count the model was fitted on, then `max(1, log2(k))`
 * capped at the ~4-dim SmellNet latent budget. */
export function minEffectiveDimensions(model: ModelLike | undefined | null): number {
  const stored = model?.min_effective_dimensions ?? model?.minEffectiveDimensions;
  if (stored !== undefined) return Number(stored);

  const nFeatures = model?.n_features_in_ ?? model?.nFeaturesIn;
  if (nFeatures !== undefined) {
    const c = impliedChannels(Number(nFeatures));
    if (c !== undefined) return effectiveDims(c);
  }

  const clf = (model?.namedSteps?.clf ?? model?.named_steps?.clf ?? model) as ModelLike | undefined;
  const nClasses = clf?.n_classes_ ?? clf?.nClasses;
  if (nClasses === undefined) return 1.0;
  return Math.min(4.0, Math.max(1.0, Math.log2(Number(nClasses))));
}

/** Warn-and-Proceed hardware gate (§10.10 N→M limit). Always proceeds. */
export function checkRigSufficiency(nChannels: number, model: ModelLike | undefined | null, warn = true): boolean {
  const available = effectiveDims(nChannels);
  const required = minEffectiveDimensions(model);
  if (available >= required) return true;
  if (warn) {
    console.warn(
      `HardwareInsufficiencyWarning: rig has ${Math.trunc(nChannels)} channel(s) ` +
        `(≈${available.toPrecision(2)} effective dims) but the model requires ≈${required.toPrecision(2)} ` +
        `effective dims. Zero-shot feature transfer needs ` +
        `min_effective_dimensions <= effective_dims(rig) (§10.10). Prediction ` +
        `proceeds unsupported; do not pad missing channels with training-set means.`,
    );
  }
  return true;
}