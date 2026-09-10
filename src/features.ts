import { DEFAULT_R0_SAMPLES, OsmellFile } from "./types.js";
import { std, isFiniteNumber } from "./normalize.js";
import { baselineForChannel, channelStats, normalizedSeries } from "./normalize-mox.js";
import {
  computeChannelAbsolute,
  computeChannelDeviceAgnostic,
  computeChannelHardware,
  computeChannelHealth,
  computeChannelTemporal,
  computeMultiExpDecay,
  computeSaturationIndex,
  extractAllFrameworkFeatures,
  featureNames,
  frameworkFeatureLen,
  N_CHANNELS,
} from "./framework.js";

export {
  computeChannelAbsolute,
  computeChannelDeviceAgnostic,
  computeChannelHardware,
  computeChannelHealth,
  computeChannelTemporal,
  computeMultiExpDecay,
  computeSaturationIndex,
  extractAllFrameworkFeatures,
  featureNames,
  frameworkFeatureLen,
  N_CHANNELS,
};

export interface MoxFeatures {
  channel: string;
  relative_amplitude: number;
  direction: number;
  rise_time_ms?: number;
  decay_time_ms?: number;
  auc: number;
  r0: number;
  dead: boolean;
  endpoint_delta: number;
  saturation_index: number;
}

function firstCrossTime(time: number[], norm: number[], threshold: number): number | undefined {
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

function decayTimeMsAfter(norm: number[], time: number[], peakIdx: number): number | undefined {
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

function saturationIndexFor(norm: number[], r0Samples: number): number {
  if (norm.length < r0Samples + 5) return 0;
  const r0Norm = norm.slice(0, r0Samples);
  let currentResponse = 0;
  for (const v of norm) {
    const av = Math.abs(v);
    if (av > currentResponse) currentResponse = av;
  }
  const noiseFloor = std(r0Norm);
  if (noiseFloor !== noiseFloor || currentResponse < noiseFloor * 2) return 0;
  return Math.min(1, currentResponse / (currentResponse + noiseFloor * 10));
}

export interface MoxProcessorResult {
  sensor_type: "mox";
  features: MoxFeatures[];
  normalized: Record<string, number[]>;
}

/** Per-channel MOX kinetic features (web processMox parity). */
export function processMox(file: OsmellFile): MoxProcessorResult {
  const channels = file.manifest.sensor.channels;
  const baseline = file.manifest.baseline;
  const r0Samples = baseline?.r0Samples ?? DEFAULT_R0_SAMPLES;
  const features: MoxFeatures[] = [];
  const normalized: Record<string, number[]> = {};

  for (const ch of channels) {
    const cid = ch.id;
    const values = file.data[cid] ?? [];
    const r0 = baselineForChannel(file, cid, values)[0];
    const stats = channelStats(values, r0);
    const norm = normalizedSeries(values, r0);

    const finiteNorm = norm.filter(isFiniteNumber);
    let relativeAmplitude = 0;
    let direction = 1;
    let auc = 0;
    let riseTimeMs: number | undefined;
    let decayTimeMs: number | undefined;
    let endpointDelta = 0;
    let saturationIndex = 0;

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
      saturationIndex = saturationIndexFor(norm, r0Samples);
    }

    normalized[cid] = norm;
    features.push({
      channel: cid,
      relative_amplitude: relativeAmplitude,
      direction,
      rise_time_ms: riseTimeMs,
      decay_time_ms: decayTimeMs,
      auc,
      r0,
      dead: stats.dead,
      endpoint_delta: endpointDelta,
      saturation_index: saturationIndex,
    });
  }

  return { sensor_type: "mox", features, normalized };
}

/** Dispatch feature extraction by sensor type (web runProcessor parity). */
export function runProcessor(file: OsmellFile): MoxProcessorResult | Record<string, unknown> {
  const sensorType = file.manifest.sensor.sensorType;
  if (sensorType === "mox") return processMox(file);
  if (sensorType === "miris" || sensorType === "electrochemical") {
    return { sensor_type: sensorType, normalized: file.data };
  }
  return { sensor_type: "other" };
}