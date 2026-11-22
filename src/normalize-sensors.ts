// Per-sensor-type normalization for OpenSmell v1.1 records.
import type { SensorType } from "./types.js";

export interface SlotState {
  lastAnalogV: number | null;
  lastIntakeAnalogV: number | null;
  saturatedConsecutive: number;
  intakeFlatCount: number;
  lastFrequencyHz: number | null;
  flatFrequencyCount: number;
  warmupSecondsElapsed: number;
}

export interface NormalizedSlot {
  index: number;
  type: SensorType;
  model: string | null;
  eepromId: string | null;
  calibrationDate: string | null;
  interface: "analog_5v" | "i2c_3v3" | "frequency" | "onewire_id";
  warmupSeconds: number;
  state: "warming" | "ready" | "fault";
  readings: {
    analogVolts: number | null;
    digitalValue: number | null;
    frequencyHz: number | null;
    currentUa: number | null;
    ppm: number | null;
    index: number | null;
    ph: number | null;
    unit: string;
    samples?: Array<{ t_ms: number; v: number }>;
  };
  calibration: Record<string, number | string | boolean | null>;
  qcFlags: string[];
  feature: number | null;
}

export interface SensorHandler {
  type: SensorType;
  warmupSeconds: number;
  unit: string;
  interface: "analog_5v" | "i2c_3v3" | "frequency" | "onewire_id";
  normalize(
    index: number,
    raw: any,
    calibration: Record<string, unknown>,
    state: SlotState,
    cyclePhase: string,
    cycleDurationS: number,
  ): { slot: NormalizedSlot; state: SlotState };
}

function defaultState(): SlotState {
  return {
    lastAnalogV: null,
    lastIntakeAnalogV: null,
    saturatedConsecutive: 0,
    intakeFlatCount: 0,
    lastFrequencyHz: null,
    flatFrequencyCount: 0,
    warmupSecondsElapsed: 0,
  };
}

function baseSlot(
  index: number,
  type: SensorType,
  raw: any,
  calibration: Record<string, unknown>,
  iface: "analog_5v" | "i2c_3v3" | "frequency" | "onewire_id",
  warmupSeconds: number,
  stateVal: "warming" | "ready" | "fault",
  readings: NormalizedSlot["readings"],
  feature: number | null,
): NormalizedSlot {
  return {
    index,
    type,
    model: raw?.sensor_model ?? null,
    eepromId: raw?.eeprom_id ?? null,
    calibrationDate: raw?.calibration_date ?? null,
    interface: iface,
    warmupSeconds,
    state: stateVal,
    readings,
    calibration: calibration as Record<string, number | string | boolean | null>,
    qcFlags: [],
    feature,
  };
}

const MOX_WARMUP = 300;
function normalizeMox(
  index: number,
  raw: any,
  calibration: Record<string, unknown>,
  state: SlotState,
  cyclePhase: string,
  cycleDurationS: number,
): { slot: NormalizedSlot; state: SlotState } {
  const av = raw?.readings?.analog_value_v ?? null;
  const r0 = (calibration.r0_ohm as number | undefined) ?? null;
  const loadR = (calibration.load_resistor_ohm as number | undefined) ?? null;
  const next = { ...state };
  next.warmupSecondsElapsed += cycleDurationS;
  let stateVal: "warming" | "ready" | "fault" = "ready";
  if (next.warmupSecondsElapsed < MOX_WARMUP) stateVal = "warming";
  let feature: number | null = null;
  if (av !== null && r0 !== null && loadR !== null && r0 > 0 && loadR > 0) {
    const vcc = 5.0;
    const nodeV = av / 2.0;
    if (nodeV > 0 && nodeV < vcc) {
      const rs = (nodeV / (vcc - nodeV)) * loadR;
      feature = (rs - r0) / r0;
    } else {
      stateVal = "fault";
    }
  } else if (av !== null) {
    feature = av;
  }
  const slot = baseSlot(
    index, "mox", raw, calibration, "analog_5v", MOX_WARMUP, stateVal,
    { analogVolts: av, digitalValue: raw?.readings?.digital_value ?? null,
      frequencyHz: null, currentUa: null, ppm: null, index: null, ph: null,
      unit: raw?.readings?.unit ?? "V", samples: raw?.readings?.samples ?? undefined },
    feature,
  );
  return { slot, state: next };
}

