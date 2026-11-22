// Per-type feature extractors for frequency sensors (QCM, SAW, Cantilever).
// Signal domain: frequency (Hz). Baseline: f0. Normalized: f - f0.
import {
  DEFAULT_R0_SAMPLES,
  OsmellFile,
} from "./types.js";
import { mean, std } from "./normalize.js";

export interface FrequencyFeature {
  channel: string;
  sensorType: string;
  deltaFrequency: number; // Δf = f - f0 peak
  direction: number; // 1 = increasing frequency, -1 = decreasing
  responseTimeMs?: number; // time to reach 90% of peak shift
  decayTimeMs?: number; // time to return to 10% of peak shift
  auc: number; // area under Δf curve (Hz·s)
  baselineFrequency: number; // f0
  dead: boolean;
  endpointDelta: number; // final - baseline
  saturationIndex: number; // 0-1 flatline detection
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

function flatlineIndexFor(
  values: number[],
  baselineFrequency: number,
): number {
  if (values.length < 5) return 0;
  const tolerance = Math.abs(baselineFrequency) * 0.0001; // 0.01% = flat
  let flatCount = 0;
  for (const v of values) {
    if (Math.abs(v - baselineFrequency) < tolerance) flatCount++;
  }
  return flatCount / values.length; // 0 = never flat, 1 = always flat
}

export function extractFrequencyFeatures(
  file: OsmellFile,
  baselineFrequencies: Record<string, number>,
): {
  sensorType: string;
  features: FrequencyFeature[];
  normalized: Record<string, number[]>;
} {
  const channels = file.manifest.sensor.channels;
  const features: FrequencyFeature[] = [];
  const normalized: Record<string, number[]> = {};

  for (const ch of channels) {
    const cid = ch.id;
    const values = file.data[cid] ?? [];
    const f0 = baselineFrequencies[cid] ?? 1e6;

    const deltaF = values.map((v) => v - f0);
    const finiteDelta = deltaF.filter((v) => Number.isFinite(v));

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
      const t10 = firstCrossTime(file.time, deltaF, minVal + 0.1 * span);
      const t90 = firstCrossTime(file.time, deltaF, minVal + 0.9 * span);
      if (t10 !== undefined && t90 !== undefined) riseTimeMs = t90 - t10;

      let prev = deltaF[0]!;
      for (let i = 1; i < deltaF.length; i++) {
        const dt = file.time[i]! - file.time[i - 1]!;
        if (dt > 0) auc += (deltaF[i]! + prev) * dt * 0.5;
        prev = deltaF[i]!;
      }

      const peakIdx = argmaxAbs(deltaF);
      decayTimeMs = decayTimeMsAfter(deltaF, file.time, peakIdx);
      endpointDelta = deltaF[deltaF.length - 1]!;
      saturationIndex = flatlineIndexFor(values, f0);
    }

    normalized[cid] = deltaF;
    features.push({
      channel: cid,
      sensorType: ch.sensorType ?? "unknown",
      deltaFrequency: relativeAmplitude,
      direction,
      responseTimeMs: riseTimeMs,
      decayTimeMs,
      auc,
      baselineFrequency: f0,
      dead: stats.dead,
      endpointDelta,
      saturationIndex,
    });
  }

  return { sensorType: "frequency", features, normalized };
}
