export const OSMELL_FORMAT_VERSION = "1.0.0";

export const TIME_COLUMNS = ["timestamp_ms", "elapsed_ms"];
export const TIME_COLUMN_ALIASES = [
  "timestamp_ms",
  "elapsed_ms",
  "timestamp",
  "elapsed",
  "time_ms",
  "time_s",
  "time",
  "synthetic_index",
];
export const DEFAULT_SYNTHETIC_RATE_HZ = 10.0;
export const CONTEXT_COLUMN_HINTS = [
  "temperature",
  "pressure",
  "humidity",
  "gas_res",
  "resistance",
  "altitude",
];
export const SENSOR_TYPES = ["mox", "miris", "electrochemical", "other", "unknown"];
export const SESSION_ROLES = ["baseline", "exposure", "single"];
export const BASELINE_SOURCES = ["explicit", "auto", "none"];

export const DEFAULT_ADC_MAX = 4095;
export const DEAD_CV_THRESHOLD = 0.001;
export const NOISE_CV_LIMIT = 0.05;
export const SNR_TARGET = 10;
export const FULL_SCORE_DURATION_S = 60;
export const MIN_SPAN_FRACTION = 0.1;
export const GAP_TOLERANCE = 0.1;

// --- R0 baseline window (SAMPLING_CONTRACT.md, "The R0 window contract") ---
//
// A declared window (`manifest.baseline.r0Samples` or an explicit `r0Samples`
// argument) always wins and is used verbatim: whoever declares a window owns the
// duration-to-count conversion the contract requires, `round(duration_s * sr)`.
// `undefined` (and `0`, which is not a meaningful window) here means "no window
// declared": reduce the recording with the contract default below. The Rust
// `R0_WINDOW_DEFAULT` sentinel carries `0` for the same reason, so all three SDKs
// accept `undefined`/`null`/`0` interchangeably.
export const DEFAULT_R0_SAMPLES: number | undefined = undefined;
// Fraction of the recording the baseline window spans when nothing is declared.
// The same fraction `HARDWARE.md` (`cutoff = sample_count * 0.15`) and
// `data-commons/docs/wire-protocol.md` ("median of first 15%") specify.
export const R0_WINDOW_FRACTION = 0.15;
// Floor: below ~5 samples the median is one or two readings and a single ADC LSB
// moves R0 by 10-20%. Ceiling: on a long recording an unbounded 15% would swallow
// the onset, so the baseline must stay inside the leading plateau.
export const R0_WINDOW_MIN_SAMPLES = 5;
export const R0_WINDOW_MAX_SAMPLES = 30;

/**
 * Number of leading samples forming the R0 baseline window.
 *
 * `declared` is a caller/manifest-declared window and is returned verbatim.
 * `undefined` (and `0`, which is not a meaningful window) means nothing was
 * declared and the contract default applies: `clamp(floor(0.15 * nSamples), 5,
 * 30)`.
 *
 * **The default window is cadence-independent**; a fixed sample count is not.
 * `nSamples` grows with the rate, so in the fraction region `0.15 * nSamples`
 * spans `0.15 * T` seconds of recording whether it was sampled at 1, 2, 10 or
 * 100 Hz. The superseded fixed 15-sample default spanned 1.5 s at 10 Hz and 15 s
 * at 1 Hz, a 100x rescale across cadence. The clamps are the documented exception
 * and are themselves sample counts, so they are cadence-*dependent*: the floor
 * binds below 34 samples and the ceiling above 200, and because those bounds are
 * in samples the duration band they map to differs per cadence. Invariance is
 * exact only for `34 <= nSamples <= 200`; outside it, declare the window.
 */