const NDIR_WARMUP = 60;
function normalizeNdir(
  index: number,
  raw: any,
  calibration: Record<string, unknown>,
  state: SlotState,
  cyclePhase: string,
  cycleDurationS: number,
): { slot: NormalizedSlot; state: SlotState } {
  const ppm = raw?.readings?.ppm ?? null;
  const next = { ...state };
  next.warmupSecondsElapsed += cycleDurationS;
  let stateVal: "warming" | "ready" | "fault" = "ready";
  if (next.warmupSecondsElapsed < NDIR_WARMUP) stateVal = "warming";
  if (ppm !== null && (ppm < 0 || ppm > 100000)) stateVal = "fault";
  let feature: number | null = null;
  if (ppm !== null && stateVal === "ready") feature = ppm;
  const slot = baseSlot(
    index, "ndir", raw, calibration, "i2c_3v3", NDIR_WARMUP, stateVal,
    { analogVolts: null, digitalValue: raw?.readings?.digital_value ?? null,
      frequencyHz: null, currentUa: null, ppm, index: null, ph: null,
      unit: raw?.readings?.unit ?? "ppm", samples: raw?.readings?.samples ?? undefined },
    feature,
  );
  return { slot, state: next };
}

const PID_WARMUP = 120;
function normalizePid(
  index: number,
  raw: any,
  calibration: Record<string, unknown>,
  state: SlotState,
  cyclePhase: string,
  cycleDurationS: number,
): { slot: NormalizedSlot; state: SlotState } {
  const av = raw?.readings?.analog_value_v ?? null;
  const ppbRaw = raw?.readings?.ppm ?? null;
  const cf = (calibration.correction_factor as number | undefined) ?? null;
  const next = { ...state };
  next.warmupSecondsElapsed += cycleDurationS;
  let stateVal: "warming" | "ready" | "fault" = "ready";
  if (next.warmupSecondsElapsed < PID_WARMUP) stateVal = "warming";
  let feature: number | null = null;
  if (ppbRaw !== null) {
    feature = ppbRaw;
  } else if (av !== null && cf !== null) {
    feature = av * 1000 * cf;
  } else if (av !== null) {
    feature = av;
    stateVal = "warming";
  }
  const slot = baseSlot(
    index, "pid", raw, calibration, "analog_5v", PID_WARMUP, stateVal,
    { analogVolts: av, digitalValue: raw?.readings?.digital_value ?? null,
      frequencyHz: null, currentUa: null, ppm: null, index: null, ph: null,
      unit: raw?.readings?.unit ?? "V", samples: raw?.readings?.samples ?? undefined },
    feature,
  );
  return { slot, state: next };
}

const EC_WARMUP = 90;
function normalizeElectrochemical(
  index: number,
  raw: any,
  calibration: Record<string, unknown>,
  state: SlotState,
  cyclePhase: string,
  cycleDurationS: number,
): { slot: NormalizedSlot; state: SlotState } {
  const currentUa = raw?.readings?.current_ua ?? null;
  const sens = (calibration.sensitivity_nA_per_ppm as number | undefined) ?? null;
  const offset = (calibration.zero_offset_ua as number | undefined) ?? 0;
  const next = { ...state };
  next.warmupSecondsElapsed += cycleDurationS;
  let stateVal: "warming" | "ready" | "fault" = "ready";
  if (next.warmupSecondsElapsed < EC_WARMUP) stateVal = "warming";
  let feature: number | null = null;
  if (currentUa !== null && sens !== null && sens !== 0) {
    feature = (currentUa * 1000 - offset) / sens;
  }
  const slot = baseSlot(
    index, "electrochemical", raw, calibration, "analog_5v", EC_WARMUP, stateVal,
    { analogVolts: raw?.readings?.analog_value_v ?? null,
      digitalValue: raw?.readings?.digital_value ?? null,
      frequencyHz: null, currentUa, ppm: null, index: null, ph: null,
      unit: raw?.readings?.unit ?? "V", samples: raw?.readings?.samples ?? undefined },
    feature,
  );
  return { slot, state: next };
}

