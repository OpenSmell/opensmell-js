// Per-type feature extractors for concentration sensors (NDIR, PID, Electrochemical, Galvanic).
// Signal domain: concentration (ppm/ppb). Baseline: zero or factory calibration value.
// Normalized: C - C0.
import {
  DEFAULT_R0_SAMPLES,
  OsmellFile,
} from "./types.js";
import { mean, std } from "./normalize.js";

export interface ConcentrationFeature {
  channel: string;
  sensorType: string;
  deltaFromBaseline: number; // C - C0 peak
  direction: number; // 1 = increasing, -1 = decreasing
  responseTimeMs?: number; // time to reach 90% of peak
  decayTimeMs?: number; // time to return to 10% of peak
  auc: number; // area under delta curve (ppm·s)
  baseline: number; // baseline concentration
  dead: boolean;
  endpointDelta: number; // final - baseline
  saturationIndex: number; // 0-1 saturation at sensor max
}

function firstCrossTime(
  time: number[],
  values: number[],
  threshold: number,
): number | undefined {
  for (let i = 0; i < values.length; i++) {
    if (values[i]! >= threshold) return time[i];
  }
  return undefined;
}

function argmaxAbs(values: number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i]!) > Math.abs(values[best]!)) best = i;
  }
  return best;
}

function decayTimeMsAfter(
  values: number[],
  time: number[],
  peakIdx: number,
): number | undefined {
  if (values.length - peakIdx <= 2) return undefined;
  const pk = values[peakIdx]!;
  if (!(pk === pk) || pk === 0) return undefined;
  const t90 = 0.9 * pk;
  const t10 = 0.1 * pk;
  const nearPeak = pk >= 0 ? (v: number) => v >= t90 : (v: number) => v <= t90;
  const nearBaseline = pk >= 0 ? (v: number) => v <= t10 : (v: number) => v >= t10;
  let si = -1;
  for (let i = peakIdx; i < values.length; i++) {
    if (nearPeak(values[i]!)) {
      si = i;
      break;
    }
  }
  if (si < 0) return undefined;
  for (let i = si; i < values.length; i++) {
    if (nearBaseline(values[i]!)) return time[i]! - time[peakIdx]!;
  }
  return undefined;
}

function saturationIndexFor(
  values: number[],
  baseline: number,
  maxConcentration: number,
): number {
  if (values.length < 5) return 0;
  let currentResponse = 0;
  for (const v of values) {
    const av = Math.abs(v - baseline);
    if (av > currentResponse) currentResponse = av;
  }
  const noiseFloor = std(values.slice(0, Math.min(values.length, 20))) || 1e-6;
  if (currentResponse < noiseFloor * 2) return 0;
  // Saturation: how close to sensor max range
  return Math.min(1, currentResponse / maxConcentration);
}

export function extractConcentrationFeatures(
  file: OsmellFile,
  baselineConcentrations: Record<string, number>,
  maxConcentrations: Record<string, number>,
): {
  sensorType: string;
  features: ConcentrationFeature[];
  normalized: Record<string, number[]>;
} {
  const channels = file.manifest.sensor.channels;
  const features: ConcentrationFeature[] = [];
  const normalized: Record<string, number[]> = {};

  for (const ch of channels) {
    const cid = ch.id;
    const values = file.data[cid] ?? [];
    const baseline = baselineConcentrations[cid] ?? 0;
    const maxC = maxConcentrations[cid] ?? 1000;

    const delta = values.map((v) => v - baseline);
    const finiteDelta = delta.filter((v) => Number.isFinite(v));

    let relativeAmplitude = 0;
    let direction = 1;
    let auc = 0;
    let riseTimeMs: number | undefined;
    let decayTimeMs: number | undefined;
    let endpointDelta = 0;
    let saturationIndex = 0;

    const stats = {
      min: Math.min(...finiteDelta),
      max: Math.max(...finiteDelta),
      dead: finiteDelta.length === 0,
    };

    if (!stats.dead && finiteDelta.length > 0) {
      let maxVal = finiteDelta[0]!;
      let minVal = finiteDelta[0]!;
      for (const v of finiteDelta) {
        if (v > maxVal) maxVal = v;
        if (v < minVal) minVal = v;
      }
      const peak = Math.abs(maxVal) >= Math.abs(minVal) ? maxVal : minVal;
      direction = peak >= 0 ? 1 : -1;
      relativeAmplitude = Math.abs(peak);

      const span = maxVal - minVal;
      const t10 = firstCrossTime(file.time, delta, minVal + 0.1 * span);
      const t90 = firstCrossTime(file.time, delta, minVal + 0.9 * span);
      if (t10 !== undefined && t90 !== undefined) riseTimeMs = t90 - t10;

      let prev = delta[0]!;
      for (let i = 1; i < delta.length; i++) {
        const dt = file.time[i]! - file.time[i - 1]!;
        if (dt > 0) auc += (delta[i]! + prev) * dt * 0.5;
        prev = delta[i]!;
      }

      const peakIdx = argmaxAbs(delta);
      decayTimeMs = decayTimeMsAfter(delta, file.time, peakIdx);
      endpointDelta = delta[delta.length - 1]!;
      saturationIndex = saturationIndexFor(values, baseline, maxC);
    }

    normalized[cid] = delta;
    features.push({
      channel: cid,
      sensorType: ch.sensorType ?? "unknown",
      deltaFromBaseline: relativeAmplitude,
      direction,
      responseTimeMs: riseTimeMs,
      decayTimeMs,
      auc,
      baseline,
      dead: stats.dead,
      endpointDelta,
      saturationIndex,
    });
  }

  return { sensorType: "concentration", features, normalized };
}
