import JSZip from "jszip";
import { parseCsv } from "./csv.js";
import {
  JsonValue,
  OsmellFile,
  SessionEvent,
  eventFromDict,
  eventToDict,
  manifestFromDict,
  manifestToDict,
} from "./types.js";

export const OSMELL_MIME_TYPE = "application/vnd.opensmell.osmell";

/** Parse an in-memory `.osmell` bundle (ZIP: manifest.json + data.csv + optional events.json). */
export async function parseOsmell(fileBytes: Uint8Array): Promise<OsmellFile> {
  const zip = await JSZip.loadAsync(fileBytes);
  const names = new Set(Object.keys(zip.files));
  if (!names.has("manifest.json") || !names.has("data.csv")) {
    throw new Error("Not a valid .osmell file: missing manifest.json or data.csv.");
  }

  const manifest = manifestFromDict(
    JSON.parse(await zip.file("manifest.json")!.async("string")),
  );
  const csv = parseCsv(await zip.file("data.csv")!.async("string"));

  if (csv.rowCount === 0) {
    throw new Error("The .osmell data.csv is empty.");
  }

  const expected = new Set(manifest.sensor.channels.map((c) => c.id));
  for (const cid of csv.channelIds) {
    if (!expected.has(cid)) {
      throw new Error(`data.csv has column "${cid}" not declared in the manifest.`);
    }
  }
  for (const c of manifest.sensor.channels) {
    if (!csv.channelIds.includes(c.id)) {
      throw new Error(`Manifest channel "${c.id}" is missing from data.csv.`);
    }
  }

  const time = csv.samples.map((s) => s.time);
  const series: Record<string, number[]> = {};
  for (const cid of csv.channelIds) {
    series[cid] = csv.samples.map((s) => s.values[cid] ?? NaN);
  }

  let events: SessionEvent[] | undefined;
  if (names.has("events.json")) {
    const raw = (await zip.file("events.json")!.async("string")) as string;
    events = (JSON.parse(raw) as Record<string, JsonValue>[]).map(eventFromDict);
  }

  return { manifest, time, data: series, events };
}

/** Load a `.osmell` bundle from disk. */
export async function parseOsmellFile(path: string): Promise<OsmellFile> {
  const { readFile } = await import("node:fs/promises");
  const data = await readFile(path);
  return parseOsmell(new Uint8Array(data));
}

/** Serialize the data channel of an OsmellFile back to CSV text. */
export function csvFromFile(file: OsmellFile): string {
  const channelIds = file.manifest.sensor.channels.map((c) => c.id);
  const timeColumn = file.manifest.sensor.timeColumn;
  const lines = [[timeColumn, ...channelIds].join(",")];
  for (let i = 0; i < file.time.length; i++) {
    const row = [String(file.time[i])];
    for (const cid of channelIds) {
      const col = file.data[cid] ?? [];
      const v = i < col.length ? col[i] : undefined;
      row.push(v === v && v !== undefined ? String(v) : "");
    }
    lines.push(row.join(","));
  }
  return lines.join("\n") + "\n";
}

/** Serialize an OsmellFile to an in-memory `.osmell` bundle (DEFLATE). */
export async function buildOsmell(file: OsmellFile): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifestToDict(file.manifest), null, 2));
  zip.file("data.csv", csvFromFile(file));
  if (file.events) {
    zip.file("events.json", JSON.stringify(file.events.map(eventToDict), null, 2));
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** Write an OsmellFile to disk as a `.osmell` bundle; returns the path. */
export async function writeOsmell(file: OsmellFile, path: string): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, await buildOsmell(file));
  return path;
}

/** Name suggestion: `<label>_<role>_<date>.osmell` (web defaultFileName). */
export function defaultFileName(file: OsmellFile, role?: string): string {
  const session = file.manifest.session;
  const r = role ?? session.role ?? "single";
  const label = (session.label || "recording").replace(/[^a-z0-9_\-]+/gi, "-");
  const recorded = session.recordedAt ? session.recordedAt.slice(0, 10) : "";
  return `${label}_${r}_${recorded}.osmell`;
}