// HIL test: verify each sensor type normalizes correctly through opensmell-js pipeline.
import {
  getHandler,
  defaultState,
  type NormalizedSlot,
  type SlotState,
} from '../dist/normalize-sensors.js'

const results: Array<{ type: string; pass: boolean; error?: string }> = []

function testType(
  name: string,
  raw: any,
  cal: Record<string, unknown>,
  expectedFeature: number | null,
  expectedState: 'warming' | 'ready' | 'fault',
) {
  const state = defaultState()
  state.warmupSecondsElapsed = 1000
  const { slot, state: nextState } = getHandler(raw?.sensor_type).normalize(
    0, raw, cal, state, 'hold', 10.0,
  )
  const featureMatch =
    slot.feature === expectedFeature ||
    (slot.feature !== null && expectedFeature !== null &&
      Math.abs(slot.feature - expectedFeature) < 0.001)
  const pass = featureMatch && slot.state === expectedState
  results.push({ type: name, pass,
    error: pass ? undefined : `feature=${slot.feature} expected=${expectedFeature} state=${slot.state} expected=${expectedState}` })
}

// MOX: V=1.5V, R0=10k, loadR=10k => Rs=(0.75/4.25)*10k≈1764.7, ΔR/R0≈-0.8235
testType('MOX',
  { sensor_type: 'mox', sensor_model: 'MQ-135', readings: { analog_value_v: 1.5, unit: 'V' } },
  { r0_ohm: 10000, load_resistor_ohm: 10000 },
  -0.8235, 'ready')

// NDIR: ppm=450
testType('NDIR',
  { sensor_type: 'ndir', sensor_model: 'SCD40', readings: { ppm: 450, unit: 'ppm' } },
  {},
  450, 'ready')

// PID: mV=0.2, CF=1.2 => ppb = 0.2*1000*1.2 = 240
testType('PID',
  { sensor_type: 'pid', sensor_model: 'MiniPID', readings: { analog_value_v: 0.2, unit: 'V' } },
  { correction_factor: 1.2 },
  240, 'ready')

// QCM: f=10000000, f0=9999900 => Δf=100
testType('QCM',
  { sensor_type: 'qcm', sensor_model: 'QCM-1', readings: { frequency_hz: 10000000, unit: 'Hz' } },
  { baseline_frequency_hz: 9999900 },
  100, 'ready')

// pH_ISFET: V=0.414 (414mV), offset=0, slope=-59.16 => pH=-7.0 (out of range => fault)
testType('pH_ISFET',
  { sensor_type: 'phIsfet', sensor_model: 'ISFET-pH', readings: { analog_value_v: 0.414, unit: 'V' } },
  { ph_offset_mv: 0, ph_slope_mv_per_ph: -59.16 },
  null, 'fault')

// Electrochemical: current=100µA, sens=10nA/ppm => 10000ppm
testType('Electrochemical',
  { sensor_type: 'electrochemical', sensor_model: 'EC-CO', readings: { current_ua: 100, unit: 'µA' } },
  { sensitivity_nA_per_ppm: 10, zero_offset_ua: 0 },
  10000, 'ready')

// MEMS: index=350
testType('MEMS',
  { sensor_type: 'mems', sensor_model: 'SGP40', readings: { index: 350, unit: 'idx' } },
  {},
  350, 'ready')

// Unknown type (no EEPROM)
testType('unknown',
  { sensor_type: 'unknown', sensor_model: null, readings: { analog_value_v: 1.2, unit: 'V' } },
  {},
  1.2, 'warming')

let allPass = true
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.type}`)
  if (!r.pass) {
    allPass = false
    console.log(`  ERROR: ${r.error}`)
  }
}
console.log(`\n${allPass ? 'ALL PASS' : 'SOME FAILED'}`)
process.exit(allPass ? 0 : 1)
