// Per-type quality scorers for resistive sensors (MOX, Polymer, SolidElectrolyte).
// Signal domain: resistance (ohms). Baseline: R0. Normalized: (R - R0)/R0.
// Saturation: ADC rail (0 or adcMax). Dead: near-zero CV.
import {
  ChannelStats,
  DEFAULT_ADC_MAX,
  DEFAULT_R0_SAMPLES,
  FULL_SCORE_DURATION_S,
  GAP_TOLERANCE,
  MIN_SPAN_FRACTION,
  NOISE_CV_LIMIT,
  SNR_TARGET,
  OsmellFile,
  QualityFlags,
  QualityReport,
  SubScore,
} from "./types.js";
import { mean, std, median, isFiniteNumber } from "./normalize.js";
import {
  baselineForChannel,
  channelStats,
  normalizedSeries,
} from "./normalize-mox.js";
import { WEIGHTS, utcNowIso } from "./quality.js";

function clamp(v: number, lo = 0.0, hi = 1.0): number {
  return Math.max(lo, Math.min(hi, v));
}

export interface QualityScorerInputs {
  file: OsmellFile;
  sampleCount: number;
  guessSamplingRateHz: number;
  unsorted: boolean;
  nonFinite: number;
  channelIds: string[];
  adcDeclared: boolean;
  adcMax: number;
  rateDeclared: boolean;
  samplingRateHz: number;
  baselineSource: string;
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

/** Dynamic range: span relative to ADC full scale. Resistive-specific. */
function scoreDynamicRange(
  stats: ChannelStats[],
  adcMax: number,
): SubScore {
  const live = stats.filter((s) => !s.dead);
  const value =
    live.length === 0
      ? 0
      : 100 *
        mean(
          live.map((s) =>
            clamp((s.span / adcMax) * (1 / MIN_SPAN_FRACTION), 0, 1),
          ),
        );
  return {
    value,
    reason: value < 50 ? "low_span" : "ok",
  };
}

/** Saturation-free: fraction of samples not at ADC rails. Resistive-specific. */
function scoreSaturationFree(
  file: OsmellFile,
  stats: ChannelStats[],
  adcMax: number,
): SubScore {
  const satScores: number[] = [];
  for (const s of stats) {
    const values = file.data[s.id] ?? [];
    const clipped = values.filter((v) => v >= adcMax || v <= 0).length;
    satScores.push(values.length === 0 ? 100 : 100 * (1 - clipped / values.length));
  }
  return { value: mean(satScores), reason: "ok" };
}

/** Baseline stability: CV of baseline window. Resistive-specific. */
function scoreBaselineStability(
  file: OsmellFile,
  stats: ChannelStats[],
  baselineSource: string,
): SubScore {
  if (baselineSource === "none") {
    return { value: 0, reason: "no_baseline" };
  }
  const cvs: number[] = [];
  for (const s of stats) {
    const values = file.data[s.id] ?? [];
    cvs.push(baselineForChannel(file, s.id, values)[2]);
  }
  const finiteCvs = cvs.filter(isFiniteNumber);
  const cvWindow = finiteCvs.length ? mean(finiteCvs) : NaN;
  const rawB = 100 * clamp(1 - cvWindow / NOISE_CV_LIMIT, 0, 1);
  return baselineSource === "auto"
    ? { value: Math.min(rawB, 50), reason: "auto_r0" }
    : {
        value: rawB,
        reason:
          Number.isFinite(cvWindow) && cvWindow >= NOISE_CV_LIMIT
            ? "r0_window_cv_too_high"
            : "ok",
      };
}

/** Signal strength: peak vs noise. Resistive-specific. */
function scoreSignalStrength(
  file: OsmellFile,
  stats: ChannelStats[],
  baselineSource: string,
): SubScore {
  const bestG: number[] = [];
  for (const s of stats) {
    const values = file.data[s.id] ?? [];
    const base = baselineForChannel(file, s.id, values);
    const r0 = base[0];
    const norm = normalizedSeries(values, r0).filter(isFiniteNumber);
    const noise = Math.max(base[2], 1e-6);
    if (norm.length === 0) {
      bestG.push(0);
      continue;
    }
    const peak = Math.max(...norm.map((v) => Math.abs(v)));
    bestG.push(clamp(peak / noise / SNR_TARGET, 0, 1) * 100);
  }
  return { value: bestG.length ? Math.max(...bestG) : 0, reason: "ok" };
}

/** Recovery completeness: return to baseline after exposure. Resistive-specific. */
function scoreRecovery(
  file: OsmellFile,
  stats: ChannelStats[],
  baselineSource: string,
): SubScore {
  const recoveryScores: number[] = [];
  for (const s of stats) {
    const values = file.data[s.id] ?? [];
    const base = baselineForChannel(file, s.id, values);
    const r0 = base[0];
    const norm = normalizedSeries(values, r0).filter(isFiniteNumber);
    if (norm.length === 0) {
      recoveryScores.push(0);
      continue;
    }
    const peak = Math.max(...norm.map((v) => Math.abs(v)));
    const finalWindow = median(norm.slice(-15));
    const recovered = 1 - clamp(Math.abs(finalWindow) / Math.max(peak, 1e-6), 0, 1);
    recoveryScores.push(100 * recovered);
  }
  return {
    value: recoveryScores.length ? mean(recoveryScores) : 0,
    reason: "ok",
  };
}

/** Duration adequacy: test length vs full score duration. Type-agnostic. */
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

export function scoreResistiveQuality(
  inputs: QualityScorerInputs,
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
    adcDeclared,
    adcMax,
    rateDeclared,
    samplingRateHz,
    baselineSource,
    role,
  } = inputs;

