// Per-type quality scorer for environmental sensors (Env_TRH: temperature/humidity).
// Signal domain: temperature (°C) and humidity (%RH). Context data, not an analyte.
// Scored for: continuity, physical range validity, baseline stability.
// Not scored for: signal strength/recovery (no "exposure" concept for context).
import {
  DEFAULT_R0_SAMPLES,
  FULL_SCORE_DURATION_S,
  GAP_TOLERANCE,
  NOISE_CV_LIMIT,
  SNR_TARGET,
  OsmellFile,
  QualityFlags,
  SubScore,
} from "./types.js";
import { mean, std, isFiniteNumber } from "./normalize.js";
import { WEIGHTS, utcNowIso } from "./quality.js";

function clamp(v: number, lo = 0.0, hi = 1.0): number {
  return Math.max(lo, Math.min(hi, v));
}

export interface EnvScorerInputs {
  file: OsmellFile;
  sampleCount: number;
  guessSamplingRateHz: number;
  unsorted: boolean;
  nonFinite: number;
  channelIds: string[];
  rateDeclared: boolean;
  samplingRateHz: number;
  role: string;
}

/** Continuity: time gaps, unsorted rows, sampling rate. Type-agnostic. */
function scoreContinuity(
  file: OsmellFile,
  channelIds: string[],
  unsorted: boolean,
  samplingRateHz: number,
): SubScore {
  let totalGapPenalty = 0;
  let gapCount = 0;
  for (let i = 1; i < file.time.length; i++) {
    const gap = file.time[i]! - file.time[i - 1]!;
    if (gap > 0 && samplingRateHz > 0) {
      const expected = 1000 / samplingRateHz;
      if (gap > expected * (1 + GAP_TOLERANCE)) {
        gapCount++;
        totalGapPenalty += Math.min(1, gap / expected - 1);
      }
    }
  }
  const continuityValue =
    gapCount === 0
      ? 100
      : 100 * clamp(1 - totalGapPenalty / Math.max(gapCount, 1), 0, 1);
  return {
    value: continuityValue,
    reason: gapCount > 0 ? `time_gaps_x${gapCount}` : "ok",
  };
}

/** Physical range validity: temperature in [-40, 125]°C, humidity in [0, 100]%RH. */
function scorePhysicalRange(
  file: OsmellFile,
  channelIds: string[],
): SubScore {
  const rangeScores: number[] = [];
  for (const cid of channelIds) {
    const values = file.data[cid] ?? [];
    const finite = values.filter(Number.isFinite);
    if (finite.length === 0) {
      rangeScores.push(0);
      continue;
    }
    const lo = Math.min(...finite);
    const hi = Math.max(...finite);
    // Temperature: valid range -40 to 125 °C
    // Humidity: valid range 0 to 100 %RH
    // Context sensors: check both bounds are within physical reality
    const tempValid = lo >= -40 && hi <= 125;
    const rhValid = lo >= 0 && hi <= 100;
    const valid = tempValid && rhValid;
    rangeScores.push(valid ? 100 : 50);
  }
  const value = rangeScores.length ? mean(rangeScores) : 0;
  return {
    value,
    reason: value < 100 ? "out_of_physical_range" : "ok",
  };
}

/** Baseline stability: CV of baseline readings. */
function scoreBaselineStability(
  file: OsmellFile,
  channelIds: string[],
): SubScore {
  const cvs: number[] = [];
  for (const cid of channelIds) {
    const values = file.data[cid] ?? [];
    const n = Math.min(values.length, DEFAULT_R0_SAMPLES ?? 10);
    const window = values.slice(0, n).filter(Number.isFinite);
    if (window.length === 0) continue;
    const m = mean(window);
    const sd = std(window);
    const cv = Math.abs(m) > 1e-6 ? sd / Math.abs(m) : sd;
    cvs.push(cv);
  }
  const finiteCvs = cvs.filter(isFiniteNumber);
  const cvWindow = finiteCvs.length ? mean(finiteCvs) : NaN;
  const rawB = 100 * clamp(1 - cvWindow / NOISE_CV_LIMIT, 0, 1);
  return {
    value: rawB,
    reason:
      Number.isFinite(cvWindow) && cvWindow >= NOISE_CV_LIMIT
        ? "baseline_drift"
        : "ok",
  };
}

