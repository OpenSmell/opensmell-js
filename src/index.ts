/** opensmell — OpenSmell JS SDK. Digital olfaction for Node.js and the browser. */
export * from "./types.js";
export * from "./normalize.js";
export * from "./normalize-mox.js";
export {
  parseCsv,
  guessSensorType,
  detectTimeColumn,
  safeFloat,
  isContextColumn,
  MOX_CHANNEL_IDS,
  type CsvParseResult,
} from "./csv.js";
export {
  OSMELL_MIME_TYPE,
  parseOsmell,
  parseOsmellFile,
  csvFromFile,
  buildOsmell,
  writeOsmell,
  defaultFileName,
} from "./io.js";
export { computeQuality, computeQualityMox, WEIGHTS } from "./quality.js";
export {
  processMox,
  runProcessor,
  type MoxFeatures,
  type MoxProcessorResult,
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
} from "./features.js";
import { type FrameworkFeatures } from "./framework.js";
export type { FrameworkFeatures };
export {
  IngestedSession,
  IngestedCollection,
  buildOsmellFile,
  ingestFile,
  ingestFolder,
} from "./ingest.js";
export {
  HardwareInsufficiencyWarning,
  effectiveDims,
  impliedChannels,
  effectiveRank,
  minEffectiveDimensions,
  checkRigSufficiency,
} from "./hardware.js";
export {
  rsR0Normalize,
  expandChannels,
  segment,
  loadCsv,
  SENSOR_NAMES,
  MQ6_COLS,
  WINDOW_SIZE,
  WINDOW_STRIDE,
} from "./preprocessing.js";