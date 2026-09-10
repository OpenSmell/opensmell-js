import { std, isFiniteNumber } from "./normalize.js";
import { DEFAULT_R0_SAMPLES } from "./types.js";

export const N_CHANNELS = 6;

/** Composite trapezoidal rule (numpy trapz equivalent). */
export function trapz(y: number[], x?: number[]): number {
  let sum = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const dx = x ? x[i + 1]! - x[i]! : 1;
    sum += (y[i]! + y[i + 1]!) * 0.5 * dx;
  }
  return sum;
}

export const NOMINAL_CALIBRATION: [number, number] = [1.0, -0.5];

function medianOf(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function r0FromContract(series: number[], r0Samples: number, r0?: number): number {
  const finite = series.filter(Number.isFinite);
  let r0v = r0;
  if (r0v === undefined) {
    const window = r0Samples ? finite.slice(0, r0Samples) : finite;
    r0v = window.length ? medianOf(window) : 0;
  }
  if (!Number.isFinite(r0v) || r0v <= 0) {
    const positive = finite.filter((v) => v > 0);
    r0v = positive.length ? positive.reduce((a, b) => a + b, 0) / positive.length : 1;
  }
  return r0v > 0 ? r0v : 1;
}

function expDecay(t: number[], a: number, tau: number, c: number): number[] {
  return t.map((x) => a * Math.exp(-x / tau) + c);
}

function biExpDecay(t: number[], a1: number, tau1: number, a2: number, tau2: number, c: number): number[] {
  return t.map((x) => a1 * Math.exp(-x / tau1) + a2 * Math.exp(-x / tau2) + c);
}

function triExpDecay(
  t: number[],
  a1: number, tau1: number,
  a2: number, tau2: number,
  a3: number, tau3: number,
  c: number,
): number[] {
  return t.map(
    (x) => a1 * Math.exp(-x / tau1) + a2 * Math.exp(-x / tau2) + a3 * Math.exp(-x / tau3) + c,
  );
}

export function computeChannelDeviceAgnostic(
  series: number[],
  r0Samples = 15,
  sr = 10,
  r0?: number,
): Record<string, number | number[] | boolean> {
  if (series.length < r0Samples + 2) {
    return {
      relative_amplitude: -1,
      direction: 0,
      rise_time: -1,
      decay_time: -1,
      auc: -1,
      endpoint_delta: -1,
    };
  }
  const R0 = r0FromContract(series, r0Samples, r0);

  const finite = series.filter(Number.isFinite);
  const stdRatio = finite.length ? std(finite) / R0 : Infinity;
  const dead = finite.length < 2 || stdRatio < 0.001;
  if (dead) {
    return {
      relative_amplitude: 0,
      direction: 0,
      rise_time: -1,
      decay_time: -1,
      auc: 0,
      endpoint_delta: 0,
      R0,
      is_dead: true,
      std_ratio: stdRatio,
    };
  }

  const norm = series.map((v) => (v - R0) / R0);
  const maxVal = Math.max(...series);
  const minVal = Math.min(...series);
  const deltaMax = maxVal - R0;
  const deltaMin = minVal - R0;
  let peakRaw: number;
  let deltaRaw: number;
  let direction: number;
  if (Math.abs(deltaMax) >= Math.abs(deltaMin)) {
    peakRaw = maxVal;
    deltaRaw = deltaMax;
    direction = 1;
  } else {
    peakRaw = minVal;
    deltaRaw = deltaMin;
    direction = -1;
  }

  const relativeAmplitude = Math.abs(deltaRaw) / R0;
  const fullSpan = Math.abs(deltaRaw);

  let threshold10 = R0 + 0.1 * fullSpan * direction;
  let threshold90 = R0 + 0.9 * fullSpan * direction;
  threshold10 = Math.min(Math.max(threshold10, minVal), maxVal);
  threshold90 = Math.min(Math.max(threshold90, minVal), maxVal);

  function firstCross(arr: number[], thresh: number, dir: number): number | undefined {
    let idx: number[] = [];
    if (dir > 0) {
      for (let i = 0; i < arr.length; i++) if (arr[i]! >= thresh) idx.push(i);
    } else {
      for (let i = 0; i < arr.length; i++) if (arr[i]! <= thresh) idx.push(i);
    }
    if (idx.length === 0 || idx[0]! >= arr.length - 1) return undefined;
    return idx[0];
  }

  let riseTime = -1;
  const idx10 = firstCross(series, threshold10, direction);
  const idx90 = firstCross(series, threshold90, direction);
  if (idx10 !== undefined && idx90 !== undefined) riseTime = Math.abs(idx90 - idx10) / sr;

  let decayTime = -1;
  let peakIdx = 0;
  for (let i = 1; i < series.length; i++) {
    if (Math.abs(series[i]! - R0) > Math.abs(series[peakIdx]! - R0)) peakIdx = i;
  }
  const postPeak = series.slice(peakIdx);
  if (postPeak.length > 2) {
    const desorbDir = -direction;
    let condStart: boolean[];
    let condEnd: boolean[];
    if (desorbDir > 0) {
      condStart = postPeak.map((v) => v >= threshold90);
      condEnd = postPeak.map((v) => v >= threshold10);
    } else {
      condStart = postPeak.map((v) => v <= threshold90);
      condEnd = postPeak.map((v) => v <= threshold10);
    }
    const startIdx = condStart.indexOf(true);
    if (startIdx >= 0) {
      for (let i = startIdx; i < condEnd.length; i++) {
        if (condEnd[i]) {
          decayTime = (startIdx + i) / sr;
          break;
        }
      }
    }
  }

  const auc = trapz(norm.map((v) => Math.abs(v)));
  const endpointDelta = (series[series.length - 1]! - R0) / R0;

  return {
    relative_amplitude: relativeAmplitude,
    direction,
    rise_time: riseTime,
    decay_time: decayTime,
    auc,
    endpoint_delta: endpointDelta,
    series_norm: norm,
    series_raw: series,
    R0,
    peak_idx: peakIdx,
    is_dead: dead,
    std_ratio: stdRatio,
  };
}

export function computeChannelAbsolute(
  series: number[],
  r0?: number,
  aConst = 1,
  bConst = -0.5,
): Record<string, number> {
  let r0v = r0;
  if (r0v === undefined || !(Number.isFinite(r0v) && r0v > 0)) r0v = r0FromContract(series, 15, r0);
  const tail = series.length >= 10 ? series.slice(-10) : series;
  const rawResistance = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
  const baselineResistance = r0v;
  const voltage = rawResistance;
  const rrRatio = r0v > 0 ? rawResistance / r0v : 0;
  let calibConc = 0;
  if (bConst !== 0 && rrRatio > 0) {
    calibConc = Math.pow(rrRatio / Math.max(aConst, 0.001), 1 / bConst);
  }
  return {
    raw_resistance: rawResistance,
    baseline_resistance: baselineResistance,
    voltage,
    calibrated_concentration: calibConc,
  };
}

function detrend(series: number[]): number[] {
  const n = series.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += series[i]!;
    sxx += i * i;
    sxy += i * series[i]!;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  return series.map((v, i) => v - (intercept + slope * i));
}

function nextFastLen(n: number): number {
  let x = n;
  while (true) {
    let m = x;
    for (const p of [2, 3, 5, 7]) while (m % p === 0) m /= p;
    if (m === 1) return x;
    x += 1;
  }
}

/** scipy.signal.periodogram (boxcar window, rfft half-spectrum, 1/(fs·N) scaling). */
export function periodogram(series: number[], fs: number): { freqs: number[]; psd: number[] } {
  const n = series.length;
  const nfft = nextFastLen(n);
  const half = Math.floor(nfft / 2) + 1;
  const freqs: number[] = [];
  const psd: number[] = [];
  for (let k = 0; k < half; k++) {
    let re = 0, im = 0;
    const phaseK = (-2 * Math.PI * k) / nfft;
    for (let t = 0; t < n; t++) {
      const ang = phaseK * t;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      re += series[t]! * cos;
      im += series[t]! * sin;
    }
    const power = (re * re + im * im) / (fs * n);
    freqs.push((k * fs) / nfft);
    psd.push(power);
  }
  return { freqs, psd };
}

export function computeChannelTemporal(series: number[], sr = 10): Record<string, number> {
  if (series.length < 5) {
    return { hf_transient: 0, oscillation_freq: 0, oscillation_amp: 0, response_latency: -1 };
  }

  const diffs: number[] = [];
  for (let i = 1; i < series.length; i++) diffs.push(Math.abs(series[i]! - series[i - 1]!));
  const hfTransient = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0;

  const detrended = detrend(series);
  let oscFreq = 0, oscAmp = 0;
  if (detrended.length > 20) {
    const { freqs, psd } = periodogram(detrended, sr);
    let peakIdx = 0;
    for (let k = 1; k < psd.length; k++) if (psd[k]! > psd[peakIdx]!) peakIdx = k;
    if (peakIdx > 0) {
      oscFreq = freqs[peakIdx]!;
      oscAmp = Math.sqrt(psd[peakIdx]!);
    }
  }

  let responseLatency = -1;
  const first10 = series.slice(0, 10);
  const threshold = first10.length === 10 ? std(first10) * 3 : std(series) * 3;
  const baselineMean = first10.length === 10
    ? first10.reduce((a, b) => a + b, 0) / first10.length
    : series[0]!;
  for (let i = 10; i < series.length; i++) {
    if (Math.abs(series[i]! - baselineMean) > threshold) {
      responseLatency = i / sr;
      break;
    }
  }

  return {
    hf_transient: hfTransient,
    oscillation_freq: oscFreq,
    oscillation_amp: oscAmp,
    response_latency: responseLatency,
  };
}

export function computeChannelHealth(series: number[], r0Samples = 15, r0?: number): Record<string, number> {
  if (series.length < r0Samples + 5) {
    return { drift_rate: 0, sensitivity_decay: 0, noise_floor: 0, hysteresis: 0 };
  }
  const r0v = r0FromContract(series, r0Samples, r0);

  const last10 = series.slice(-10);
  const driftRate = last10.length >= 10
    ? (last10.reduce((a, b) => a + b, 0) / last10.length - r0v) / r0v
    : 0;
  const noiseFloor = r0v > 0 ? std(series.slice(0, r0Samples)) / r0v : 0;

  let peakIdx = 0;
  for (let i = 1; i < series.length; i++) {
    if (Math.abs(series[i]! - r0v) > Math.abs(series[peakIdx]! - r0v)) peakIdx = i;
  }

  let hysteresis = 0;
  if (peakIdx < series.length - 5 && peakIdx > 5) {
    const adsCurve = series.slice(0, peakIdx + 1);
    const desCurve = series.slice(peakIdx);
    const adsPath = trapz(adsCurve.map((v) => Math.abs(v - r0v)));
    const desPath = trapz(desCurve.map((v) => Math.abs(v - r0v)));
    hysteresis = Math.abs(adsPath - desPath) / Math.max(adsPath, 1e-10);
  }

  return { drift_rate: driftRate, sensitivity_decay: 0, noise_floor: noiseFloor, hysteresis };
}

// --- Levenberg-Marquardt (scipy.optimize.curve_fit / MINPACK analog) ---

interface FittedParams {
  p: number[];
  cost: number;
}

function curveFit(
  model: (t: number[], p: number[]) => number[],
  t: number[],
  y: number[],
  p0: number[],
  maxFev = 2000,
): FittedParams {
  let p = [...p0];
  const n = t.length;
  const m = p.length;
  let lambda = 1e-3;
  let cost = residualCost(model(t, p), y, n);

  const jacobian = (atP: number[]): number[][] => {
    const j: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row = new Array<number>(m).fill(0);
      for (let k = 0; k < m; k++) {
        const h = 1e-7 * Math.max(1, Math.abs(atP[k]!));
        const pp = [...atP];
        pp[k] = atP[k]! + h;
        const pm = [...atP];
        pm[k] = atP[k]! - h;
        const fp = model(t, pp);
        const fm = model(t, pm);
        row[k] = (fp[i]! - fm[i]!) / (2 * h);
      }
      j.push(row);
    }
    return j;
  };

  let iterations = 0;
  while (iterations < maxFev) {
    const r = model(t, p).map((v, i) => v - y[i]!);
    const j = jacobian(p);
    const jtJ: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
    const jtR: number[] = new Array<number>(m).fill(0);
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < m; a++) {
        jtR[a]! += j[i]![a]! * r[i]!;
        for (let b = 0; b < m; b++) jtJ[a]![b]! += j[i]![a]! * j[i]![b]!;
      }
    }
    const diag = jtJ.map((row) => row[indexOfDiag(row)]);
    const a: number[][] = jtJ.map((row, i) => row.map((v, k) => (i === k ? v + lambda * diag[i]! : v)));
    const delta = solveLinear(a, jtR);
    if (!delta) break;

    const pNew = p.map((v, i) => v + delta[i]!);
    const costNew = residualCost(model(t, pNew), y, n);
    iterations++;
    if (Number.isNaN(costNew) || costNew >= cost) {
      lambda *= 10;
      if (lambda > 1e12) break;
      continue;
    }
    lambda = Math.max(lambda / 10, 1e-8);
    p = pNew;
    cost = costNew;
    const step = delta.reduce((acc, d) => acc + Math.abs(d), 0);
    if (step < 1e-8) break;
  }
  return { p, cost };
}

