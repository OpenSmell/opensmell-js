// Real-data ingestion test for opensmell-js multi-type CSV parsing.
// Ingests real local datasets and classifies each channel by sensor type.
import { parseCsv, classifyChannel, SENSOR_TYPE_SIGNATURES } from '../dist/csv.js';
import { buildOsmellFile } from '../dist/ingest.js';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(process.cwd(), '..');
const REAL_DATASETS = [
  { name: 'tadi_2019/Logger_A.csv (methane MOX + env)', file: path.join(REPO_ROOT, 'datasets/tadi_2019/Logger_A.csv') },
  { name: 'woerner_2025/D02_Phenylethanol_1000ppm_2.csv (60-MOX VOC)', file: path.join(REPO_ROOT, 'datasets/woerner_2025/csv/D02_Phenylethanol_1000ppm_2.csv') },
  { name: 'winesmell/merged.csv (13-ZnO wine)', file: path.join(REPO_ROOT, 'smell-monitor/datasets/fermentation/winesmell/data/raw/merged.csv') },
];

console.log('=== SENSOR TYPE SIGNATURES (17 types) ===');
for (const sig of SENSOR_TYPE_SIGNATURES) {
  console.log(`  ${sig.type.padEnd(20)} | ${sig.unit.padEnd(8)} | ${sig.interface.padEnd(10)} | ${sig.description}`);
}

console.log('\n=== REAL DATASET CLASSIFICATION ===');
for (const ds of REAL_DATASETS) {
  if (!fs.existsSync(ds.file)) {
    console.log(`\n[MISSING] ${ds.name} -> ${ds.file}`);
    continue;
  }
  const text = fs.readFileSync(ds.file, 'utf8');
  const parsed = parseCsv(text);
  console.log(`\n[${ds.name}]`);
  console.log(`  Rows: ${parsed.rowCount}, Channels: ${parsed.channelIds.length}, Time source: ${parsed.timeSource}, Rate: ${parsed.guessSamplingRateHz.toFixed(1)} Hz`);
  console.log(`  Context columns: ${parsed.contextColumns.join(', ') || 'none'}`);
  console.log(`  Channel classifications:`);
  for (const cid of parsed.channelIds.slice(0, 12)) {
    const cls = parsed.channelTypes[cid] ?? 'unknown';
    const unit = parsed.channelUnits[cid] ?? 'adc';
    const iface = parsed.channelInterfaces[cid] ?? 'analog_5v';
    console.log(`    ${cid.padEnd(12)} -> ${cls.padEnd(18)} | ${unit.padEnd(8)} | ${iface}`);
  }
  if (parsed.channelIds.length > 12) {
    console.log(`    ... and ${parsed.channelIds.length - 12} more channels`);
  }
  if (parsed.warnings.length > 0) {
    console.log(`  Warnings: ${parsed.warnings.join('; ')}`);
  }

  // Build OsmellFile to test full pipeline
  const file = buildOsmellFile(parsed, path.basename(ds.file), 'test', ds.file, 'single');
  console.log(`  Manifest sensorType: ${file.manifest.sensor.sensorType}, channels mapped: ${file.manifest.sensor.channels.length}`);
  for (const ch of file.manifest.sensor.channels.slice(0, 6)) {
    console.log(`    Channel ${ch.id}: unit=${ch.unit}, type=${ch.sensorType}, iface=${ch.interface}`);
  }
}

console.log('\n=== CLASSIFYCHANNEL UNIT TESTS ===');
const tests = [
  ['MQ-135', 'mox', 'ohm'],
  ['TGS-2600', 'mox', 'ohm'],
  ['R1', 'mox', 'ohm'],
  ['CO2', 'ndir', 'ppm'],
  ['PID', 'pid', 'ppb'],
  ['H2S', 'electrochemical', 'ppm'],
  ['O2', 'galvanic', '% O2'],
  ['LEL', 'catalyticBead', '% LEL'],
  ['QCM', 'qcm', 'Hz'],
  ['SAW', 'saw', 'Hz'],
  ['cantilever', 'cantilever', 'Hz'],
  ['polymer', 'polymer', 'ohm'],
  ['zirconia', 'solidElectrolyte', '% O2'],
  ['pH', 'phIsfet', 'pH'],
  ['temperature', 'envTrh', 'C / %RH'],
  ['humidity', 'envTrh', 'C / %RH'],
  ['DHT22', 'envTrh', 'C / %RH'],
  ['BME688', 'mems', 'idx'],
  ['SGP40', 'mems', 'idx'],
  ['CCS811', 'mems', 'idx'],
  ['VOC', 'mox', 'ohm'],
  ['CH4', 'mox', 'ohm'],
  ['ZnO', 'mox', 'ohm'],
  ['unknown_col_xyz', 'unknown', 'raw'],
];
let allPass = true;
for (const [col, expType, expUnit] of tests) {
  const cls = classifyChannel(col);
  const pass = cls.type === expType && cls.unit === expUnit;
  if (!pass) allPass = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${col.padEnd(20)} -> ${cls.type.padEnd(18)} ${cls.unit.padEnd(8)} (expected ${expType.padEnd(18)} ${expUnit})`);
}
console.log(`\n${allPass ? 'ALL CLASSIFICATION TESTS PASS' : 'SOME CLASSIFICATION TESTS FAILED'}`);
process.exit(allPass ? 0 : 1);
