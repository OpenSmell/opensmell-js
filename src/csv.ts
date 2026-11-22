import {
  CONTEXT_COLUMN_HINTS,
  DEFAULT_SYNTHETIC_RATE_HZ,
  ParsedSample,
  SensorType,
} from "./types.js";

export interface SensorTypeSignature {
  type: SensorType;
  patterns: RegExp[];
  unit: string;
  interface: "analog_5v" | "i2c_3v3" | "frequency" | "onewire_id";
  description: string;
}

export const SENSOR_TYPE_SIGNATURES: SensorTypeSignature[] = [
  // Environmental context (checked first — temp/RH/pressure are context, not analytes)
  { type: "envTrh", patterns: [/RH/i, /humid/i, /temp/i, /DHT/i, /SHT/i, /BMP/i, /pressure/i, /dew/i, /^T_\d+/i, /^T\d+[^A-Za-z]/i, /^H\d+[^A-Za-z]/i], unit: "C / %RH", interface: "i2c_3v3", description: "Temperature / humidity / pressure context" },
  // NDIR — digital CO2 / IR gases
  { type: "ndir", patterns: [/CO2|CO₂|NDIR|infrared/i], unit: "ppm", interface: "i2c_3v3", description: "Non-dispersive infrared" },
  // PAS — photoacoustic
  { type: "pas", patterns: [/PAS|photoacoustic/i], unit: "ppb", interface: "i2c_3v3", description: "Photoacoustic spectroscopy" },
  // PID — photoionization
  { type: "pid", patterns: [/PID|photoionization/i], unit: "ppb", interface: "analog_5v", description: "Photoionization detector" },
  // Electrochemical — specific toxics
  { type: "electrochemical", patterns: [/EC[-_]/i, /electrochemical/i, /^(H2S|SO2|NO2|O3|Cl2|NH3|HCHO|C2H4|Ethylene|Formaldehyde)$/i], unit: "ppm", interface: "analog_5v", description: "Electrochemical cell" },
  // Galvanic — oxygen
  { type: "galvanic", patterns: [/galvanic/i, /^(O2|O₂|Oxygen)$/i], unit: "% O2", interface: "analog_5v", description: "Galvanic fuel cell (O2)" },
  // Catalytic bead — combustibles
  { type: "catalyticBead", patterns: [/LEL|combustible|catalytic|pellistor/i], unit: "% LEL", interface: "analog_5v", description: "Catalytic bead / pellistor" },
  // QCM — frequency
  { type: "qcm", patterns: [/QCM|quartz\.crystal/i], unit: "Hz", interface: "frequency", description: "Quartz crystal microbalance" },
  // SAW — frequency
  { type: "saw", patterns: [/SAW|surface\.acoustic/i], unit: "Hz", interface: "frequency", description: "Surface acoustic wave" },
  // Cantilever — frequency
  { type: "cantilever", patterns: [/cantilever/i], unit: "Hz", interface: "frequency", description: "Microcantilever" },
  // Polymer — resistance
  { type: "polymer", patterns: [/polymer|chemiresist/i], unit: "ohm", interface: "analog_5v", description: "Conducting polymer" },
  // Solid electrolyte — high-temp O2/CO2
  { type: "solidElectrolyte", patterns: [/zirconia|solid.electrolyte/i], unit: "% O2", interface: "analog_5v", description: "Solid electrolyte (zirconia)" },
  // pH ISFET — liquid pH
  { type: "phIsfet", patterns: [/pH|ISFET/i], unit: "pH", interface: "analog_5v", description: "pH ISFET (liquid)" },
  // MEMS — digital index
  { type: "mems", patterns: [/BME|SGP|CCS|MEMS|VOC\.index|IAQ/i], unit: "idx", interface: "i2c_3v3", description: "MEMS digital sensor" },
  // Miris
  { type: "miris", patterns: [/miris/i], unit: "raw", interface: "analog_5v", description: "Miris sensor" },
  // MOX — resistance-based, heated (broad catch-all, checked last)
  { type: "mox", patterns: [/^(MQ|TGS|MICS|ZnO|SnO2|WO3|In2O3)/i, /^(R\d+)$/, /^(26\d\d|TGS\d+)/i, /^(VOC|Alcohol|LPG|Methane|Ammonia|Hydrogen|Butane|Propane|CH4)$/i, /CO$/i], unit: "ohm", interface: "analog_5v", description: "Metal-oxide semiconductor (resistance)" },
  // other / unknown fallbacks
  { type: "other", patterns: [], unit: "raw", interface: "analog_5v", description: "Other / unspecified sensor" },
  { type: "unknown", patterns: [], unit: "raw", interface: "analog_5v", description: "Unknown sensor type" },
];