function indexOfDiag(row: number[]): number {
  return row.findIndex((v) => v !== 0);
}

function solveLinear(a: number[][], b: number[]): number[] | undefined {
  const n = a.length;
  const aug = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row]![col]!) > Math.abs(aug[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(aug[pivot]![col]!) < 1e-300) return undefined;
    [aug[col], aug[pivot]] = [aug[pivot]!, aug[col]!];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row]![col]! / aug[col]![col]!;
      for (let k = col; k < n + 1; k++) aug[row]![k]! -= factor * aug[col]![k]!;
    }
  }
  return aug.map((row, i) => row[n]! / row[i]!);
}

function residualCost(fitted: number[], y: number[], n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = fitted[i]! - y[i]!;
    s += d * d;
  }
  return s;
}

export function computeMultiExpDecay(
  series: number[],
  peakIdx?: number,
  sr = 10,
  nComponents = 2,
  r0?: number,
): Record<string, number> {
  if (nComponents >= 3) nComponents = 3;

  if (series.length < 20) {
    return { tau1: -1, tau2: -1, tau3: -1, a1: -1, a2: -1, a3: -1, cost: -1 };
  }

  let pk = peakIdx;
  if (pk === undefined) {
    const r0Est = r0FromContract(series, Math.min(15, Math.floor(series.length / 3)), r0);
    let best = 0;
    for (let i = 1; i < series.length; i++) {
      if (Math.abs(series[i]! - r0Est) > Math.abs(series[best]! - r0Est)) best = i;
    }
    pk = best;
  }
  pk = Math.max(5, Math.min(pk, series.length - 10));

  const recovery = series.slice(pk);
  if (recovery.length < 10) {
    return { tau1: -1, tau2: -1, tau3: -1, a1: -1, a2: -1, a3: -1, cost: -1 };
  }

  const t = recovery.map((_, i) => i / sr);
  const y = recovery.map((v) => v - recovery[recovery.length - 1]!);
  if (y.length !== t.length) return { tau1: -1, tau2: -1, tau3: -1, a1: -1, a2: -1, a3: -1, cost: -1 };
  if (y.every((v) => v === 0) || std(y) < 1e-8) {
    return { tau1: -1, tau2: -1, tau3: -1, a1: -1, a2: -1, a3: -1, cost: -1 };
  }

  const a0 = y[0]!;
  const results: Record<string, number> = {
    tau1: -1, tau2: -1, tau3: -1, a1: -1, a2: -1, a3: -1, cost: -1,
  };

  try {
    const fit = curveFit(
      (tt, pp) => expDecay(tt, pp[0]!, pp[1]!, pp[2]!),
      t, y, [a0, 3, 0], 2000,
    );
    results.tau1 = Math.abs(fit.p[1]!);
    results.a1 = fit.p[0]!;
    results.cost = fit.cost;
  } catch {
    /* pass */
  }

  try {
    const fit = curveFit(
      (tt, pp) => biExpDecay(tt, pp[0]!, pp[1]!, pp[2]!, pp[3]!, pp[4]!),
      t, y, [a0 * 0.7, 2, a0 * 0.3, 10, 0], 5000,
    );
    results.tau1 = Math.abs(fit.p[1]!);
    results.tau2 = Math.abs(fit.p[3]!);
    results.a1 = fit.p[0]!;
    results.a2 = fit.p[2]!;
    results.cost = fit.cost;
  } catch {
    /* pass */
  }

  if (nComponents === 3 && recovery.length >= 30) {
    try {
      const fit = curveFit(
        (tt, pp) => triExpDecay(tt, pp[0]!, pp[1]!, pp[2]!, pp[3]!, pp[4]!, pp[5]!, pp[6]!),
        t, y, [a0 * 0.5, 1.5, a0 * 0.3, 5, a0 * 0.2, 20, 0], 10000,
      );
      results.tau1 = Math.abs(fit.p[1]!);
      results.tau2 = Math.abs(fit.p[3]!);
      results.tau3 = Math.abs(fit.p[5]!);
      results.a1 = fit.p[0]!;
      results.a2 = fit.p[2]!;
      results.a3 = fit.p[4]!;
      results.cost = fit.cost;
    } catch {
      /* pass */
    }
  }

  return results;
}

