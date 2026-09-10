import {
  DEFAULT_ADC_MAX,
  FULL_SCORE_DURATION_S,
  GAP_TOLERANCE,
  MIN_SPAN_FRACTION,
  NOISE_CV_LIMIT,
  SNR_TARGET,
  ChannelStats,
  OsmellFile,
  QualityFlags,
  QualityReport,
  SubScore,
} from "./types.js";
import { isFiniteNumber, mean, median } from "./normalize.js";
import { baselineForChannel, channelStats, normalizedSeries } from "./normalize-mox.js";

export const WEIGHTS = {
  continuity: 0.15,
  dynamicRange: 0.1,
  saturationFree: 0.1,
  baselineStability: 0.2,
  signalStrength: 0.2,
  recoveryCompleteness: 0.15,
  durationAdequacy: 0.1,
} as const;

function clamp(v: number, lo = 0.0, hi = 1.0): number {
  return Math.max(lo, Math.min(hi, v));
}

function utcNowIso(): string {
  return new Date().toISOString();
}

/**
 * MOX quality scoring — spec-compliant 7-factor implementation (OSMELL spec §7).
 * Weights: C continuity 0.15, D dynamic range 0.10, S saturation-free 0.10,
 * B baseline stability 0.20, G signal strength 0.20, R recovery 0.15,
 * T duration adequacy 0.10. G/R are null (excluded) for non-exposure roles;
 * auto-baseline caps B at 50; undeclared adcMax checks only the lower rail;
 * undeclared samplingRateHz uses the median gap as the nominal schedule.
 */
