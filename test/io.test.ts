import { describe, expect, it } from "vitest";
import { buildOsmell, parseOsmell, csvFromFile, defaultFileName } from "../src/io.js";
import { OsmellFile } from "../src/types.js";
import { makeExposureFile } from "./helpers.js";

const file: OsmellFile = {
  manifest: {
    osmell: { formatVersion: "1.0.0" },
    sensor: {
      sensorType: "mox",
      channels: [
        { id: "VOC", unit: "adc" },
        { id: "C2H5OH", unit: "adc" },
      ],
      samplingRateHz: 10,
      timeColumn: "elapsed_ms",
    },
    session: { role: "single", label: "test", recordedAt: "2026-09-10T00:00:00Z" },
    extra: {},
  },
  time: [0, 100, 200, 300],
  data: { VOC: [10, 11, 12, 13], C2H5OH: [20, 21, NaN, 23] },
  events: [{ label: "odor", startMs: 150 }],
};

describe("io", () => {
  it("round-trips an OsmellFile through the .osmell bundle (non-finite rows dropped)", async () => {
    const bytes = await buildOsmell(file);
    const parsed = await parseOsmell(bytes);
    expect(parsed.time).toEqual([0, 100, 300]);
    expect(parsed.data.VOC).toEqual([10, 11, 13]);
    expect(parsed.data.C2H5OH).toEqual([20, 21, 23]);
    expect(parsed.manifest.sensor.sensorType).toBe("mox");
    expect(parsed.manifest.sensor.channels[0].id).toBe("VOC");
    expect(parsed.events).toEqual([{ label: "odor", startMs: 150 }]);
  });

  it("rejects a bundle missing manifest.json", async () => {
    const zip = new (await import("jszip")).default();
    zip.file("data.csv", "elapsed_ms,VOC\n0,1\n");
    await expect(parseOsmell(await zip.generateAsync({ type: "uint8array" }))).rejects.toThrow(
      /missing manifest\.json or data\.csv/,
    );
  });

  it("serializes the data channel back to CSV with NaN as empty", () => {
    const csv = csvFromFile(file);
    expect(csv).toBe("elapsed_ms,VOC,C2H5OH\n0,10,20\n100,11,21\n200,12,\n300,13,23\n");
  });

  it("suggests a <label>_<role>_<date>.osmell file name", () => {
    expect(defaultFileName(file)).toBe("test_single_2026-09-10.osmell");
    expect(defaultFileName(file, "exposure")).toBe("test_exposure_2026-09-10.osmell");
    expect(defaultFileName(makeExposureFile())).toBe("exp_exposure_.osmell");
  });
});