const GALV_WARMUP = 60;
function normalizeGalvanic(
  index: number,
  raw: any,
  calibration: Record<string, unknown>,
  state: SlotState,
  cyclePhase: string,
  cycleDurationS: number,
): { slot: NormalizedSlot; state: SlotState } {
  const currentUa = raw?.readings?.current_ua ?? null;
  const sens = (calibration.sensitivity_nA_per_ppm as number | undefined) ?? null;
  const offset = (calibration.zero_offset_ua as number | undefined) ?? 0;
  const next = { ...state };
  next.warmupSecondsElapsed += cycleDurationS;
  let stateVal: "warming" | "ready" | "fault" = "ready";
  if (next.warmupSecondsElapsed < GALV_WARMUP) stateVal = "warming";
  let feature: number | null = null;
  if (currentUa !== null && sens !== null && sens !== 0) {
    feature = (currentUa * 1000 - offset) / sens;
  }
  const slot = baseSlot(
    index, "galvanic", raw, calibration, "analog_5v", GALV_WARMUP, stateVal,
    { analogVolts: raw?.readings?.analog_value_v ?? null,
      digitalValue: raw?.readings?.digital_value ?? null,
      frequencyHz: null, currentUa, ppm: null, index: null, ph: null,
      unit: raw?.readings?.unit ?? "V", samples: raw?.readings?.samples ?? undefined },
    feature,
  );
  return { slot, state: next };
}

const QCM_WARMUP = 120;
function normalizeQcm(
  index: number,
  raw: any,
  calibration: Record<string, unknown>,
  state: SlotState,
  cyclePhase: string,
  cycleDurationS: number,
): { slot: NormalizedSlot; state: SlotState } {
  const f = raw?.readings?.frequency_hz ?? null;
  const f0 = (calibration.baseline_frequency_hz as number | undefined) ?? null;
  const next = { ...state };
  next.warmupSecondsElapsed += cycleDurationS;
  let stateVal: "warming" | "ready" | "fault" = "ready";
  if (next.warmupSecondsElapsed < QCM_WARMUP) stateVal = "warming";
  if (
    f !== null && state.lastFrequencyHz !== null && Math.abs(f - state.lastFrequencyHz) < 0.001
  ) {
    next.flatFrequencyCount += 1;
    if (next.flatFrequencyCount >= 2) stateVal = "fault";
  } else {
    next.flatFrequencyCount = 0;
  }
  let feature: number | null = null;
  if (f !== null && f0 !== null && stateVal === "ready") {
    feature = f - f0;
  } else if (f !== null) {
    feature = f;
  }
  next.lastFrequencyHz = f;
  const slot = baseSlot(
    index, "qcm", raw, calibration, "frequency", QCM_WARMUP, stateVal,
    { analogVolts: null, digitalValue: null, frequencyHz: f,
      currentUa: null, ppm: null, index: null, ph: null,
      unit: raw?.readings?.unit ?? "Hz", samples: raw?.readings?.samples ?? undefined },
    feature,
  );
  return { slot, state: next };
}

const SAW_WARMUP = 120;
function normalizeSaw(
  index: number,
  raw: any,
  calibration: Record<string, unknown>,
  state: SlotState,
  cyclePhase: string,
  cycleDurationS: number,
): { slot: NormalizedSlot; state: SlotState } {
  const f = raw?.readings?.frequency_hz ?? null;
  const f0 = (calibration.baseline_frequency_hz as number | undefined) ?? null;
  const next = { ...state };
  next.warmupSecondsElapsed += cycleDurationS;
  let stateVal: "warming" | "ready" | "fault" = "ready";
  if (next.warmupSecondsElapsed < SAW_WARMUP) stateVal = "warming";
  if (
    f !== null && state.lastFrequencyHz !== null && Math.abs(f - state.lastFrequencyHz) < 0.001
  ) {
    next.flatFrequencyCount += 1;
    if (next.flatFrequencyCount >= 2) stateVal = "fault";
  } else {
    next.flatFrequencyCount = 0;
  }
  let feature: number | null = null;
  if (f !== null && f0 !== null && stateVal === "ready") {
    feature = f - f0;
  } else if (f !== null) {
    feature = f;
  }
  next.lastFrequencyHz = f;
  const slot = baseSlot(
    index, "saw", raw, calibration, "frequency", SAW_WARMUP, stateVal,
    { analogVolts: null, digitalValue: null, frequencyHz: f,
      currentUa: null, ppm: null, index: null, ph: null,
      unit: raw?.readings?.unit ?? "Hz", samples: raw?.readings?.samples ?? undefined },
    feature,
  );
  return { slot, state: next };
}