export function computeSaturationIndex(series: number[], r0Samples = 15, r0?: number): number {
  if (series.length < r0Samples + 5) return 0;
  const R0 = r0FromContract(series, r0Samples, r0);

  const norm = series.map((v) => Math.abs(v - R0) / R0);
  const currentResponse = Math.max(...norm);
  const noiseFloor = std(norm.slice(0, r0Samples));

  if (currentResponse < noiseFloor * 2) return 0;
  const denom = currentResponse + noiseFloor * 10;
  return denom > 0 ? Math.min(1, currentResponse / denom) : 0;
}

export function computeChannelHardware(series: number[]): Record<string, number> {
  if (series.length < 2) {
    return { circuit_response: 0, thermal_profile: 0, adc_noise: 0 };
  }
  const circuitResponse = series.reduce((a, b) => a + b, 0) / series.length;
  const thermalProfile = std(series);

  let adcNoise = 0;
  if (series.length >= 10) {
    const smooth: number[] = [];
    for (let i = 0; i <= series.length - 5; i++) {
      smooth.push((series[i]! + series[i + 1]! + series[i + 2]! + series[i + 3]! + series[i + 4]!) / 5);
    }
    const residuals: number[] = [];
    for (let i = 0; i < smooth.length; i++) {
      residuals.push(series[i + 2]! - smooth[i]!);
    }
    adcNoise = residuals.length ? std(residuals) : 0;
  }

  return { circuit_response: circuitResponse, thermal_profile: thermalProfile, adc_noise: adcNoise };
}

