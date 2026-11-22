// Per-type quality scorer for "other" and "unknown" sensor types.
// Generic scoring: continuity, variance-based span, clipping at 0.
// No type-specific domain knowledge available.
import {
  DEFAULT_ADC_MAX,
  DEFAULT_R0_SAMPLES,
  FULL_SCORE_DURATION_S,
  GAP_TOLERANCE,
  MIN_SPAN_FRACTION,
  NOISE_CV_LIMIT,
  SNR_TARGET,
  OsmellFile,
  QualityFlags,
  SubScore,
} from "./types.js";
import { mean, std, median, isFiniteNumber } from "./normalize.js";
import { WEIGHTS, utcNowIso } from "./quality.js";

function clamp(v: number, lo = 0.0, hi = 1.0): number {
  return Math.max(lo, Math.min(hi, v));
}

export interface GenericScorerInputs {
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

/** Dynamic range: span relative to observed max-min. Generic. */
function scoreDynamicRange(
  file: OsmellFile,
  channelIds: string[],
): SubScore {
  const liveScores: number[] = [];
  for (const cid of channelIds) {
    const values = file.data[cid] ?? [];
    const finite = values.filter(Number.isFinite);
    if (finite.length === 0) continue;
    const lo = Math.min(...finite);
    const hi = Math.max(...finite);
    const span = Math.abs(hi - lo);
    const meanVal = mean(finite);
    const relativeSpan = Math.abs(meanVal) > 1e-6 ? span / Math.abs(meanVal) : span;
    liveScores.push(clamp(relativeSpan * (1 / MIN_SPAN_FRACTION), 0, 1) * 100);
  }
  const value = liveScores.length ? mean(liveScores) : 0;
  return {
    value,
    reason: value < 50 ? "low_span" : "ok",
  };
}

/** Saturation-free: fraction not at zero (generic lower rail only). */
function scoreSaturationFree(
  file: OsmellFile,
  channelIds: string[],
): SubScore {
  const satScores: number[] = [];
  for (const cid of channelIds) {
    const values = file.data[cid] ?? [];
    const clipped = values.filter((v) => v <= 0).length;
    satScores.push(values.length === 0 ? 100 : 100 * (1 - clipped / values.length));
  }
  return { value: mean(satScores), reason: "ok" };
}

/** Baseline stability: CV of baseline window. */
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
        ? "baseline_cv_too_high"
        : "ok",
  };
}

/** Signal strength: peak deviation from baseline vs noise. */
function scoreSignalStrength(
  file: OsmellFile,
  channelIds: string[],
): SubScore {
  const bestG: number[] = [];
  for (const cid of channelIds) {
    const values = file.data[cid] ?? [];
    const n = Math.min(values.length, DEFAULT_R0_SAMPLES ?? 10);
    const baseline = mean(values.slice(0, n).filter(Number.isFinite)) || 0;
    const finite = values.filter(Number.isFinite);
    if (finite.length === 0) {
      bestG.push(0);
      continue;
    }
    const peak = Math.max(...finite.map((v) => Math.abs(v - baseline)));
    const noise = std(finite.slice(0, Math.min(finite.length, 20))) || 1e-6;
    bestG.push(clamp(peak / noise / SNR_TARGET, 0, 1) * 100);
  }
  return { value: bestG.length ? Math.max(...bestG) : 0, reason: "ok" };
}

/** Recovery completeness: return to baseline after exposure. */
function scoreRecovery(
  file: OsmellFile,
  channelIds: string[],
): SubScore {
  const recoveryScores: number[] = [];
  for (const cid of channelIds) {
    const values = file.data[cid] ?? [];
    const n = Math.min(values.length, DEFAULT_R0_SAMPLES ?? 10);
    const baseline = mean(values.slice(0, n).filter(Number.isFinite)) || 0;
    const finite = values.filter(Number.isFinite);
    if (finite.length === 0) {
      recoveryScores.push(0);
      continue;
    }
    const peak = Math.max(...finite.map((v) => Math.abs(v - baseline)));
    const finalWindow = median(finite.slice(-15));
    const recovered = 1 - clamp(Math.abs(finalWindow - baseline) / Math.max(peak, 1e-6), 0, 1);
    recoveryScores.push(100 * recovered);
  }
  return {
    value: recoveryScores.length ? mean(recoveryScores) : 0,
    reason: "ok",
  };
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

export function scoreGenericQuality(
  inputs: GenericScorerInputs,
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
    dynamicRange: scoreDynamicRange(file, channelIds),
    saturationFree: scoreSaturationFree(file, channelIds),
    baselineStability: scoreBaselineStability(file, channelIds),
    signalStrength: scoreSignalStrength(file, channelIds),
    recoveryCompleteness: scoreRecovery(file, channelIds),
    durationAdequacy: scoreDurationAdequacy(sampleCount, samplingRateHz),
  };

  const reasons: Record<string, string> = {};
  if (subs.dynamicRange!.reason === "low_span") {
    reasons["dynamicRange"] = "channel_span_below_10_percent_of_mean";
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
