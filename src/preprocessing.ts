import { parseCsv } from "./csv.js";

export const SENSOR_NAMES = ["NO2", "C2H5OH", "VOC", "CO", "Alcohol", "LPG"];
export const MQ6_COLS = ["MQ135", "MQ3", "MQ6", "MQ7", "MQ4", "MQ8"];

export const WINDOW_SIZE = 100;
export const WINDOW_STRIDE = 10;

export function rsR0Normalize(arr: number[][], r0Frac = 0.15): number[][] {
  const nBaseline = Math.max(5, Math.floor((arr.length * r0Frac)));
  const r0: number[] = [];
  for (let c = 0; c < arr[0]!.length; c++) {
    const window = arr.slice(0, nBaseline).map((row) => row[c]!);
    const med = medianOfRaw(window);
    r0.push(med < 1 ? 1 : med);
  }
  return arr.map((row) => row.map((v, c) => (v - r0[c]!) / r0[c]!));
}

export function expandChannels(arr: number[][], nTarget = 6, mapping?: [number, number][]): number[][] {
  const out = Array.from({ length: arr.length }, () => new Array<number>(nTarget).fill(0));
  if (mapping) {
    for (const [source, target] of mapping) {
      if (source < arr.length && source < (arr[0]?.length ?? 0) && target < nTarget) {
        for (let r = 0; r < arr.length; r++) out[r]![target] = arr[r]![source]!;
      }
    }
    return out;
  }
  const n = Math.min(arr.length ? arr[0]!.length : 0, nTarget);
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < arr.length; r++) out[r]![c] = arr[r]![c]!;
  }
  return out;
}

/** Split an array into fixed windows with stride; pads short arrays by edge-repeat. */
export function segment(sensorArray: number[][], windowSize = WINDOW_SIZE, stride = WINDOW_STRIDE): number[][][] {
  const n = sensorArray.length;
  const nCh = sensorArray[0]?.length ?? 0;
  if (n >= windowSize) {
    const segments: number[][][] = [];
    for (let i = 0; i <= n - windowSize; i += stride) {
      segments.push(sensorArray.slice(i, i + windowSize));
    }
    return segments;
  }
  const padded = [...sensorArray];
  while (padded.length < windowSize) padded.push(sensorArray[sensorArray.length - 1] ?? new Array(nCh).fill(0));
  return [padded.slice(0, windowSize)];
}

/** Load a CSV text blob, detect sensor columns, and return the channel matrix. */
export function loadCsv(
  text: string,
  sensorMap?: Record<string, string>,
): { matrix: number[][]; headers: string[] } {
  const parsed = parseCsv(text);
  let headers = [...parsed.header];
  if (sensorMap) headers = headers.map((h) => sensorMap[h] ?? h);

  const cols = detectSensorColumns(headers);
  if (cols.some((c) => c === undefined)) {
    const missing = cols.map((c, i) => (c === undefined ? SENSOR_NAMES[i] : null)).filter(Boolean);
    throw new Error(
      `Could not detect sensor columns in CSV. Missing after mapping: ${missing.join(", ")}. ` +
        `Expected one of ${SENSOR_NAMES.join(", ")}. Found columns: ${headers.join(", ")}.`,
    );
  }
  const names = cols as string[];
  const idx = names.map((c) => headers.indexOf(c));
  const matrix = parsed.samples.map((s) => idx.map((i) => s.values[headers[i]!] ?? NaN));
  return { matrix, headers: names };
}

function detectSensorColumns(columns: string[]): (string | undefined)[] {
  const cols: (string | undefined)[] = [];
  for (const expected of SENSOR_NAMES) {
    const found = columns.filter((c) => c.toLowerCase() === expected.toLowerCase());
    cols.push(found[0]);
  }
  if (cols.some((c) => c === undefined)) {
    const fallback = columns.filter((c) => c.toLowerCase().startsWith("sensor_"));
    if (fallback.length >= 6) return fallback.slice(0, 6);
    const mqCols = columns.filter((c) =>
      MQ6_COLS.some((m) => c.toLowerCase() === m.toLowerCase()),
    );
    if (mqCols.length >= 6) return mqCols.slice(0, 6);
  }
  return cols;
}

function medianOfRaw(window: number[]): number {
  const sorted = [...window].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}