export type FrameworkFeatures = Record<string, number | number[] | boolean>;

export function extractAllFrameworkFeatures(
  data: number[][],
  r0Samples = 15,
  sr = 10,
  r0PerChannel?: Record<number, number>,
  calibration?: Record<number, { a: number; b: number }>,
): FrameworkFeatures {
  const nCh = data[0]?.length ?? 0;
  const features: FrameworkFeatures = {};

  const deviceAgnostic: Array<Record<string, number | number[] | boolean>> = [];
  const absolute: Array<Record<string, number>> = [];
  const temporal: Array<Record<string, number>> = [];
  const health: Array<Record<string, number>> = [];
  const hardware: Array<Record<string, number>> = [];
  const decays: Array<Record<string, number>> = [];

  for (let ch = 0; ch < nCh; ch++) {
    const series = data.map((row) => row[ch]!);

    const R0 = r0FromContract(series, r0Samples, r0PerChannel?.[ch]);
    const da = computeChannelDeviceAgnostic(series, r0Samples, sr, R0);
    deviceAgnostic.push(da);
    const R0effective = typeof da["R0"] === "number" ? (da["R0"] as number) : R0;

    let aC = NOMINAL_CALIBRATION[0];
    let bC = NOMINAL_CALIBRATION[1];
    const cal = calibration?.[ch];
    if (cal) {
      aC = cal.a;
      bC = cal.b;
    }
    const ab = computeChannelAbsolute(series, R0effective, aC, bC);
    absolute.push(ab);

    const te = computeChannelTemporal(series, sr);
    temporal.push(te);

    const he = computeChannelHealth(series, r0Samples, R0effective);
    health.push(he);

    const ha = computeChannelHardware(series);
    hardware.push(ha);

    const pk = typeof da["peak_idx"] === "number" ? (da["peak_idx"] as number) : Math.floor(series.length / 2);
    const dec = computeMultiExpDecay(series, pk, sr, 2, R0effective);
    decays.push(dec);

    const sat = computeSaturationIndex(series, r0Samples, R0effective);
    features[`ch${ch}_advanced_saturation_index`] = sat;

    for (const featName of ["relative_amplitude", "direction", "rise_time", "decay_time", "auc", "endpoint_delta"]) {
      features[`ch${ch}_da_${featName}`] = getNum(da, featName) ?? -1;
    }
    for (const featName of ["raw_resistance", "baseline_resistance", "voltage", "calibrated_concentration"]) {
      features[`ch${ch}_abs_${featName}`] = getNum(ab, featName) ?? 0;
    }
    for (const featName of ["hf_transient", "oscillation_freq", "oscillation_amp", "response_latency"]) {
      features[`ch${ch}_temp_${featName}`] = getNum(te, featName) ?? 0;
    }
    for (const featName of ["drift_rate", "sensitivity_decay", "noise_floor", "hysteresis"]) {
      features[`ch${ch}_health_${featName}`] = getNum(he, featName) ?? 0;
    }
    for (const featName of ["circuit_response", "thermal_profile", "adc_noise"]) {
      features[`ch${ch}_hw_${featName}`] = getNum(ha, featName) ?? 0;
    }
    for (const featName of ["tau1", "tau2", "tau3", "a1", "a2", "a3"]) {
      features[`ch${ch}_decay_${featName}`] = getNum(dec, featName) ?? -1;
    }
  }

  const active = deviceAgnostic
    .map((r, i) => ({ i, r }))
    .filter(({ r }) => !(r["is_dead"] === true) && getNum(r, "relative_amplitude")! > 0)
    .map(({ i }) => i);

  for (let a = 0; a < active.length; a++) {
    for (let b = a + 1; b < active.length; b++) {
      const ci = active[a]!;
      const cj = active[b]!;
      const drI = getNum(deviceAgnostic[ci]!, "relative_amplitude") ?? 0;
      const drJ = getNum(deviceAgnostic[cj]!, "relative_amplitude") ?? 0;
      const ratio = drJ > 0 ? drI / drJ : 0;
      features[`sel_ratio_ch${ci}_ch${cj}`] = ratio;
    }
  }

  for (let chI = 0; chI < nCh; chI++) {
    for (let chJ = chI + 1; chJ < nCh; chJ++) {
      const key = `sel_ratio_ch${chI}_ch${chJ}`;
      if (!(key in features)) features[key] = 0;
    }
  }

  const activeDr = deviceAgnostic
    .map((r, i) => ({ i, r }))
    .filter(({ r }) => !(r["is_dead"] === true))
    .map(({ i }) => getNum(deviceAgnostic[i]!, "relative_amplitude") ?? 0);

  features["global_max_delta_ratio"] = activeDr.length ? Math.max(...activeDr) : 0;
  features["global_mean_delta_ratio"] = activeDr.length
    ? activeDr.reduce((a, b) => a + b, 0) / activeDr.length
    : 0;
  features["global_n_active_channels"] = activeDr.length;
  features["global_total_auc"] = deviceAgnostic
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !(r["is_dead"] === true))
    .reduce((acc, { i }) => acc + (getNum(deviceAgnostic[i]!, "auc") ?? 0), 0);

  return features;
}

