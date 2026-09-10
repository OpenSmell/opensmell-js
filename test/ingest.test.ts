import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestFile, ingestFolder, IngestedCollection, buildOsmellFile } from "../src/ingest.js";
import { parseCsv } from "../src/csv.js";

const CSV = "elapsed_ms,VOC,C2H5OH,temperature\n0,10,12,25.1\n100,10.5,12.1,25.2\n200,11,12.5,25.1\n";

describe("buildOsmellFile", () => {
  it("declares sensor channels and keeps context columns as metadata", () => {
    const parsed = parseCsv(CSV);
    const file = buildOsmellFile(parsed, "a1", "apple", "a1.csv");
    expect(file.manifest.sensor.sensorType).toBe("mox");
    expect(file.manifest.sensor.channels.map((c) => c.id)).toEqual(["VOC", "C2H5OH"]);
    expect(file.manifest.session.groupId).toBe("apple");
    const ingest = file.manifest.extra["ingest"] as Record<string, unknown>;
    expect(ingest["contextColumns"]).toEqual(["temperature"]);
    expect(file.data["VOC"]).toEqual([10, 10.5, 11]);
  });
});

describe("ingestFile", () => {
  it("ingests a CSV with a quality report (adopt-don't-reject)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osmell-"));
    const p = join(dir, "apple.csv");
    await writeFile(p, CSV);
    const session = await ingestFile(p, "apple");
    expect(session.ok).toBe(true);
    expect(session.label).toBe("apple");
    expect(session.substance).toBe("apple");
    expect(session.sensorType).toBe("mox");
    expect(session.report?.badge).toBeDefined();
    expect(session.warnings.length).toBeGreaterThanOrEqual(0);
  });

  it("reports an error instead of throwing on bad input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osmell-"));
    const p = join(dir, "empty.txt");
    await writeFile(p, "");
    const session = await ingestFile(p);
    expect(session.ok).toBe(false);
    expect(session.error).toBeTruthy();
  });
});

describe("ingestFolder", () => {
  it("groups by sub-folder = substance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osmell-folder-"));
    await mkdir(join(dir, "apple"), { recursive: true });
    await mkdir(join(dir, "banana"), { recursive: true });
    await writeFile(join(dir, "apple", "a1.csv"), CSV);
    await writeFile(join(dir, "apple", "a2.csv"), CSV);
    await writeFile(join(dir, "banana", "b1.csv"), CSV);
    const collection = await ingestFolder(dir);
    expect(collection).toBeInstanceOf(IngestedCollection);
    expect(collection.sessionCount()).toBe(3);
    expect(collection.okCount()).toBe(3);
    expect(Object.keys(collection.substances).sort()).toEqual(["apple", "banana"]);
    expect(collection.substances["apple"]).toHaveLength(2);
  });
});