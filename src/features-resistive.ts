// Per-type feature extractors for resistive sensors (MOX, Polymer, SolidElectrolyte).
// Signal domain: resistance (ohms). Baseline: R0. Normalized: (R - R0)/R0.
import {
  DEFAULT_R0_SAMPLES,
  OsmellFile,
} from "./types.js";
import { mean, std } from "./normalize.js";
import {
  baselineForChannel,
  normalizedSeries,
} from "./normalize-mox.js";

export interface ResistiveFeature {
  channel: string;
  sensorType: string;
  relativeAmplitude: number; // ΔR/R0 peak
  direction: number; // 1 = increasing, -1 = decreasing
  riseTimeMs?: number; // 10→90% rise time
  decayTimeMs?: number; // 90→10% decay time
  auc: number; // area under normalized curve
  r0: number; // baseline resistance
  dead: boolean;
  endpointDelta: number; // final - baseline
  saturationIndex: number; // 0-1 saturation
}

function firstCrossTime(
  time: number[],
  norm: number[],
  threshold: number,
): number | undefined {
  for (let i = 0; i < norm.length; i++) {
    if (norm[i]! >= threshold) return time[i];
  }
  return undefined;
}

function argmaxAbs(norm: number[]): number {
  let best = 0;
  for (let i = 1; i < norm.length; i++) {
    if (Math.abs(norm[i]!) > Math.abs(norm[best]!)) best = i;
  }
  return best;
}

function decayTimeMsAfter(
  norm: number[],
  time: number[],
  peakIdx: number,
): number | undefined {
  if (norm.length - peakIdx <= 2) return undefined;
  const pk = norm[peakIdx]!;
  if (!(pk === pk) || pk === 0) return undefined;
  const t90 = 0.9 * pk;
  const t10 = 0.1 * pk;
  const nearPeak = pk >= 0 ? (v: number) => v >= t90 : (v: number) => v <= t90;
  const nearBaseline = pk >= 0 ? (v: number) => v <= t10 : (v: number) => v >= t10;
  let si = -1;
  for (let i = peakIdx; i < norm.length; i++) {
    if (nearPeak(norm[i]!)) {
      si = i;
      break;
    }
  }
  if (si < 0) return undefined;
  for (let i = si; i < norm.length; i++) {
    if (nearBaseline(norm[i]!)) return time[i]! - time[peakIdx]!;
  }
  return undefined;
}

function saturationIndexFor(
  norm: number[],
  r0Samples?: number,
): number {
  const n = r0Samples ?? DEFAULT_R0_SAMPLES ?? 10;
  if (norm.length < n + 5) return 0;
  const r0Norm = norm.slice(0, n);
  let currentResponse = 0;
  for (const v of norm) {
    const av = Math.abs(v);
    if (av > currentResponse) currentResponse = av;
  }
  const noiseFloor = std(r0Norm);
  if (noiseFloor !== noiseFloor || currentResponse < noiseFloor * 2) return 0;
  return Math.min(1, currentResponse / (currentResponse + noiseFloor * 10));
}

export function extractResistiveFeatures(
  file: OsmellFile,
): {
  sensorType: string;
  features: ResistiveFeature[];
  normalized: Record<string, number[]>;
} {
  const channels = file.manifest.sensor.channels;
  const baseline = file.manifest.baseline;
  const declaredR0Samples = baseline?.r0Samples ?? DEFAULT_R0_SAMPLES;
  const features: ResistiveFeature[] = [];
  const normalized: Record<string, number[]> = {};

  for (const ch of channels) {
    const cid = ch.id;
    const values = file.data[cid] ?? [];
    const r0 = baselineForChannel(file, cid, values)[0];
    const norm = normalizedSeries(values, r0);

    const finiteNorm = norm.filter((v) => Number.isFinite(v));
    let relativeAmplitude = 0;
    let direction = 1;
    let auc = 0;
    let riseTimeMs: number | undefined;
    let decayTimeMs: number | undefined;
    let endpointDelta = 0;
    let saturationIndex = 0;

    const stats = {
      min: Math.min(...finiteNorm),
      max: Math.max(...finiteNorm),
      dead: finiteNorm.length === 0,
    };

    if (!stats.dead && finiteNorm.length > 0) {
      let maxVal = finiteNorm[0]!;
      let minVal = finiteNorm[0]!;
      for (const v of finiteNorm) {
        if (v > maxVal) maxVal = v;
        if (v < minVal) minVal = v;
      }
      const peak = Math.abs(maxVal) >= Math.abs(minVal) ? maxVal : minVal;
      direction = peak >= 0 ? 1 : -1;
      relativeAmplitude = Math.abs(peak);

      const span = maxVal - minVal;
      const t10 = firstCrossTime(file.time, norm, minVal + 0.1 * span);
      const t90 = firstCrossTime(file.time, norm, minVal + 0.9 * span);
      if (t10 !== undefined && t90 !== undefined) riseTimeMs = t90 - t10;

      let prev = norm[0]!;
      for (let i = 1; i < norm.length; i++) {
        const dt = file.time[i]! - file.time[i - 1]!;
        if (dt > 0) auc += (norm[i]! + prev) * dt * 0.5;
        prev = norm[i]!;
      }

      const peakIdx = argmaxAbs(norm);
      decayTimeMs = decayTimeMsAfter(norm, file.time, peakIdx);
      endpointDelta = norm[norm.length - 1]!;
      saturationIndex = saturationIndexFor(norm, declaredR0Samples);
    }

    normalized[cid] = norm;
    features.push({
      channel: cid,
      sensorType: ch.sensorType ?? "unknown",
      relativeAmplitude,
      direction,
      riseTimeMs,
      decayTimeMs,
      auc,
      r0,
      dead: stats.dead,
      endpointDelta,
      saturationIndex,
    });
  }

  return { sensorType: "resistive", features, normalized };
}
