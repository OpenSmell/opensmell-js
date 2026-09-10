import { describe, expect, it } from "vitest";
import { processMox, runProcessor, featureNames, frameworkFeatureLen } from "../src/features.js";
import { extractAllFrameworkFeatures, featureNames as fwNames } from "../src/framework.js";
import { makeExposureFile } from "./helpers.js";

describe("processMox", () => {
  it("computes per-channel kinetic features (web processMox parity)", () => {
    const res = processMox(makeExposureFile());
    expect(res.sensor_type).toBe("mox");
    expect(res.features).toHaveLength(1);
    const f = res.features[0]!;
    expect(f.channel).toBe("VOC");
    expect(f.dead).toBe(false);
    expect(f.r0).toBeCloseTo(10, 1);
    expect(f.relative_amplitude).toBeCloseTo(4, 1);
    expect(f.direction).toBe(1);
    expect(f.endpoint_delta).toBeLessThan(0.2);
    expect(f.auc).toBeGreaterThan(0);
    expect(f.saturation_index).toBeGreaterThan(0.5);
    expect(res.normalized.VOC).toHaveLength(600);
  });

  it("marks dead channels and zeroes their features", () => {
    const res = processMox(makeExposureFile());
    const flat = {
      ...makeExposureFile(),
      data: { VOC: Array.from({ length: 100 }, () => 10) },
    };
    const dead = processMox(flat);
    expect(dead.features[0]!.dead).toBe(true);
    expect(dead.features[0]!.relative_amplitude).toBe(0);
    void res;
  });
});

describe("runProcessor", () => {
  it("dispatches mox to processMox and other sensor types to placeholders", () => {
    const res = runProcessor(makeExposureFile());
    expect((res as { sensor_type: string }).sensor_type).toBe("mox");

    const unknown = runProcessor(makeExposureFile());
    expect((unknown as { sensor_type: string }).sensor_type).toBe("mox");

    const other = runProcessor({
      ...makeExposureFile(),
      manifest: { ...makeExposureFile().manifest, sensor: { ...makeExposureFile().manifest.sensor, sensorType: "other" } },
    });
    expect((other as { sensor_type: string }).sensor_type).toBe("other");
  });
});

describe("featureNames", () => {
  it("produces 28c + c(c-1)/2 + 4 names", () => {
    expect(frameworkFeatureLen(6)).toBe(187);
    expect(featureNames().length).toBe(187);
    expect(fwNames(2).length).toBe(61);
    expect(fwNames(2)).toContain("ch0_da_relative_amplitude");
    expect(fwNames(6)).toContain("sel_ratio_ch0_ch1");
  });

  it("extracts the canonical feature set from a channel matrix", () => {
    const data = Array.from({ length: 64 }, (_, i) => [
      10 + 40 * Math.exp(-(i - 8) / 15),
      20 + 30 * Math.exp(-(i - 8) / 20),
    ]);
    const feats = extractAllFrameworkFeatures(data, 15, 10);
    expect(Object.keys(feats).length).toBe(61);
  });
});