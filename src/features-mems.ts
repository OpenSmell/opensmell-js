// Per-type feature extractors for MEMS sensors (BME688, SGP40, CCS811, etc.).
// Signal domain: index (factory calibrated, opaque). Baseline: index at clean air.
// Normalized: index - index0.
import {
  DEFAULT_R0_SAMPLES,
  OsmellFile,
} from "./types.js";
import { mean, std } from "./normalize.js";

export interface MemsFeature {
  channel: string;
  sensorType: string;
  deltaIndex: number; // index - index0 peak
  direction: number; // 1 = increasing index, -1 = decreasing
  responseTimeMs?: number; // time to reach 90% of peak shift
  decayTimeMs?: number; // time to return to 10% of peak shift
  auc: number; // area under Δindex curve (index·s)
  baselineIndex: number; // baseline index
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
  baselineIndex: number,
): number {
  if (values.length < 5) return 0;
  const tolerance = Math.abs(baselineIndex) * 0.001; // 0.1% = flat
  let flatCount = 0;
  for (const v of values) {
    if (Math.abs(v - baselineIndex) < tolerance) flatCount++;
  }
  return flatCount / values.length;
}

export function extractMemsFeatures(
  file: OsmellFile,
  baselineIndex: Record<string, number>,
): {
  sensorType: string;
  features: MemsFeature[];
  normalized: Record<string, number[]>;
} {
  const channels = file.manifest.sensor.channels;
  const features: MemsFeature[] = [];
  const normalized: Record<string, number[]> = {};

  for (const ch of channels) {
    const cid = ch.id;
    const values = file.data[cid] ?? [];
    const i0 = baselineIndex[cid] ?? 0;

    const deltaIndex = values.map((v) => v - i0);
    const finiteDelta = deltaIndex.filter((v) => Number.isFinite(v));

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
      const t10 = firstCrossTime(file.time, deltaIndex, minVal + 0.1 * span);
      const t90 = firstCrossTime(file.time, deltaIndex, minVal + 0.9 * span);
      if (t10 !== undefined && t90 !== undefined) riseTimeMs = t90 - t10;

      let prev = deltaIndex[0]!;
      for (let i = 1; i < deltaIndex.length; i++) {
        const dt = file.time[i]! - file.time[i - 1]!;
        if (dt > 0) auc += (deltaIndex[i]! + prev) * dt * 0.5;
        prev = deltaIndex[i]!;
      }

      const peakIdx = argmaxAbs(deltaIndex);
      decayTimeMs = decayTimeMsAfter(deltaIndex, file.time, peakIdx);
      endpointDelta = deltaIndex[deltaIndex.length - 1]!;
      saturationIndex = flatlineIndexFor(values, i0);
    }

    normalized[cid] = deltaIndex;
    features.push({
      channel: cid,
      sensorType: ch.sensorType ?? "unknown",
      deltaIndex: relativeAmplitude,
      direction,
      responseTimeMs: riseTimeMs,
      decayTimeMs,
      auc,
      baselineIndex: i0,
      dead: stats.dead,
      endpointDelta,
      saturationIndex,
    });
  }

  return { sensorType: "mems", features, normalized };
}
