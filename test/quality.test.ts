import { describe, expect, it } from "vitest";
import { computeQuality, computeQualityMox, WEIGHTS } from "../src/quality.js";
import { makeExposureFile } from "./helpers.js";

describe("computeQualityMox", () => {
  it("scores a clean exposure recording Excellent", () => {
    const report = computeQualityMox(makeExposureFile(), 600, 10, false, 0);
    expect(report.format).toBe("opensmell-quality");
    expect(report.version).toBe("1");
    expect(report.total).toBe(90);
    expect(report.badge).toBe("Excellent");
    expect(report.subscores.continuity?.value).toBe(100);
    expect(report.subscores.saturationFree?.value).toBe(100);
    expect(report.subscores.signalStrength?.value).toBe(100);
    expect(report.subscores.recoveryCompleteness?.value).toBeGreaterThan(95);
    expect(report.subscores.baselineStability?.value).toBe(50); // auto-R0 cap
    expect(report.subscores.baselineStability?.reason).toBe("auto_r0");
    expect(report.flags.deadSensors).toEqual([]);
    expect(report.flags.noBaseline).toBe(false);
  });

  it("sets signal/recovery to null for non-exposure roles", () => {
    const report = computeQuality(makeExposureFile({ role: "single" }), 600, 10, false, 0);
    expect(report.subscores.signalStrength?.value).toBeUndefined();
    expect(report.subscores.recoveryCompleteness?.value).toBeUndefined();
    expect(report.badge).toBe("Good");
  });

  it("zeros baseline stability when no baseline is declared", () => {
    const report = computeQuality(makeExposureFile({ baseline: null }), 600, 10);
    expect(report.subscores.baselineStability?.value).toBe(0);
    expect(report.subscores.baselineStability?.reason).toBe("no_baseline");
    expect(report.flags.noBaseline).toBe(true);
  });

  it("reports low dynamic range when the channel span is tiny", () => {
    const report = computeQuality(
      buildFlatFile(),
      600,
      10,
      false,
      0,
    );
    expect(report.subscores.dynamicRange?.reason).toBe("low_span");
    expect(report.reasons["dynamicRange"]).toBe("channel_span_below_10_percent_of_adc_range");
  });

  it("weights sum agrees with the spec", () => {
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

function buildFlatFile() {
  const base = makeExposureFile({ baseline: null });
  return {
    ...base,
    data: { VOC: Array.from({ length: 600 }, () => 1000) },
  };
}