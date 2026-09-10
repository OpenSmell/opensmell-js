import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { parseCsv, CsvParseResult, guessSensorType } from "./csv.js";
import { computeQuality } from "./quality.js";
import {
  ChannelDescriptor,
  JsonValue,
  OsmellFile,
  OsmellManifest,
  QualityReport,
  SensorDescriptor,
  SessionDescriptor,
} from "./types.js";

const CSV_SUFFIXES = /\.(csv|txt)$/i;

/** A single ingested session: file, quality report, and parse warnings. */
export class IngestedSession {
  ok: boolean;
  file?: OsmellFile;
  report?: QualityReport;
  warnings: string[];
  error?: string;

  constructor(
    readonly source: string,
    readonly substance: string,
    readonly label: string,
  ) {
    this.ok = false;
    this.warnings = [];
  }

  get sensorType(): string {
    return this.file?.manifest.sensor.sensorType ?? "unknown";
  }

  get timeSource(): string {
    const ingest = this.file?.manifest.extra["ingest"];
    if (ingest && typeof ingest === "object" && !Array.isArray(ingest)) {
      const ts = (ingest as Record<string, JsonValue>)["timeSource"];
      if (typeof ts === "string") return ts;
    }
    return "column";
  }
}

export class IngestedCollection {
  substances: Record<string, IngestedSession[]> = {};

  add(substance: string, session: IngestedSession): void {
    (this.substances[substance] ??= []).push(session);
  }

  sessionCount(): number {
    return Object.keys(this.substances).reduce((n, k) => n + this.substances[k]!.length, 0);
  }

  okCount(): number {
    return this.iterSessions().filter((s) => s.ok).length;
  }

  iterSessions(): IngestedSession[] {
    const out: IngestedSession[] = [];
    for (const substance of Object.keys(this.substances).sort()) {
      for (const s of this.substances[substance]!) out.push(s);
    }
    return out;
  }
}

/** Normalize a parsed CSV into an OsmellFile with ingest provenance.
 *
 * Only sensor channels (MOX + unknown numeric columns) are declared as
 * `sensor.channels` so features and quality never score environmental context.
 * Context values are preserved losslessly in the manifest's ingest metadata.
 */
export function buildOsmellFile(
  parsed: CsvParseResult,
  label: string,
  substance: string,
  source: string,
  role = "single",
): OsmellFile {
  const sensorType = guessSensorType(parsed.header);
  const durationMs =
    parsed.samples.length > 1
      ? Math.trunc(parsed.samples[parsed.samples.length - 1]!.time - parsed.samples[0]!.time)
      : 0;

  const extra: Record<string, JsonValue> = {
    ingest: {
      sourceFile: source,
      timeSource: parsed.timeSource,
      syntheticRateHz: parsed.syntheticRateHz || null,
      timeColumn: parsed.timeColumn ?? null,
      contextColumns: parsed.contextColumns,
      unknownColumns: parsed.unknownColumns,
      skippedColumns: parsed.skippedColumns,
      warnings: parsed.warnings,
      context: Object.fromEntries(
        parsed.contextColumns.map((col) => [col, parsed.samples.map((s) => s.values[col] ?? null)]),
      ),
    } as Record<string, JsonValue>,
  };

  const manifest = {
    osmell: { formatVersion: "1.0.0" },
    sensor: {
      sensorType,
      channels: parsed.channelIds.map((cid) => ({ id: cid, unit: "adc" }) as ChannelDescriptor),
      samplingRateHz: parsed.guessSamplingRateHz || undefined,
      timeColumn: parsed.timeColumn ?? "synthetic_index",
    } as SensorDescriptor,
    session: {
      role,
      label,
      groupId: substance,
      durationMs,
      notes: parsed.warnings.length ? parsed.warnings.join("; ") : undefined,
    } as SessionDescriptor,
    software: { importer: "opensmell-ingest" },
    extra,
  } as OsmellManifest;

  const data: Record<string, number[]> = {};
  for (const cid of parsed.channelIds) {
    data[cid] = parsed.samples.map((s) => s.values[cid] ?? NaN);
  }
  return { manifest, time: parsed.samples.map((s) => s.time), data };
}

/** Ingest a single CSV/TXT file. Never rejects for structure problems. */
export async function ingestFile(path: string, substance?: string, role = "single"): Promise<IngestedSession> {
  const parent = dirname(path);
  const parentName = parent === "." ? "" : basename(parent);
  const label = basename(path).replace(/\.(csv|txt)$/i, "");
  const sub = (substance ?? "").trim() || parentName || label;
  const session = new IngestedSession(path, sub, label);
  try {
    const text = await readFile(path, "utf-8");
    const parsed = parseCsv(text);
    if (parsed.rowCount === 0) {
      session.error = "No usable data rows found.";
      return session;
    }
    if (parsed.channelIds.length === 0) {
      session.error = "No numeric sensor columns found.";
      return session;
    }
    session.file = buildOsmellFile(parsed, label, sub, path, role);
    session.report = computeQuality(
      session.file,
      parsed.rowCount,
      parsed.guessSamplingRateHz,
      parsed.unsorted,
      parsed.nonFinite,
    );
    session.ok = true;
    session.warnings = parsed.warnings;
  } catch (e) {
    session.error = String(e);
  }
  return session;
}

async function walk(
  root: string,
  dir: string,
  groups: Record<string, string[]>,
  labelFromDir: boolean,
  recurse: boolean,
): Promise<void> {
  let entries = await readdir(dir, { withFileTypes: true });
  entries = entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recurse) await walk(root, full, groups, labelFromDir, recurse);
    } else if (CSV_SUFFIXES.test(entry.name)) {
      const rel = relative(root, dir);
      const substance = labelFromDir && rel !== "" ? basename(dir) : basename(root);
      (groups[substance] ??= []).push(full);
    }
  }
}

/** Ingest a folder of recordings, grouping by sub-folder = substance. */
export async function ingestFolder(
  path: string,
  recurse = true,
  labelFromDir = true,
): Promise<IngestedCollection> {
  const groups: Record<string, string[]> = {};
  const stat = await readdir(path, { withFileTypes: true }).catch(() => {
    throw new Error(`Not a folder: ${path}`);
  });
  void stat;
  await walk(path, path, groups, labelFromDir, recurse);

  const collection = new IngestedCollection();
  for (const substance of Object.keys(groups)) {
    for (const p of groups[substance]!) {
      collection.add(substance, await ingestFile(p, substance));
    }
  }
  return collection;
}