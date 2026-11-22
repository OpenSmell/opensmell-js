// Quality scoring dispatcher for OpenSmell v1.1.
// Routes to type-specific scorers based on manifest sensor type.
// Each sensor family has fundamentally different signal characteristics:
//   - Resistive (MOX, Polymer, SolidElectrolyte): R0 baseline, ADC rail saturation
//   - Concentration (NDIR, PID, Electrochemical, Galvanic): ppm/ppb units, factory/zero baseline
//   - Frequency (QCM, SAW, Cantilever): Hz, baseline frequency f0
//   - pH (pH_ISFET): bounded 0-14, calibration point baseline
//   - MEMS: index, factory calibrated
//   - Env_TRH: context data, not an analyte
//   - other/unknown: generic variance-based scoring
import {
  DEFAULT_ADC_MAX,
  DEFAULT_R0_SAMPLES,
  FULL_SCORE_DURATION_S,
  GAP_TOLERANCE,
  MIN_SPAN_FRACTION,
  NOISE_CV_LIMIT,
  SNR_TARGET,
  ChannelStats,
  OsmellFile,
  QualityFlags,
  QualityReport,
  SensorDescriptor,
  SubScore,
} from "./types.js";
import { mean, median } from "./normalize.js";
import {
  baselineForChannel,
  channelStats,
  normalizedSeries,
} from "./normalize-mox.js";
import { scoreResistiveQuality, QualityScorerInputs } from "./quality-resistive.js";
import {
  scoreConcentrationQuality,
  ConcentrationScorerInputs,
} from "./quality-concentration.js";
import {
  scoreFrequencyQuality,
  FrequencyScorerInputs,
} from "./quality-frequency.js";
import { scorePhQuality, PhScorerInputs } from "./quality-ph.js";
import {
  scoreMemsQuality,
  MemsScorerInputs,
} from "./quality-mems.js";
import { scoreEnvQuality, EnvScorerInputs } from "./quality-env.js";
import {
  scoreGenericQuality,
  GenericScorerInputs,
} from "./quality-generic.js";

export const WEIGHTS = {
  continuity: 0.15,
  dynamicRange: 0.1,
  saturationFree: 0.1,
  baselineStability: 0.2,
  signalStrength: 0.2,
  recoveryCompleteness: 0.15,
  durationAdequacy: 0.1,
} as const;

export function utcNowIso(): string {
  return new Date().toISOString();
}

// Sensor types that use resistive (R0-based) quality scoring
const RESISTIVE_TYPES = new Set([
  "mox",
  "polymer",
  "solidElectrolyte",
]);

// Sensor types that use concentration-based quality scoring
const CONCENTRATION_TYPES = new Set([
  "ndir",
  "pas",
  "pid",
  "electrochemical",
  "galvanic",
  "catalyticBead",
]);

// Sensor types that use frequency-based quality scoring
const FREQUENCY_TYPES = new Set([
  "qcm",
  "saw",
  "cantilever",
]);

// Sensor types that use MEMS index-based quality scoring
const MEMS_TYPES = new Set(["mems"]);

// Sensor types that use pH-based quality scoring
const PH_TYPES = new Set(["phIsfet"]);

// Sensor types that use environmental context scoring
const ENV_TYPES = new Set(["envTrh"]);

/** Extract per-channel calibration params from manifest sensor descriptor. */
function extractCalibration(
  sensor: SensorDescriptor,
): {
  maxConcentrations: Record<string, number>;
  baselineConcentrations: Record<string, number>;
  baselineFrequencies: Record<string, number>;
  baselinePh: Record<string, number>;
  baselineIndex: Record<string, number>;
  maxIndex: number;
} {
  const maxConcentrations: Record<string, number> = {};
  const baselineConcentrations: Record<string, number> = {};
  const baselineFrequencies: Record<string, number> = {};
  const baselinePh: Record<string, number> = {};
  const baselineIndex: Record<string, number> = {};
  let maxIndex = 500; // default VOC index max

  for (const ch of sensor.channels) {
    const cal = sensor.calibration?.[ch.id];
    if (!cal) continue;

    switch (ch.sensorType) {
      case "ndir":
      case "pas":
      case "pid":
      case "electrochemical":
      case "galvanic":
      case "catalyticBead": {
        // a = sensitivity, b = zero offset, referencePpm = max range
        maxConcentrations[ch.id] = cal.referencePpm ?? 1000;
        baselineConcentrations[ch.id] = cal.b ?? 0;
        break;
      }
      case "qcm":
      case "saw":
      case "cantilever": {
        // a = baseline frequency
        baselineFrequencies[ch.id] = cal.a ?? 1e6;
        break;
      }
      case "phIsfet": {
        // a = ph_offset_mv, b = ph_slope_mv_per_ph
        baselinePh[ch.id] = 7; // default pH 7
        break;
      }
      case "mems": {
        // a = baseline index, b = max index
        baselineIndex[ch.id] = cal.a ?? 100;
        maxIndex = cal.b ?? maxIndex;
        break;
      }
    }
  }

  return {
    maxConcentrations,
    baselineConcentrations,
    baselineFrequencies,
    baselinePh,
    baselineIndex,
    maxIndex,
  };
}

