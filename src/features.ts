// Feature extraction dispatcher for OpenSmell v1.1.
// Routes to type-specific feature extractors based on manifest sensor type.
// Each sensor family has fundamentally different signal characteristics:
//   - Resistive (MOX, Polymer, SolidElectrolyte): ΔR/R0, kinetic features
//   - Concentration (NDIR, PID, Electrochemical, Galvanic): ΔC from baseline
//   - Frequency (QCM, SAW, Cantilever): Δf = f - f0
//   - pH (pH_ISFET): ΔpH = pH - pH0
//   - MEMS: Δindex = index - index0
//   - other/unknown: generic delta from baseline
import {
  DEFAULT_R0_SAMPLES,
  OsmellFile,
} from "./types.js";
import { mean } from "./normalize.js";
import {
  baselineForChannel,
  channelStats,
  normalizedSeries,
} from "./normalize-mox.js";
import {
  extractResistiveFeatures,
  ResistiveFeature,
} from "./features-resistive.js";
import {
  extractConcentrationFeatures,
  ConcentrationFeature,
} from "./features-concentration.js";
import {
  extractFrequencyFeatures,
  FrequencyFeature,
} from "./features-frequency.js";
import { extractPhFeatures, PhFeature } from "./features-ph.js";
import { extractMemsFeatures, MemsFeature } from "./features-mems.js";

// Sensor types that use resistive (ΔR/R0) feature extraction
const RESISTIVE_TYPES = new Set([
  "mox",
  "polymer",
  "solidElectrolyte",
]);

// Sensor types that use concentration-based feature extraction
const CONCENTRATION_TYPES = new Set([
  "ndir",
  "pas",
  "pid",
  "electrochemical",
  "galvanic",
  "catalyticBead",
]);

// Sensor types that use frequency-based feature extraction
const FREQUENCY_TYPES = new Set([
  "qcm",
  "saw",
  "cantilever",
]);

// Sensor types that use MEMS index-based feature extraction
const MEMS_TYPES = new Set(["mems"]);

// Sensor types that use pH-based feature extraction
const PH_TYPES = new Set(["phIsfet"]);

// Legacy MoxFeatures interface kept for backward compatibility
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

export interface MoxProcessorResult {
  sensorType: string;
  features: MoxFeatures[];
  normalized: Record<string, number[]>;
}

// Legacy MOX processor kept for backward compatibility.
// New code should use extractResistiveFeatures directly.
export function processMox(file: OsmellFile): MoxProcessorResult {
  const result = extractResistiveFeatures(file);
  return {
    sensorType: "mox",
    features: result.features.map((f) => ({
      channel: f.channel,
      relative_amplitude: f.relativeAmplitude,
      direction: f.direction,
      rise_time_ms: f.riseTimeMs,
      decay_time_ms: f.decayTimeMs,
      auc: f.auc,
      r0: f.r0,
      dead: f.dead,
      endpoint_delta: f.endpointDelta,
      saturation_index: f.saturationIndex,
    })),
    normalized: result.normalized,
  };
}

/** Dispatch feature extraction by sensor type. */
export function runProcessor(
  file: OsmellFile,
  cal?: {
    baselineConcentrations: Record<string, number>;
    maxConcentrations: Record<string, number>;
    baselineFrequencies: Record<string, number>;
    baselinePh: Record<string, number>;
    baselineIndex: Record<string, number>;
    maxIndex: number;
  },
):
  | MoxProcessorResult
  | ResistiveFeature[]
  | ConcentrationFeature[]
  | FrequencyFeature[]
  | PhFeature[]
  | MemsFeature[]
  | { sensorType: string; features: any[]; normalized: Record<string, number[]> } {
  const sensorType = file.manifest.sensor.sensorType;

  if (RESISTIVE_TYPES.has(sensorType)) {
    return extractResistiveFeatures(file);
  }

  if (CONCENTRATION_TYPES.has(sensorType)) {
    return extractConcentrationFeatures(
      file,
      cal?.baselineConcentrations ?? {},
      cal?.maxConcentrations ?? {},
    );
  }

  if (FREQUENCY_TYPES.has(sensorType)) {
    return extractFrequencyFeatures(file, cal?.baselineFrequencies ?? {});
  }

  if (PH_TYPES.has(sensorType)) {
    return extractPhFeatures(file, cal?.baselinePh ?? {});
  }

  if (MEMS_TYPES.has(sensorType)) {
    return extractMemsFeatures(file, cal?.baselineIndex ?? {});
  }

  // other / unknown / envTrh / miris: generic
  return {
    sensorType: sensorType,
    features: [],
    normalized: {},
  };
}

// Framework feature exports from framework.js
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
} from "./framework.js";