const PH_WARMUP = 60;
function normalizePhIsfet(
  index: number,
  raw: any,
  calibration: Record<string, unknown>,
  state: SlotState,
  cyclePhase: string,
  cycleDurationS: number,
): { slot: NormalizedSlot; state: SlotState } {
  const av = raw?.readings?.analog_value_v ?? null;
  const offset = (calibration.ph_offset_mv as number | undefined) ?? null;
  const slope = (calibration.ph_slope_mv_per_ph as number | undefined) ?? null;
  const next = { ...state };
  next.warmupSecondsElapsed += cycleDurationS;
  let stateVal: "warming" | "ready" | "fault" = "ready";
  if (next.warmupSecondsElapsed < PH_WARMUP) stateVal = "warming";
  let feature: number | null = null;
  if (av !== null && offset !== null && slope !== null && slope !== 0) {
    const mv = av * 1000;
    feature = (mv - offset) / slope;
    if (feature < 0 || feature > 14) {
      stateVal = "fault";
      feature = null;
    }
  } else if (av !== null) {
    feature = av;
  }
  const slot = baseSlot(
    index, "phIsfet", raw, calibration, "analog_5v", PH_WARMUP, stateVal,
    { analogVolts: av, digitalValue: raw?.readings?.digital_value ?? null,
      frequencyHz: null, currentUa: null, ppm: null, index: null, ph: feature,
      unit: raw?.readings?.unit ?? "V", samples: raw?.readings?.samples ?? undefined },
    feature,
  );
  return { slot, state: next };
}

const ENV_WARMUP = 10;
function normalizeEnvTrh(
  index: number,
  raw: any,
  calibration: Record<string, unknown>,
  state: SlotState,
  cyclePhase: string,
  cycleDurationS: number,
): { slot: NormalizedSlot; state: SlotState } {
  const tempC = raw?.readings?.analog_value_v ?? null;
  const rhPct = raw?.readings?.digital_value ?? null;
  const next = { ...state };
  next.warmupSecondsElapsed += cycleDurationS;
  let stateVal: "warming" | "ready" | "fault" = "ready";
  if (next.warmupSecondsElapsed < ENV_WARMUP) stateVal = "warming";
  if (tempC !== null && (tempC < -50 || tempC > 150)) stateVal = "fault";
  if (rhPct !== null && (rhPct < 0 || rhPct > 100)) stateVal = "fault";
  let feature: number | null = null;
  if (tempC !== null) feature = tempC;
  else if (rhPct !== null) feature = rhPct;
  const slot = baseSlot(
    index, "envTrh", raw, calibration, "i2c_3v3", ENV_WARMUP, stateVal,
    { analogVolts: tempC, digitalValue: rhPct,
      frequencyHz: null, currentUa: null, ppm: null, index: null, ph: null,
      unit: raw?.readings?.unit ?? "°C / %RH", samples: raw?.readings?.samples ?? undefined },
    feature,
  );
  return { slot, state: next };
}

const MEMS_WARMUP = 30;
function normalizeMems(
  index: number,
  raw: any,
  calibration: Record<string, unknown>,
  state: SlotState,
  cyclePhase: string,
  cycleDurationS: number,
): { slot: NormalizedSlot; state: SlotState } {
  const idx = raw?.readings?.index ?? null;
  const ppm = raw?.readings?.ppm ?? null;
  const next = { ...state };
  next.warmupSecondsElapsed += cycleDurationS;
  let stateVal: "warming" | "ready" | "fault" = "ready";
  if (next.warmupSecondsElapsed < MEMS_WARMUP) stateVal = "warming";
  let feature: number | null = null;
  if (idx !== null) feature = idx;
  else if (ppm !== null) feature = ppm;
  const slot = baseSlot(
    index, "mems", raw, calibration, "i2c_3v3", MEMS_WARMUP, stateVal,
    { analogVolts: null, digitalValue: raw?.readings?.digital_value ?? null,
      frequencyHz: null, currentUa: null, ppm: null, index: idx,
      ph: null, unit: raw?.readings?.unit ?? "idx", samples: raw?.readings?.samples ?? undefined },
    feature,
  );
  return { slot, state: next };
}