  const flags: QualityFlags = {
    deadSensors: [],
    nonFiniteSamples: nonFinite,
    unsortedRows: unsorted,
    usedDefaultAdcMax: !adcDeclared,
    usedMedianSamplingRate: !rateDeclared,
    noBaseline: baselineSource === "none",
    emptyRecording: file.data[channelIds[0] ?? ""]?.length === 0,
  };

  const stats: ChannelStats[] = [];
  for (const cid of channelIds) {
    const values = file.data[cid] ?? [];
    const st = channelStats(values, baselineForChannel(file, cid, values)[0]);
    st.id = cid;
    if (st.dead) flags.deadSensors.push(cid);
    stats.push(st);
  }
  const live = stats.filter((s) => !s.dead);

  const subs: Record<string, SubScore> = {
    continuity: scoreContinuity(file, channelIds, unsorted, samplingRateHz),
    dynamicRange: scoreDynamicRange(live, adcMax),
    saturationFree: scoreSaturationFree(file, stats, adcMax),
    baselineStability: scoreBaselineStability(file, stats, baselineSource),
    signalStrength: scoreSignalStrength(file, stats, baselineSource),
    recoveryCompleteness: scoreRecovery(file, stats, baselineSource),
    durationAdequacy: scoreDurationAdequacy(sampleCount, samplingRateHz),
  };

  const reasons: Record<string, string> = {};
  if (subs.dynamicRange!.reason === "low_span") {
    reasons["dynamicRange"] = "channel_span_below_10_percent_of_adc_range";
  }
  if (!adcDeclared) {
    reasons["saturationFree"] = "adc_max_not_declared_upper_rail_unchecked";
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
  if (flags.deadSensors.length)
    notes.push(`Dead sensors (cv < 0.001): ${flags.deadSensors.join(", ")}`);
  if (flags.nonFiniteSamples)
    notes.push(`${flags.nonFiniteSamples} non-finite values skipped.`);
  if (flags.unsortedRows) notes.push("Rows were out of order and were sorted.");
  if (!rateDeclared)
    notes.push("Sampling rate inferred from median gap; verify against hardware.");
  if (!adcDeclared)
    notes.push("adcMax not declared; upper-rail clipping not checked (lower rail only).");
  if (flags.noBaseline)
    notes.push("No baseline; auto-R0 applied and baseline stability scores zero.");

  return { subs, flags, reasons, notes, total, badge };
}