export function computeQualityMox(
  file: OsmellFile,
  sampleCount: number,
  guessSamplingRateHz: number,
  unsorted: boolean,
  nonFinite: number,
): QualityReport {
  const sensor = file.manifest.sensor;
  const adcDeclared = sensor.adcMax !== undefined && sensor.adcMax !== null;
  const adcMax = adcDeclared ? sensor.adcMax! : DEFAULT_ADC_MAX;
  const rateDeclared = sensor.samplingRateHz !== undefined && sensor.samplingRateHz !== null;
  const samplingRateHz = rateDeclared ? sensor.samplingRateHz! : guessSamplingRateHz;
  const channelIds = sensor.channels.map((c) => c.id);
  const role = file.manifest.session.role ?? "single";
  const baselineSource = file.manifest.baseline?.source ?? "none";

  const flags: QualityFlags = {
    deadSensors: [],
    unsortedRows: unsorted,
    nonFiniteSamples: nonFinite,
    usedDefaultAdcMax: !adcDeclared,
    usedMedianSamplingRate: false,
    noBaseline: baselineSource === "none",
    emptyRecording: sampleCount === 0,
  };
  const reasons: Record<string, string> = {};
  const notes: string[] = [];

  // --- Continuity C ---
  const gaps: number[] = [];
  for (let i = 0; i < file.time.length - 1; i++) gaps.push(file.time[i + 1]! - file.time[i]!);
  const positiveGaps = gaps.filter((g) => g > 0);
  let continuity: SubScore;
  if (sampleCount < 2) {
    continuity = { value: 100, reason: "ok" };
  } else {
    let nominal: number | undefined;
    if (rateDeclared) {
      nominal = samplingRateHz && samplingRateHz > 0 ? 1000 / samplingRateHz : undefined;
    } else if (positiveGaps.length) {
      nominal = median(positiveGaps);
      notes.push("samplingRateHz not declared; nominal period taken as the median gap.");
      flags.usedMedianSamplingRate = true;
    }
    if (nominal !== undefined && nominal > 0) {
      const tol = GAP_TOLERANCE * nominal;
      const regular = gaps.filter((g) => Math.abs(g - nominal) <= tol).length;
      const total = gaps.length;
      continuity = {
        value: total === 0 ? 100 : (regular / total) * 100,
        reason: regular < total ? "irregular_gaps" : "ok",
      };
    } else {
      continuity = { value: 50, reason: "irregular_gaps" };
    }
  }

  // --- Per-channel stats with R0 ---
  const stats: ChannelStats[] = [];
  for (const cid of channelIds) {
    const values = file.data[cid] ?? [];
    const r0 = baselineForChannel(file, cid, values)[0];
    const st = channelStats(values, r0);
    st.id = cid;
    if (st.dead) flags.deadSensors.push(cid);
    stats.push(st);
  }
  const live = stats.filter((s) => !s.dead);

  // --- Dynamic range D ---
  const dynamicValue =
    live.length === 0
      ? 0
      : 100 *
        mean(
          live.map((s) =>
            clamp((s.span / adcMax) * (1 / MIN_SPAN_FRACTION), 0, 1),
          ),
        );
  const dynamicRange: SubScore = {
    value: dynamicValue,
    reason: dynamicValue < 50 ? "low_span" : "ok",
  };
  if (dynamicRange.reason === "low_span") {
    reasons["dynamicRange"] = "channel_span_below_10_percent_of_adc_range";
  }

  // --- Saturation-free S ---
  const satScores: number[] = [];
  for (const s of stats) {
    const values = file.data[s.id] ?? [];
    const clipped = adcDeclared
      ? values.filter((v) => v >= adcMax || v <= 0).length
      : values.filter((v) => v <= 0).length;
    s.clipped = clipped;
    satScores.push(values.length === 0 ? 100 : 100 * (1 - clipped / values.length));
  }
  const saturationFree: SubScore = { value: mean(satScores), reason: "ok" };

  // --- Baseline stability B ---
  let baselineStability: SubScore;
  if (baselineSource === "none") {
    baselineStability = { value: 0, reason: "no_baseline" };
  } else {
    const cvs: number[] = [];
    for (const s of stats) {
      const values = file.data[s.id] ?? [];
      cvs.push(baselineForChannel(file, s.id, values)[2]);
    }
    const finiteCvs = cvs.filter(isFiniteNumber);
    const cvWindow = finiteCvs.length ? mean(finiteCvs) : NaN;
    const rawB = 100 * clamp(1 - cvWindow / NOISE_CV_LIMIT, 0, 1);
    baselineStability =
      baselineSource === "auto"
        ? { value: Math.min(rawB, 50), reason: "auto_r0" }
        : {
            value: rawB,
            reason: Number.isFinite(cvWindow) && cvWindow >= NOISE_CV_LIMIT ? "r0_window_cv_too_high" : "ok",
          };
  }

  // --- Signal strength G + Recovery completeness R ---
  const exposureWithR0 = role === "exposure" && baselineSource !== "none";
  let signalStrength: SubScore;
  let recovery: SubScore;
  if (!exposureWithR0) {
    signalStrength = { value: undefined, reason: "no_exposure_signal" };
    recovery = { value: undefined, reason: "no_exposure_signal" };
  } else {
    const bestG: number[] = [];
    const recoveryScores: number[] = [];
    for (const s of live) {
      const values = file.data[s.id] ?? [];
      const base = baselineForChannel(file, s.id, values);
      const r0 = base[0];
      const norm = normalizedSeries(values, r0).filter(isFiniteNumber);
      const noise = Math.max(base[2], 1e-6);
      if (norm.length === 0) {
        bestG.push(0);
        recoveryScores.push(0);
        continue;
      }
      const peak = Math.max(...norm.map((v) => Math.abs(v)));
      bestG.push(clamp(peak / noise / SNR_TARGET, 0, 1) * 100);
      const finalWindow = median(norm.slice(-15));
      const recovered = 1 - clamp(Math.abs(finalWindow) / Math.max(peak, 1e-6), 0, 1);
      recoveryScores.push(100 * recovered);
    }
    signalStrength = { value: bestG.length ? Math.max(...bestG) : 0, reason: "ok" };
    recovery = { value: recoveryScores.length ? mean(recoveryScores) : 0, reason: "ok" };
  }

  // --- Duration adequacy T ---
  const tSeconds = samplingRateHz && samplingRateHz > 0 ? (sampleCount - 1) / samplingRateHz : 0;
  const durationAdequacy: SubScore = {
    value: 100 * clamp(tSeconds / FULL_SCORE_DURATION_S, 0, 1),
    reason: tSeconds < FULL_SCORE_DURATION_S ? "too_short" : "ok",
  };

  const subs: Record<string, SubScore> = {
    continuity,
    dynamicRange,
    saturationFree,
    baselineStability,
    signalStrength,
    recoveryCompleteness: recovery,
    durationAdequacy,
  };

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

  if (flags.deadSensors.length) notes.push(`Dead sensors (cv < 0.001): ${flags.deadSensors.join(", ")}`);
  if (flags.nonFiniteSamples) notes.push(`${flags.nonFiniteSamples} non-finite values skipped.`);
  if (flags.unsortedRows) notes.push("Rows were out of order and were sorted.");
  if (!rateDeclared) notes.push("Sampling rate inferred from median gap; verify against hardware.");
  if (!adcDeclared) notes.push("adcMax not declared; upper-rail clipping not checked (lower rail only).");
  if (flags.noBaseline) notes.push("No baseline; auto-R0 applied and baseline stability scores zero.");

  return {
    format: "opensmell-quality",
    version: "1",
    computedAt: utcNowIso(),
    total,
    badge,
    subscores: subs,
    flags,
    reasons,
    notes,
  };
}

/** Sensor-agnostic quality scoring: dispatch by the manifest sensor family. */
export function computeQuality(
  file: OsmellFile,
  sampleCount: number,
  guessSamplingRateHz: number,
  unsorted = false,
  nonFinite = 0,
): QualityReport {
  const sensorType = file.manifest.sensor.sensorType;
  if (sensorType === "mox" || sensorType === "unknown") {
    return computeQualityMox(file, sampleCount, guessSamplingRateHz, unsorted, nonFinite);
  }
  if (sensorType === "miris" || sensorType === "electrochemical") {
    throw new Error(
      `No quality scorer registered for sensor type '${sensorType}'. Implement a miris or electrochemical scorer.`,
    );
  }
  throw new Error(`Unknown sensor type '${sensorType}'.`);
}