/** Build resistive scorer inputs from manifest + data. */
function buildResistiveInputs(
  file: OsmellFile,
  sampleCount: number,
  guessSamplingRateHz: number,
  unsorted: boolean,
  nonFinite: number,
): QualityScorerInputs {
  const sensor = file.manifest.sensor;
  const adcDeclared = sensor.adcMax !== undefined && sensor.adcMax !== null;
  const adcMax = adcDeclared ? sensor.adcMax! : DEFAULT_ADC_MAX;
  const rateDeclared = sensor.samplingRateHz !== undefined && sensor.samplingRateHz !== null;
  const samplingRateHz = rateDeclared ? sensor.samplingRateHz! : guessSamplingRateHz;
  const channelIds = sensor.channels.map((c) => c.id);
  const baseline = file.manifest.baseline;
  const baselineSource = baseline?.source ?? "none";
  const role = file.manifest.session.role ?? "single";

  return {
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
  };
}

/** Build concentration scorer inputs. */
function buildConcentrationInputs(
  file: OsmellFile,
  sampleCount: number,
  guessSamplingRateHz: number,
  unsorted: boolean,
  nonFinite: number,
  cal: ReturnType<typeof extractCalibration>,
): ConcentrationScorerInputs {
  const sensor = file.manifest.sensor;
  const rateDeclared = sensor.samplingRateHz !== undefined && sensor.samplingRateHz !== null;
  const samplingRateHz = rateDeclared ? sensor.samplingRateHz! : guessSamplingRateHz;
  const channelIds = sensor.channels.map((c) => c.id);
  const role = file.manifest.session.role ?? "single";

  return {
    file,
    sampleCount,
    guessSamplingRateHz,
    unsorted,
    nonFinite,
    channelIds,
    maxConcentrations: cal.maxConcentrations,
    baselineConcentrations: cal.baselineConcentrations,
    rateDeclared,
    samplingRateHz,
    role,
  };
}

/** Build frequency scorer inputs. */
function buildFrequencyInputs(
  file: OsmellFile,
  sampleCount: number,
  guessSamplingRateHz: number,
  unsorted: boolean,
  nonFinite: number,
  cal: ReturnType<typeof extractCalibration>,
): FrequencyScorerInputs {
  const sensor = file.manifest.sensor;
  const rateDeclared = sensor.samplingRateHz !== undefined && sensor.samplingRateHz !== null;
  const samplingRateHz = rateDeclared ? sensor.samplingRateHz! : guessSamplingRateHz;
  const channelIds = sensor.channels.map((c) => c.id);
  const role = file.manifest.session.role ?? "single";

  return {
    file,
    sampleCount,
    guessSamplingRateHz,
    unsorted,
    nonFinite,
    channelIds,
    baselineFrequencies: cal.baselineFrequencies,
    rateDeclared,
    samplingRateHz,
    role,
  };
}

/** Build pH scorer inputs. */
function buildPhInputs(
  file: OsmellFile,
  sampleCount: number,
  guessSamplingRateHz: number,
  unsorted: boolean,
  nonFinite: number,
  cal: ReturnType<typeof extractCalibration>,
): PhScorerInputs {
  const sensor = file.manifest.sensor;
  const rateDeclared = sensor.samplingRateHz !== undefined && sensor.samplingRateHz !== null;
  const samplingRateHz = rateDeclared ? sensor.samplingRateHz! : guessSamplingRateHz;
  const channelIds = sensor.channels.map((c) => c.id);
  const role = file.manifest.session.role ?? "single";

  return {
    file,
    sampleCount,
    guessSamplingRateHz,
    unsorted,
    nonFinite,
    channelIds,
    baselinePh: cal.baselinePh,
    rateDeclared,
    samplingRateHz,
    role,
  };
}

/** Build MEMS scorer inputs. */
function buildMemsInputs(
  file: OsmellFile,
  sampleCount: number,
  guessSamplingRateHz: number,
  unsorted: boolean,
  nonFinite: number,
  cal: ReturnType<typeof extractCalibration>,
): MemsScorerInputs {
  const sensor = file.manifest.sensor;
  const rateDeclared = sensor.samplingRateHz !== undefined && sensor.samplingRateHz !== null;
  const samplingRateHz = rateDeclared ? sensor.samplingRateHz! : guessSamplingRateHz;
  const channelIds = sensor.channels.map((c) => c.id);
  const role = file.manifest.session.role ?? "single";

  return {
    file,
    sampleCount,
    guessSamplingRateHz,
    unsorted,
    nonFinite,
    channelIds,
    baselineIndex: cal.baselineIndex,
    maxIndex: cal.maxIndex,
    rateDeclared,
    samplingRateHz,
    role,
  };
}

