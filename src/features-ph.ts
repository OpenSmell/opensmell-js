// Per-type feature extractors for pH/ISFET sensors.
// Signal domain: pH (bounded 0-14). Baseline: calibration point (typically pH 7).
// Normalized: pH - pH0.
import {
  DEFAULT_R0_SAMPLES,
  OsmellFile,
} from "./types.js";
import { mean, std } from "./normalize.js";

export interface PhFeature {
  channel: string;
  sensorType: string;
  deltaPh: number; // pH - pH0 peak
  direction: number; // 1 = increasing pH, -1 = decreasing
  responseTimeMs?: number; // time to reach 90% of peak shift
  decayTimeMs?: number; // time to return to 10% of peak shift
  auc: number; // area under ΔpH curve (pH·s)
  baselinePh: number; // baseline pH
  dead: boolean;
  endpointDelta: number; // final - baseline
  saturationIndex: number; // 0-1 out of range (0-14)
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

function outOfRangeIndexFor(
  values: number[],
): number {
  if (values.length === 0) return 0;
  let outOfRange = 0;
  for (const v of values) {
    if (v < 0 || v > 14) outOfRange++;
  }
  return outOfRange / values.length;
}

export function extractPhFeatures(
  file: OsmellFile,
  baselinePh: Record<string, number>,
): {
  sensorType: string;
  features: PhFeature[];
  normalized: Record<string, number[]>;
} {
  const channels = file.manifest.sensor.channels;
  const features: PhFeature[] = [];
  const normalized: Record<string, number[]> = {};

  for (const ch of channels) {
    const cid = ch.id;
    const values = file.data[cid] ?? [];
    const ph0 = baselinePh[cid] ?? 7;

    const deltaPh = values.map((v) => v - ph0);
    const finiteDelta = deltaPh.filter((v) => Number.isFinite(v));

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
      const t10 = firstCrossTime(file.time, deltaPh, minVal + 0.1 * span);
      const t90 = firstCrossTime(file.time, deltaPh, minVal + 0.9 * span);
      if (t10 !== undefined && t90 !== undefined) riseTimeMs = t90 - t10;

      let prev = deltaPh[0]!;
      for (let i = 1; i < deltaPh.length; i++) {
        const dt = file.time[i]! - file.time[i - 1]!;
        if (dt > 0) auc += (deltaPh[i]! + prev) * dt * 0.5;
        prev = deltaPh[i]!;
      }

      const peakIdx = argmaxAbs(deltaPh);
      decayTimeMs = decayTimeMsAfter(deltaPh, file.time, peakIdx);
      endpointDelta = deltaPh[deltaPh.length - 1]!;
      saturationIndex = outOfRangeIndexFor(values);
    }

    normalized[cid] = deltaPh;
    features.push({
      channel: cid,
      sensorType: ch.sensorType ?? "unknown",
      deltaPh: relativeAmplitude,
      direction,
      responseTimeMs: riseTimeMs,
      decayTimeMs,
      auc,
      baselinePh: ph0,
      dead: stats.dead,
      endpointDelta,
      saturationIndex,
    });
  }

  return { sensorType: "ph", features, normalized };
}
