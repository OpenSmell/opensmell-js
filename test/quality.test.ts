import { describe, expect, it } from "vitest";
import { computeQuality, computeQualityMox, WEIGHTS } from "../src/quality.js";
import { r0WindowSamples } from "../src/types.js";
import { makeExposureFile } from "./helpers.js";

describe("computeQualityMox", () => {
  it("resolves the auto-R0 window from the recording length, not a fixed 15", () => {
    // 600 samples at 10 Hz. The contract window is clamp(floor(0.15 * 600), 5,
    // 30) = 30, which reaches 15 samples past this fixture's 15-sample clean-air
    // lead-in and so into the response ramp. A fixed 15 would have stopped at the
    // plateau. See "The R0 window contract" in electronic-nose/SAMPLING_CONTRACT.md.
    expect(r0WindowSamples(600)).toBe(30);
    const report = computeQualityMox(makeExposureFile(), 600, 10, false, 0);
    // The window is no longer clean air, so the baseline CV clears NOISE_CV_LIMIT
    // and auto-R0 stability scores 0 instead of the capped 50.
    expect(report.subscores.baselineStability?.value).toBe(0);
    expect(report.subscores.baselineStability?.reason).toBe("auto_r0");
  });

  it("honours a declared r0Samples window verbatim", () => {
    // A declared window wins over the default, so a recording whose baseline is
    // known (or whose plateau is known to be 15 samples) keeps its old score.
    const file = makeExposureFile();
    file.manifest.baseline = { source: "auto", r0Samples: 15 };
    const report = computeQualityMox(file, 600, 10, false, 0);
    expect(report.total).toBe(90);
    expect(report.badge).toBe("Excellent");
    expect(report.subscores.baselineStability?.value).toBe(50);
  });

  it("scores a clean exposure recording Excellent", () => {
    const file = makeExposureFile();
    file.manifest.baseline = { source: "auto", r0Samples: 15 };
    const report = computeQualityMox(file, 600, 10, false, 0);
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
    const file = makeExposureFile({ role: "single" });
    file.manifest.baseline = { source: "auto", r0Samples: 15 };
    const report = computeQuality(file, 600, 10, false, 0);
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