export function r0WindowSamples(nSamples: number, declared?: number): number {
  if (declared !== undefined && declared > 0) return Math.trunc(declared);
  if (nSamples <= 0) return R0_WINDOW_MIN_SAMPLES;
  const fraction = Math.floor(nSamples * R0_WINDOW_FRACTION);
  return Math.min(R0_WINDOW_MAX_SAMPLES, Math.max(R0_WINDOW_MIN_SAMPLES, fraction));
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export interface ChannelDescriptor {
  id: string;
  unit: string;
  target?: string;
}

export function channelToDict(c: ChannelDescriptor): Record<string, JsonValue> {
  return { id: c.id, unit: c.unit, ...(c.target ? { target: c.target } : {}) };
}

export function channelFromDict(d: Record<string, JsonValue>): ChannelDescriptor {
  return { id: d["id"] as string, unit: (d["unit"] as string) ?? "", target: d["target"] as string | undefined };
}

export interface DeviceDescriptor {
  model?: string;
  serial?: string;
  firmware?: string;
}

export function deviceToDict(d: DeviceDescriptor | undefined): Record<string, JsonValue> | undefined {
  if (!d) return undefined;
  const out: Record<string, JsonValue> = {};
  if (d.model !== undefined) out["model"] = d.model;
  if (d.serial !== undefined) out["serial"] = d.serial;
  if (d.firmware !== undefined) out["firmware"] = d.firmware;
  return Object.keys(out).length ? out : undefined;
}

export function deviceFromDict(d: Record<string, JsonValue> | undefined): DeviceDescriptor | undefined {
  if (!d) return undefined;
  return {
    model: d["model"] as string | undefined,
    serial: d["serial"] as string | undefined,
    firmware: d["firmware"] as string | undefined,
  };
}

export interface CalibrationDescriptor {
  a: number;
  b: number;
  referenceSubstance?: string;
  referencePpm?: number;
  date?: string;
  method?: string;
}

export function calibrationToDict(c: CalibrationDescriptor): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { a: c.a, b: c.b };
  if (c.referenceSubstance !== undefined) out["referenceSubstance"] = c.referenceSubstance;
  if (c.referencePpm !== undefined) out["referencePpm"] = c.referencePpm;
  if (c.date !== undefined) out["date"] = c.date;
  if (c.method !== undefined) out["method"] = c.method;
  return out;
}

export function calibrationFromDict(d: Record<string, JsonValue>): CalibrationDescriptor {
  return {
    a: Number(d["a"]),
    b: Number(d["b"]),
    referenceSubstance: d["referenceSubstance"] as string | undefined,
    referencePpm: (d["referencePpm"] as number | undefined)?.valueOf(),
    date: d["date"] as string | undefined,
    method: d["method"] as string | undefined,
  };
}

export interface SensorDescriptor {
  sensorType: string;
  channels: ChannelDescriptor[];
  device?: DeviceDescriptor;
  samplingRateHz?: number;
  adcBits?: number;
  adcMax?: number;
  timeColumn: string;
  calibration?: Record<string, CalibrationDescriptor>;
}

export function sensorToDict(s: SensorDescriptor): Record<string, JsonValue> {
  const d: Record<string, JsonValue> = {
    sensorType: s.sensorType,
    channels: s.channels.map(channelToDict),
  };
  const device = deviceToDict(s.device);
  if (device) d["device"] = device;
  if (s.samplingRateHz !== undefined) d["samplingRateHz"] = s.samplingRateHz;
  if (s.adcBits !== undefined) d["adcBits"] = s.adcBits;
  if (s.adcMax !== undefined) d["adcMax"] = s.adcMax;
  if (s.calibration) {
    const cal: Record<string, JsonValue> = {};
    for (const cid of Object.keys(s.calibration)) cal[cid] = calibrationToDict(s.calibration[cid]!);
    d["calibration"] = cal;
  }
  d["timeColumn"] = s.timeColumn;
  return d;
}

export function sensorFromDict(d: Record<string, JsonValue>): SensorDescriptor {
  const calibration = d["calibration"] as Record<string, Record<string, JsonValue>> | undefined;
  return {
    sensorType: (d["sensorType"] as string) ?? "mox",
    channels: ((d["channels"] as Record<string, JsonValue>[]) ?? []).map(channelFromDict),
    device: deviceFromDict(d["device"] as Record<string, JsonValue> | undefined),
    samplingRateHz: d["samplingRateHz"] as number | undefined,
    adcBits: d["adcBits"] as number | undefined,
    adcMax: d["adcMax"] as number | undefined,
    timeColumn: (d["timeColumn"] as string) ?? "timestamp_ms",
    calibration: calibration
      ? Object.fromEntries(
          Object.entries(calibration).map(([cid, c]) => [cid, calibrationFromDict(c)]),
        )
      : undefined,
  };
}

export interface SessionDescriptor {
  role: string;
  label?: string;
  groupId?: string;
  recordedAt?: string;
  durationMs?: number;
  notes?: string;
}

export function sessionToDict(s: SessionDescriptor): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  out["role"] = s.role;
  if (s.label !== undefined) out["label"] = s.label;
  if (s.groupId !== undefined) out["groupId"] = s.groupId;
  if (s.recordedAt !== undefined) out["recordedAt"] = s.recordedAt;
  if (s.durationMs !== undefined) out["durationMs"] = s.durationMs;
  if (s.notes !== undefined) out["notes"] = s.notes;
  return out;
}