/** Signal strength: context sensors have low expected variation. */
function scoreSignalStrength(
  file: OsmellFile,
  channelIds: string[],
): SubScore {
  const bestG: number[] = [];
  for (const cid of channelIds) {
    const values = file.data[cid] ?? [];
    const finite = values.filter(Number.isFinite);
    if (finite.length === 0) {
      bestG.push(0);
      continue;
    }
    const m = mean(finite);
    const sd = std(finite);
    const cv = Math.abs(m) > 1e-6 ? sd / Math.abs(m) : sd;
    // Low CV is good for context sensors (stable environment)
    bestG.push(clamp(1 - cv / NOISE_CV_LIMIT, 0, 1) * 100);
  }
  return { value: bestG.length ? Math.max(...bestG) : 0, reason: "ok" };
}

/** Recovery completeness: not applicable for context sensors (always active). */
function scoreRecovery(): SubScore {
  return { value: 100, reason: "not_applicable" };
}

/** Duration adequacy: test length vs full score duration. */
function scoreDurationAdequacy(
  sampleCount: number,
  samplingRateHz: number,
): SubScore {
  const tSeconds = samplingRateHz && samplingRateHz > 0 ? (sampleCount - 1) / samplingRateHz : 0;
  return {
    value: 100 * clamp(tSeconds / FULL_SCORE_DURATION_S, 0, 1),
    reason: tSeconds < FULL_SCORE_DURATION_S ? "too_short" : "ok",
  };
}

export function scoreEnvQuality(
  inputs: EnvScorerInputs,
): {
  subs: Record<string, SubScore>;
  flags: QualityFlags;
  reasons: Record<string, string>;
  notes: string[];
  total: number | undefined;
  badge: string;
} {
  const {
    file,
    sampleCount,
    guessSamplingRateHz,
    unsorted,
    nonFinite,
    channelIds,
    rateDeclared,
    samplingRateHz,
    role,
  } = inputs;

  const flags: QualityFlags = {
    deadSensors: [],
    nonFiniteSamples: nonFinite,
    unsortedRows: unsorted,
    usedDefaultAdcMax: false,
    usedMedianSamplingRate: !rateDeclared,
    noBaseline: false,
    emptyRecording: file.data[channelIds[0] ?? ""]?.length === 0,
  };

  const subs: Record<string, SubScore> = {
    continuity: scoreContinuity(file, channelIds, unsorted, samplingRateHz),
    dynamicRange: scorePhysicalRange(file, channelIds),
    saturationFree: { value: 100, reason: "not_applicable" },
    baselineStability: scoreBaselineStability(file, channelIds),
    signalStrength: scoreSignalStrength(file, channelIds),
    recoveryCompleteness: scoreRecovery(),
    durationAdequacy: scoreDurationAdequacy(sampleCount, samplingRateHz),
  };

  const reasons: Record<string, string> = {};
  if (subs.dynamicRange!.reason === "out_of_physical_range") {
    reasons["dynamicRange"] = "environmental_reading_out_of_physical_range";
  }

  let weighted = 0;
  let sumW = 0;
  for (const k of Object.keys(subs)) {
    const sub = subs[k]!;
    if (sub.value === undefined || !Number.isFinite(sub.value)) continue;
    const w = WEIGHTS[k as keyof typeof WEIGHTS]!;
    weighted += w * sub.value;
    sumW += w;
  }
  const total = sumW > 0 ? Math.round(weighted / sumW) : undefined;

  let badge: string;
  if (total === undefined) badge = "Unknown";
  else if (total >= 90) badge = "Excellent";
  else if (total >= 75) badge = "Good";
  else if (total >= 50) badge = "Fair";
  else badge = "Poor";

  const notes: string[] = [];
  if (flags.nonFiniteSamples)
    notes.push(`${flags.nonFiniteSamples} non-finite values skipped.`);
  if (flags.unsortedRows) notes.push("Rows were out of order and were sorted.");
  if (!rateDeclared)
    notes.push("Sampling rate inferred from median gap; verify against hardware.");

  return { subs, flags, reasons, notes, total, badge };
}