/** Classify a single column name into a sensor type, unit, and interface. */
export function classifyChannel(columnName: string): { type: SensorType; unit: string; interface: "analog_5v" | "i2c_3v3" | "frequency" | "onewire_id"; confidence: number } {
  const n = columnName.trim();
  let best: { type: SensorType; unit: string; interface: "analog_5v" | "i2c_3v3" | "frequency" | "onewire_id"; confidence: number } | undefined;

  for (const sig of SENSOR_TYPE_SIGNATURES) {
    for (const pat of sig.patterns) {
      if (pat.test(n)) {
        // More specific patterns (more characters in the regex source) score higher.
        const confidence = pat.source.length;
        if (!best || confidence > best.confidence) {
          best = { type: sig.type, unit: sig.unit, interface: sig.interface, confidence };
        }
      }
    }
  }

  if (!best) return { type: "unknown", unit: "raw", interface: "analog_5v", confidence: 0 };
  return best;
}

/** Guess the overall file sensor type from channel classifications (dominant type). */
export function guessSensorType(header: string[]): string {
  const sensorCols = header.filter((h) => !isContextColumn(h));
  if (sensorCols.length === 0) return "unknown";
  const counts: Record<string, number> = {};
  for (const c of sensorCols) {
    const t = classifyChannel(c).type;
    counts[t] = (counts[t] ?? 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (sorted[0]?.[0] as SensorType) ?? "unknown";
}

/** MOX channel IDs retained for backward compatibility. */
export const MOX_CHANNEL_IDS = ["VOC", "Alcohol", "LPG", "CO", "NO2", "C2H5OH"];

/**
 * Nominal cadence used to synthesize timestamps when a CSV carries no readable
 * time column (and the manifest-import fallback provides no rate either).
 * This is an explicit, documented assumption — 10 Hz device firmware is the
 * historical default, and ~1 Hz SmellNet uploads would get 10× time features.
 * Real time columns and manifests with a declared `samplingRateHz` always take
 * precedence; this constant only drives the synthetic fallback path.
 */
const SYNTHETIC_REFERENCE_HZ = DEFAULT_SYNTHETIC_RATE_HZ;

export interface CsvParseResult {
  header: string[];
  timeColumn?: string;
  timeSource: "column" | "synthetic";
  syntheticRateHz: number;
  samples: ParsedSample[];
  rowCount: number;
  channelIds: string[];
  contextColumns: string[];
  skippedColumns: string[];
  guessSamplingRateHz: number;
  nonFinite: number;
  unsorted: boolean;
  query?: string;
  warnings: string[];
  /** Per-channel classified sensor type. */
  channelTypes: Record<string, SensorType>;
  /** Per-channel engineering unit. */
  channelUnits: Record<string, string>;
  /** Per-channel electrical interface. */
  channelInterfaces: Record<string, "analog_5v" | "i2c_3v3" | "frequency" | "onewire_id">;
}

function parseRow(raw: string, delim: string | RegExp = ","): string[] {
  if (delim instanceof RegExp) {
    return raw.split(delim).map((s) => s.trim()).filter((s) => s.length > 0);
  }
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '"') {
      if (inQuotes && i + 1 < raw.length && raw[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === delim && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += c;
    }
    i += 1;
  }
  cells.push(current);
  return cells;
}

type TimeColumnInfo = [string, string] | undefined;

function detectTimeColumnInfo(header: string[]): TimeColumnInfo {
  for (const raw of header) {
    const n = raw.toLowerCase().trim().replace(/[()[\]{}]/g, "").replace(/\s+/g, "");
    if (/^(timestamp|elapsed)(_ms)?$/.test(n)) return [raw, "ms"];
    if (/^time(_ms)?$/.test(n)) return [raw, "ms"];
    if (/^time(_s|s)$/.test(n)) return [raw, "s"];
    if (/^synthetic_index$/.test(n)) return [raw, "ms"];
  }
  return undefined;
}

export function detectTimeColumn(header: string[]): string | undefined {
  const info = detectTimeColumnInfo(header);
  return info?.[0];
}

function detectDelimiter(sampleLine: string): string | RegExp {
  let best = ",";
  let bestCount = 0;
  for (const c of [",", ";", "\t", "|"]) {
    const count = sampleLine.split(c).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  // No standard delimiter found but line has whitespace → whitespace-delimited
  if (bestCount === 0 && /\s/.test(sampleLine)) {
    return /\s+/;
  }
  return best;
}

function isoToMs(s: string): number | undefined {
  const text = s.replace("Z", "+00:00");
  try {
    if (text.includes("T") || text.includes(" ")) {
      const sep = text.includes("T") ? "T" : " ";
      const datePart = text.split(sep)[0]!;
      let timePart = text.includes(sep) ? text.slice(text.indexOf(sep) + 1) : "";
      timePart = timePart.split("+")[0]!.split("-")[0]!.trim();
      if (timePart) {
        const ms = Date.parse(`${datePart}T${timePart}`);
        if (Number.isNaN(ms)) return undefined;
        return ms;
      }
      const ms = Date.parse(datePart);
      if (Number.isNaN(ms)) return undefined;
      return ms;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseTimeValue(raw: string, unit: string): number | undefined {
  const s = raw.trim();
  if (!s) return undefined;

  const n = safeFloat(s);
  if (n !== undefined) return unit === "s" ? n * 1000 : n;

  const iso = isoToMs(s);
  if (iso !== undefined) return iso;

  const clock = /^(\d{1,3}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?$/.exec(s);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    const sec = Number(clock[3]);
    const fracRaw = clock[4] ?? "";
    if (m < 60 && sec < 60) {
      const frac = fracRaw ? Number(fracRaw) / 10 ** fracRaw.length : 0;
      return (h * 3600 + m * 60 + sec) * 1000 + frac * 1000;
    }
  }
  return undefined;
}

export function safeFloat(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const v = Number(raw);
  return Number.isNaN(v) ? undefined : v;
}

export function isContextColumn(name: string): boolean {
  const n = name.toLowerCase();
  return CONTEXT_COLUMN_HINTS.some((hint) => n.includes(hint));
}


export function parseCsv(text: string): CsvParseResult {
  const warnings: string[] = [];
  const rawRows = text.split(/\r?\n/);
  const rows = rawRows
    .map((r) => r.trim())
    .filter((r) => r.length > 0 && !r.startsWith("#"));

  if (rows.length === 0) throw new Error("The CSV file is empty.");
  if (rows.length === 1) throw new Error("The CSV has a header but no data rows.");

  const delim = detectDelimiter(rows[1]!);
  if (delim !== ",") {
    warnings.push(
      `Detected "${delim}"-delimited values; parsed accordingly. Convert to comma-delimited CSV for widest tool compatibility.`,
    );
  }

  const header = parseRow(rows[0]!, delim).map((h) => h.trim().replace(/\[.*?\]/g, "").trim());
  if (header.length === 0) throw new Error("The CSV has no columns.");

  const timeInfo = detectTimeColumnInfo(header);
  let timeCol: string | undefined = timeInfo?.[0];
  const timeUnit: string = timeInfo?.[1] ?? "ms";
  let timeSource: "column" | "synthetic" = timeCol !== undefined ? "column" : "synthetic";
  let syntheticRateHz = timeSource === "synthetic" ? SYNTHETIC_REFERENCE_HZ : 0;
  if (timeSource === "synthetic") {
    warnings.push(
      `No time column found (expected timestamp_ms or elapsed_ms); synthesized ${SYNTHETIC_REFERENCE_HZ} Hz timing from row index (named constant SYNTHETIC_REFERENCE_HZ in csv.ts). Add a timestamp column for accurate time-based features.`,
    );
  }

  const timeIdx = timeCol !== undefined ? header.indexOf(timeCol) : undefined;
  const candidateCols = header.filter((_, i) => i !== timeIdx);
  const contextColumns = candidateCols.filter(isContextColumn);
  const sensorCandidates = candidateCols.filter((c) => !contextColumns.includes(c));
  if (contextColumns.length > 0) {
    warnings.push(
      `Detected context column(s) kept as metadata, not scored: ${contextColumns.join(", ")}.`,
    );
  }

  const numeric: Record<string, number> = {};
  for (const c of sensorCandidates) numeric[c] = 0;
  for (let r = 1; r < rows.length; r++) {
    const cells = parseRow(rows[r]!, delim);
    for (const c of sensorCandidates) {
      const idx = header.indexOf(c);
      if (idx < cells.length && safeFloat(cells[idx]!) !== undefined) numeric[c]! += 1;
    }
  }
  const channelIds = sensorCandidates.filter((c) => (numeric[c] ?? 0) > 0);
  const skippedColumns = sensorCandidates.filter((c) => (numeric[c] ?? 0) === 0);
  if (skippedColumns.length > 0) {
    warnings.push(`Non-numeric column(s) skipped: ${skippedColumns.join(", ")}.`);
  }
  const channelTypes: Record<string, SensorType> = {};
  const channelUnits: Record<string, string> = {};
  const channelInterfaces: Record<string, "analog_5v" | "i2c_3v3" | "frequency" | "onewire_id"> = {};
  const typeWarnings: string[] = [];
  for (const ch of channelIds) {
    const cls = classifyChannel(ch);
    channelTypes[ch] = cls.type;
    channelUnits[ch] = cls.unit;
    channelInterfaces[ch] = cls.interface;
    if (cls.type === "unknown") typeWarnings.push(ch);
  }
  if (typeWarnings.length > 0) {
    warnings.push(
      `Unclassified channel(s) treated as generic: ${typeWarnings.join(", ")}.`,
    );
  }

  if (timeSource === "column" && timeIdx !== undefined) {
    let parsed = 0;
    let checked = 0;
    for (let r = 1; r < rows.length; r++) {
      if (checked >= 25) break;
      const cells = parseRow(rows[r]!, delim);
      if (cells.length !== header.length) continue;
      checked += 1;
      if (parseTimeValue(cells[timeIdx]!, timeUnit) !== undefined) parsed += 1;
    }
    if (parsed === 0) {
      timeSource = "synthetic";
      syntheticRateHz = SYNTHETIC_REFERENCE_HZ;
      warnings.push(
        `Column "${timeCol}" was not readable as time (expected ms, epoch seconds, ISO datetime or HH:MM:SS); synthesized ${SYNTHETIC_REFERENCE_HZ} Hz timing instead (SYNTHETIC_REFERENCE_HZ).`,
      );
      timeCol = undefined;
    }
  }

  const samples: ParsedSample[] = [];
  let nonFinite = 0;
  let unsorted = false;

  for (let r = 1; r < rows.length; r++) {
    const cells = parseRow(rows[r]!, delim);
    if (cells.length !== header.length) continue;

    let rawTime: number;
    if (timeSource === "column" && timeIdx !== undefined) {
      const t = parseTimeValue(cells[timeIdx]!, timeUnit);
      if (t === undefined) {
        nonFinite += 1;
        continue;
      }
      rawTime = t;
    } else {
      rawTime = samples.length * (1000 / SYNTHETIC_REFERENCE_HZ);
    }

    const values: Record<string, number> = {};
    let rowHasNonFinite = false;
    for (const ch of channelIds) {
      const colIdx = header.indexOf(ch);
      const raw = safeFloat(cells[colIdx]!);
      if (raw === undefined) {
        nonFinite += 1;
        rowHasNonFinite = true;
        continue;
      }
      values[ch] = raw;
    }
    if (rowHasNonFinite) continue;

    for (const col of contextColumns) {
      const colIdx = header.indexOf(col);
      const raw = safeFloat(cells[colIdx]!);
      if (raw !== undefined) values[col] = raw;
    }

    samples.push({ time: rawTime, values });
  }

  if (timeSource === "column" && samples.length > 0) {
    const times = samples.map((s) => s.time).sort((a, b) => a - b);
    const medianTime = times[Math.floor(times.length / 2)]!;
    if (medianTime >= 1_200_000_000 && medianTime <= 4_000_000_000) {
      for (const s of samples) s.time *= 1000;
      warnings.push("Time column read as epoch seconds and converted to milliseconds.");
    }
  }

  for (let i = 1; i < samples.length; i++) {
    if (samples[i]!.time < samples[i - 1]!.time) {
      unsorted = true;
      break;
    }
  }

  if (unsorted) samples.sort((a, b) => a.time - b.time);

  const gaps: number[] = [];
  for (let i = 0; i < samples.length - 1; i++) gaps.push(samples[i + 1]!.time - samples[i]!.time);
  const positive = gaps.filter((g) => g > 0);
  const medianGap = positive.length ? medianOf(positive) : undefined;
  let guessSamplingRateHz = medianGap ? 1000 / medianGap : SYNTHETIC_REFERENCE_HZ;
  if (timeSource === "synthetic") guessSamplingRateHz = SYNTHETIC_REFERENCE_HZ;

  return {
    header,
    timeColumn: timeCol,
    timeSource,
    syntheticRateHz,
    samples,
    rowCount: samples.length,
    channelIds,
    contextColumns,
    skippedColumns,
    guessSamplingRateHz,
    nonFinite,
    unsorted,
    warnings,
    channelTypes,
    channelUnits,
    channelInterfaces,
  };
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}