const UNKNOWN_WARMUP = 600;
function normalizeUnknown(
  index: number,
  raw: any,
  calibration: Record<string, unknown>,
  state: SlotState,
  cyclePhase: string,
  cycleDurationS: number,
): { slot: NormalizedSlot; state: SlotState } {
  const av = raw?.readings?.analog_value_v ?? null;
  const dv = raw?.readings?.digital_value ?? null;
  const next = { ...state };
  next.warmupSecondsElapsed += cycleDurationS;
  let stateVal: "warming" | "ready" | "fault" = "warming";
  let feature: number | null = null;
  if (dv !== null) feature = dv;
  else if (av !== null) feature = av;
  const slot = baseSlot(
    index, "unknown", raw, calibration, "analog_5v", UNKNOWN_WARMUP, stateVal,
    { analogVolts: av, digitalValue: dv, frequencyHz: null,
      currentUa: null, ppm: null, index: null, ph: null,
      unit: raw?.readings?.unit ?? "raw", samples: raw?.readings?.samples ?? undefined },
    feature,
  );
  return { slot, state: next };
}

export const SENSOR_HANDLERS: Record<SensorType, SensorHandler> = {
  mox: { type: "mox", warmupSeconds: MOX_WARMUP, unit: "ΔR/R₀",
    interface: "analog_5v", normalize: normalizeMox },
  electrochemical: { type: "electrochemical", warmupSeconds: EC_WARMUP,
    unit: "ppm", interface: "analog_5v", normalize: normalizeElectrochemical },
  ndir: { type: "ndir", warmupSeconds: NDIR_WARMUP, unit: "ppm",
    interface: "i2c_3v3", normalize: normalizeNdir },
  pas: { type: "pas", warmupSeconds: 30, unit: "ppb", interface: "i2c_3v3",
    normalize: normalizeNdir },
  pid: { type: "pid", warmupSeconds: PID_WARMUP, unit: "ppb",
    interface: "analog_5v", normalize: normalizePid },
  galvanic: { type: "galvanic", warmupSeconds: GALV_WARMUP,
    unit: "% O₂", interface: "analog_5v", normalize: normalizeGalvanic },
  catalyticBead: { type: "catalyticBead", warmupSeconds: 90,
    unit: "% LEL", interface: "analog_5v", normalize: normalizeElectrochemical },
  qcm: { type: "qcm", warmupSeconds: QCM_WARMUP, unit: "Δf Hz",
    interface: "frequency", normalize: normalizeQcm },
  saw: { type: "saw", warmupSeconds: SAW_WARMUP, unit: "Δf Hz",
    interface: "frequency", normalize: normalizeSaw },
  cantilever: { type: "cantilever", warmupSeconds: 300,
    unit: "Δf Hz", interface: "frequency", normalize: normalizeQcm },
  polymer: { type: "polymer", warmupSeconds: 300, unit: "ΔR/R₀",
    interface: "analog_5v", normalize: normalizeMox },
  solidElectrolyte: { type: "solidElectrolyte", warmupSeconds: 300,
    unit: "% O₂", interface: "analog_5v", normalize: normalizeElectrochemical },
  phIsfet: { type: "phIsfet", warmupSeconds: PH_WARMUP,
    unit: "pH", interface: "analog_5v", normalize: normalizePhIsfet },
  envTrh: { type: "envTrh", warmupSeconds: ENV_WARMUP,
    unit: "°C / %RH", interface: "i2c_3v3", normalize: normalizeEnvTrh },
  mems: { type: "mems", warmupSeconds: MEMS_WARMUP,
    unit: "idx", interface: "i2c_3v3", normalize: normalizeMems },
  miris: { type: "miris", warmupSeconds: UNKNOWN_WARMUP,
    unit: "raw", interface: "analog_5v", normalize: normalizeUnknown },
  other: { type: "other", warmupSeconds: UNKNOWN_WARMUP,
    unit: "raw", interface: "analog_5v", normalize: normalizeUnknown },
  unknown: { type: "unknown", warmupSeconds: UNKNOWN_WARMUP,
    unit: "raw", interface: "analog_5v", normalize: normalizeUnknown },
};

export function getHandler(type: string): SensorHandler {
  const t = type as SensorType;
  return SENSOR_HANDLERS[t] ?? SENSOR_HANDLERS.unknown;
}

export function normalizeSlot(
  index: number,
  raw: any,
  state: SlotState,
  cyclePhase: string,
  cycleDurationS: number,
): { slot: NormalizedSlot; state: SlotState } {
  const handler = getHandler(raw?.sensor_type);
  return handler.normalize(index, raw ?? {}, raw?.calibration ?? {}, state, cyclePhase, cycleDurationS);
}

export { defaultState };