function getNum(record: Record<string, number | number[] | boolean>, key: string): number | undefined {
  const v = record[key];
  return typeof v === "number" ? v : undefined;
}

export function featureNames(nChannels?: number): string[] {
  const nCh = N_CHANNELS === nChannels ? nChannels : (nChannels ?? N_CHANNELS);
  if (nCh < 1) return [];
  const names: string[] = [];
  for (let ch = 0; ch < nCh; ch++) {
    for (const fn of ["relative_amplitude", "direction", "rise_time", "decay_time", "auc", "endpoint_delta"]) {
      names.push(`ch${ch}_da_${fn}`);
    }
  }
  for (let ch = 0; ch < nCh; ch++) {
    for (const fn of ["raw_resistance", "baseline_resistance", "voltage", "calibrated_concentration"]) {
      names.push(`ch${ch}_abs_${fn}`);
    }
  }
  for (let ch = 0; ch < nCh; ch++) {
    for (const fn of ["hf_transient", "oscillation_freq", "oscillation_amp", "response_latency"]) {
      names.push(`ch${ch}_temp_${fn}`);
    }
  }
  for (let ch = 0; ch < nCh; ch++) {
    for (const fn of ["drift_rate", "sensitivity_decay", "noise_floor", "hysteresis"]) {
      names.push(`ch${ch}_health_${fn}`);
    }
  }
  for (let ch = 0; ch < nCh; ch++) {
    for (const fn of ["circuit_response", "thermal_profile", "adc_noise"]) {
      names.push(`ch${ch}_hw_${fn}`);
    }
  }
  for (let ch = 0; ch < nCh; ch++) {
    names.push(`ch${ch}_advanced_saturation_index`);
    for (const fn of ["tau1", "tau2", "tau3", "a1", "a2", "a3"]) {
      names.push(`ch${ch}_decay_${fn}`);
    }
  }
  for (let chI = 0; chI < nCh; chI++) {
    for (let chJ = chI + 1; chJ < nCh; chJ++) names.push(`sel_ratio_ch${chI}_ch${chJ}`);
  }
  names.push("global_max_delta_ratio", "global_mean_delta_ratio", "global_n_active_channels", "global_total_auc");
  return names;
}

export function frameworkFeatureLen(nChannels: number): number {
  return 28 * nChannels + (nChannels * (nChannels - 1)) / 2 + 4;
}