export function sessionFromDict(d: Record<string, JsonValue> | undefined): SessionDescriptor {
  return {
    role: (d?.["role"] as string) ?? "single",
    label: d?.["label"] as string | undefined,
    groupId: d?.["groupId"] as string | undefined,
    recordedAt: d?.["recordedAt"] as string | undefined,
    durationMs: d?.["durationMs"] as number | undefined,
    notes: d?.["notes"] as string | undefined,
  };
}

export interface BaselineDescriptor {
  source: string;
  file?: string;
  r0Samples?: number;
}

export function baselineToDict(b: BaselineDescriptor): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  out["source"] = b.source;
  if (b.file !== undefined) out["file"] = b.file;
  if (b.r0Samples !== undefined) out["r0Samples"] = b.r0Samples;
  return out;
}

export function baselineFromDict(d: Record<string, JsonValue> | undefined): BaselineDescriptor {
  return {
    source: (d?.["source"] as string) ?? "none",
    file: d?.["file"] as string | undefined,
    r0Samples: d?.["r0Samples"] as number | undefined,
  };
}

export interface OsmellManifest {
  osmell: Record<string, JsonValue>;
  sensor: SensorDescriptor;
  session: SessionDescriptor;
  baseline?: BaselineDescriptor;
  software?: Record<string, JsonValue>;
  extra: Record<string, JsonValue>;
}

export function manifestToDict(m: OsmellManifest): Record<string, JsonValue> {
  const d: Record<string, JsonValue> = { osmell: m.osmell, sensor: sensorToDict(m.sensor) };
  d["session"] = sessionToDict(m.session);
  if (m.baseline) d["baseline"] = baselineToDict(m.baseline);
  if (m.software) d["software"] = m.software;
  Object.assign(d, m.extra);
  return d;
}

export function manifestFromDict(d: Record<string, JsonValue>): OsmellManifest {
  const known = new Set(["osmell", "sensor", "session", "baseline", "software"]);
  return {
    osmell: (d["osmell"] as Record<string, JsonValue>) ?? { formatVersion: OSMELL_FORMAT_VERSION },
    sensor: sensorFromDict((d["sensor"] as Record<string, JsonValue>) ?? {}),
    session: sessionFromDict(d["session"] as Record<string, JsonValue> | undefined),
    baseline: baselineFromDict(d["baseline"] as Record<string, JsonValue> | undefined),
    software: d["software"] as Record<string, JsonValue> | undefined,
    extra: Object.fromEntries(Object.entries(d).filter(([k]) => !known.has(k))),
  };
}

export interface SessionEvent {
  label: string;
  startMs: number;
  endMs?: number;
  note?: string;
}

export function eventToDict(e: SessionEvent): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  out["label"] = e.label;
  out["startMs"] = e.startMs;
  if (e.endMs !== undefined) out["endMs"] = e.endMs;
  if (e.note !== undefined) out["note"] = e.note;
  return out;
}

export function eventFromDict(d: Record<string, JsonValue>): SessionEvent {
  return {
    label: d["label"] as string,
    startMs: Number(d["startMs"]),
    endMs: d["endMs"] as number | undefined,
    note: d["note"] as string | undefined,
  };
}

export interface OsmellFile {
  manifest: OsmellManifest;
  time: number[];
  data: Record<string, number[]>;
  events?: SessionEvent[];
}

export interface ParsedSample {
  time: number;
  values: Record<string, number | undefined>;
}

export interface ChannelStats {
  id: string;
  min: number;
  max: number;
  mean: number;
  std: number;
  r0: number;
  cv: number;
  dead: boolean;
  span: number;
  clipped: number;
  nonFinite: number;
}

export interface QualityFlags {
  deadSensors: string[];
  unsortedRows: boolean;
  nonFiniteSamples: number;
  usedDefaultAdcMax: boolean;
  usedMedianSamplingRate: boolean;
  noBaseline: boolean;
  emptyRecording: boolean;
}

export interface SubScore {
  value?: number;
  reason: string;
}

export interface QualityReport {
  format: string;
  version: string;
  computedAt: string;
  total?: number;
  badge: string;
  subscores: Record<string, SubScore>;
  flags: QualityFlags;
  reasons: Record<string, string>;
  notes: string[];
}