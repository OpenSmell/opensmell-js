import { describe, expect, it, vi } from "vitest";
import {
  HardwareInsufficiencyWarning,
  checkRigSufficiency,
  effectiveDims,
  effectiveRank,
  impliedChannels,
  minEffectiveDimensions,
} from "../src/hardware.js";

describe("effectiveDims", () => {
  it("follows the empirical same-family MOX curve", () => {
    expect(effectiveDims(1)).toBe(0.5);
    expect(effectiveDims(2)).toBe(1.0);
    expect(effectiveDims(3)).toBe(1.5);
    expect(effectiveDims(4)).toBe(2.0);
    expect(effectiveDims(8)).toBe(2.5);
  });
});

describe("impliedChannels", () => {
  it("inverts the canonical framework feature count", () => {
    expect(impliedChannels(187)).toBe(6);
    expect(impliedChannels(featureCount(2))).toBe(2);
    expect(impliedChannels(100)).toBeUndefined();
    expect(impliedChannels(31)).toBeUndefined();
  });
});

describe("minEffectiveDimensions", () => {
  it("resolves stored, feature-count, then class-count heuristics", () => {
    expect(minEffectiveDimensions({ min_effective_dimensions: 1.0 })).toBe(1.0);
    expect(minEffectiveDimensions({ minEffectiveDimensions: 2.0 })).toBe(2.0);
    expect(minEffectiveDimensions({ n_features_in_: 187 })).toBe(2.5);
    expect(minEffectiveDimensions({ named_steps: { clf: { n_classes_: 8 } } })).toBe(3.0);
    expect(minEffectiveDimensions({ nClasses: 16 })).toBe(4.0);
    expect(minEffectiveDimensions({})).toBe(1.0);
  });
});

describe("checkRigSufficiency", () => {
  it("is Warn-and-Proceed and never blocks", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(checkRigSufficiency(6, { n_features_in_: 187 }, true)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockClear();

    expect(checkRigSufficiency(1, { n_classes_: 8 }, true)).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("HardwareInsufficiencyWarning:");
    warn.mockRestore();

    expect(checkRigSufficiency(1, { n_classes_: 8 }, false)).toBe(true);
  });

  it("exports the warning class", () => {
    const w = new HardwareInsufficiencyWarning("rig too small");
    expect(w.name).toBe("HardwareInsufficiencyWarning");
    expect(w.message).toBe("rig too small");
  });
});

describe("effectiveRank", () => {
  it("counts singular directions explaining the variance budget", () => {
    expect(effectiveRank([[1], [2], [3]])).toBe(1);
    const threeD = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    expect(effectiveRank(threeD)).toBe(3);
    const twoD = [
      [1, 2],
      [2, 4],
      [3, 6],
      [4, 8],
    ];
    expect(effectiveRank(twoD)).toBe(1);
    expect(effectiveRank([[1, 2]])).toBe(1);
  });
});

function featureCount(c: number): number {
  return 28 * c + (c * (c - 1)) / 2 + 4;
}