/** Build env scorer inputs. */
function buildEnvInputs(
  file: OsmellFile,
  sampleCount: number,
  guessSamplingRateHz: number,
  unsorted: boolean,
  nonFinite: number,
): EnvScorerInputs {
  const sensor = file.manifest.sensor;
  const rateDeclared = sensor.samplingRateHz !== undefined && sensor.samplingRateHz !== null;
  const samplingRateHz = rateDeclared ? sensor.samplingRateHz! : guessSamplingRateHz;
  const channelIds = sensor.channels.map((c) => c.id);
  const role = file.manifest.session.role ?? "single";

  return {
    file,
    sampleCount,
    guessSamplingRateHz,
    unsorted,
    nonFinite,
    channelIds,
    rateDeclared,
    samplingRateHz,
    role,
  };
}

/** Build generic scorer inputs. */
function buildGenericInputs(
  file: OsmellFile,
  sampleCount: number,
  guessSamplingRateHz: number,
  unsorted: boolean,
  nonFinite: number,
): GenericScorerInputs {
  const sensor = file.manifest.sensor;
  const rateDeclared = sensor.samplingRateHz !== undefined && sensor.samplingRateHz !== null;
  const samplingRateHz = rateDeclared ? sensor.samplingRateHz! : guessSamplingRateHz;
  const channelIds = sensor.channels.map((c) => c.id);
  const role = file.manifest.session.role ?? "single";

  return {
    file,
    sampleCount,
    guessSamplingRateHz,
    unsorted,
    nonFinite,
    channelIds,
    rateDeclared,
    samplingRateHz,
    role,
  };
}

/**
 * Sensor-agnostic quality scoring: dispatch by the manifest sensor family.
 * Each sensor type gets a type-specific scorer because ADC rail saturation,
 * R0 baselines, frequency baselines, and pH bounds are type-specific concepts.
 */
export function computeQuality(
  file: OsmellFile,
  sampleCount: number,
  guessSamplingRateHz: number,
  unsorted = false,
  nonFinite = 0,
): QualityReport {
  const sensor = file.manifest.sensor;
  const sensorType = sensor.sensorType;
  const cal = extractCalibration(sensor);

  if (RESISTIVE_TYPES.has(sensorType)) {
    const result = scoreResistiveQuality(
      buildResistiveInputs(file, sampleCount, guessSamplingRateHz, unsorted, nonFinite),
    );
    return wrapReport(sensorType, result);
  }

  if (CONCENTRATION_TYPES.has(sensorType)) {
    const result = scoreConcentrationQuality(
      buildConcentrationInputs(
        file, sampleCount, guessSamplingRateHz, unsorted, nonFinite, cal,
      ),
    );
    return wrapReport(sensorType, result);
  }

  if (FREQUENCY_TYPES.has(sensorType)) {
    const result = scoreFrequencyQuality(
      buildFrequencyInputs(
        file, sampleCount, guessSamplingRateHz, unsorted, nonFinite, cal,
      ),
    );
    return wrapReport(sensorType, result);
  }

  if (PH_TYPES.has(sensorType)) {
    const result = scorePhQuality(
      buildPhInputs(
        file, sampleCount, guessSamplingRateHz, unsorted, nonFinite, cal,
      ),
    );
    return wrapReport(sensorType, result);
  }

  if (MEMS_TYPES.has(sensorType)) {
    const result = scoreMemsQuality(
      buildMemsInputs(
        file, sampleCount, guessSamplingRateHz, unsorted, nonFinite, cal,
      ),
    );
    return wrapReport(sensorType, result);
  }

  if (ENV_TYPES.has(sensorType)) {
    const result = scoreEnvQuality(
      buildEnvInputs(file, sampleCount, guessSamplingRateHz, unsorted, nonFinite),
    );
    return wrapReport(sensorType, result);
  }

  // other / unknown: generic scoring
  const result = scoreGenericQuality(
    buildGenericInputs(file, sampleCount, guessSamplingRateHz, unsorted, nonFinite),
  );
  return wrapReport(sensorType, result);
}

/** Wrap a scorer result into the standard QualityReport shape. */
function wrapReport(
  sensorType: string,
  result: {
    subs: Record<string, SubScore>;
    flags: QualityFlags;
    reasons: Record<string, string>;
    notes: string[];
    total: number | undefined;
    badge: string;
  },
): QualityReport {
  return {
    format: "opensmell-quality",
    version: "1",
    computedAt: new Date().toISOString(),
    total: result.total,
    badge: result.badge,
    subscores: result.subs,
    flags: result.flags,
    reasons: result.reasons,
    notes: result.notes,
  };
}
