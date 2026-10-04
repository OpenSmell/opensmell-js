// R0 baseline window contract (electronic-nose/SAMPLING_CONTRACT.md, "The R0
// window contract").
//
// `r0Samples = undefined` (or 0) means "nothing declared" and resolves to
// `clamp(floor(0.15 * n), 5, 30)`. These mirror the Python and Rust suites
// case-for-case so the three SDKs cannot drift apart again.

import { describe, expect, it } from "vitest";
import { computeChannelHealth } from "../src/framework.js";
import { r0FromContract } from "../src/framework.js";
import {
  R0_WINDOW_FRACTION,
  R0_WINDOW_MAX_SAMPLES,
  R0_WINDOW_MIN_SAMPLES,
  r0WindowSamples,
} from "../src/types.js";

const CADENCES = [1, 2, 10, 100];
// 0.15 * n is inside [5, 30] exactly for 34 <= n <= 200.
const FRACTION_REGION = [40, 80, 160];

/** Flat clean-air plateau then a monotone exposure, sampled at `fs` Hz.
 *
 *  The plateau is 12 s so the default window lies wholly inside it at every
 *  cadence under test (the widest is 9 samples at 1 Hz).
 */
function exposure(fs: number, plateauS = 12, durationS = 60): number[] {
  const n = Math.round(durationS * fs) + 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const ramp = Math.min(1, Math.max(0, (t - plateauS) / 10));
    out.push(1000 + 50 * ramp);
  }
  return out;
}

describe("r0WindowSamples", () => {
  it("is a floored, capped fraction of the recording", () => {
    // Floor: a 20-sample window would be 3 samples at 15% — too few for a stable
    // median — so the floor of 5 binds.
    expect(r0WindowSamples(1)).toBe(R0_WINDOW_MIN_SAMPLES);
    expect(r0WindowSamples(20)).toBe(R0_WINDOW_MIN_SAMPLES);
    // Fraction region, 34 <= n <= 200.
    expect(r0WindowSamples(60)).toBe(9);
    expect(r0WindowSamples(100)).toBe(15); // the canonical DEFAULT_WINDOW_SIZE
    expect(r0WindowSamples(200)).toBe(30);
    // Ceiling: an unbounded 15% of 600 would be 90 samples and would swallow the
    // onset on a long recording.
    expect(r0WindowSamples(600)).toBe(R0_WINDOW_MAX_SAMPLES);
    expect(r0WindowSamples(18000)).toBe(R0_WINDOW_MAX_SAMPLES);
  });

  it("lets a declared window win verbatim, and treats 0 as not declared", () => {
    expect(r0WindowSamples(600, 15)).toBe(15);
    expect(r0WindowSamples(60, 180)).toBe(180);
    // 0 is the "not declared" sentinel, shared with the Rust R0_WINDOW_DEFAULT.
    expect(r0WindowSamples(100, 0)).toBe(15);
    expect(r0WindowSamples(100, undefined)).toBe(15);
  });

  it("spans 15 percent of seconds at every cadence in the fraction region", () => {
    for (const fs of CADENCES) {
      for (const n of FRACTION_REGION) {
        const window = r0WindowSamples(n);
        const durationS = n / fs;
        expect(window / fs).toBeCloseTo(R0_WINDOW_FRACTION * durationS, 9);
      }
    }
  });

  it("documents that the clamps are themselves cadence-dependent", () => {
    // 60 s at 1 Hz is 61 samples: fraction binds, window covers 9 s. The same
    // 60 s at 100 Hz is 6001 samples: ceiling binds, window covers 0.3 s.
    const slowS = r0WindowSamples(61) / 1;
    const fastS = r0WindowSamples(6001) / 100;
    expect(slowS).toBeCloseTo(9, 9);
    expect(fastS).toBeCloseTo(0.3, 9);
    expect(slowS / fastS).toBeCloseTo(30, 6);
  });

  it("restores cadence invariance once the window is declared", () => {
    const durationS = 60;
    for (const fs of CADENCES) {
      const n = Math.round(durationS * fs) + 1;
      const declared = Math.round(R0_WINDOW_FRACTION * durationS * fs);
      expect(r0WindowSamples(n, declared) / fs).toBeCloseTo(R0_WINDOW_FRACTION * durationS, 9);
    }
  });
});

describe("r0FromContract", () => {
  it("reads the same physical baseline at 1, 2, 10 and 100 Hz", () => {
    for (const fs of CADENCES) {
      expect(r0FromContract(exposure(fs))).toBeCloseTo(1000, 9);
    }
  });

  it("shows why a short plateau needs a declared window", () => {
    // The regression this contract exists for, and the limit it does not fix.
    // With a 1 s plateau in a 60 s recording:
    //   - fixed 15 samples: 15 s at 1 Hz (median = 1030, on the ramp) against
    //     0.15 s at 100 Hz (median = 1000, on the baseline) — cadence-dependent;
    //   - contract default 15%: 9 s at 1 Hz (median = 1015) against 0.3 s at
    //     100 Hz (1000) — still cadence-dependent, because the plateau is
    //     shorter than 15% of the recording and no window rule can recover it.
    // Declaring the window (rule 5: round(1 s * fs) samples) is the fix, and it
    // reads 1000 at every cadence.
    expect(r0FromContract(exposure(1, 1), 15)).toBeCloseTo(1030, 9);
    expect(r0FromContract(exposure(100, 1), 15)).toBeCloseTo(1000, 9);
    expect(r0FromContract(exposure(1, 1))).toBeCloseTo(1015, 9);
    expect(r0FromContract(exposure(100, 1))).toBeCloseTo(1000, 9);
    for (const fs of CADENCES) {
      expect(r0FromContract(exposure(fs, 1), Math.round(1 * fs))).toBeCloseTo(1000, 9);
    }
  });

  it("agrees across cadence whenever the plateau contains the window", () => {
    // The 12 s plateau case: every resolved window lies inside the baseline, so
    // all four cadences read the same physical R0.
    const r0s = CADENCES.map((fs) => r0FromContract(exposure(fs)));
    for (const r0 of r0s) expect(r0).toBeCloseTo(1000, 9);
  });

  it("uses the declared window verbatim end to end", () => {
    // Samples 0-6 sit at 1000 and samples 7-14 at 2000, so the median and the
    // spread both move when the window crosses index 7.
    const series = [...Array(7).fill(1000), ...Array(8).fill(2000), ...Array(86).fill(1500)];
    expect(r0WindowSamples(series.length, 7)).toBe(7);
    expect(r0FromContract(series, 7)).toBeCloseTo(1000, 9);
    // 15 samples is 7x1000 then 8x2000, so the median is the 8th value.
    expect(r0FromContract(series, 15)).toBeCloseTo(2000, 9);
    expect(r0FromContract(series)).toBeCloseTo(2000, 9);

    // R0 *and* noise_floor come from the same resolved window: a 7-sample window
    // sees a perfectly flat 1000 and so has zero spread.
    expect(computeChannelHealth(series, 7).noise_floor).toBeCloseTo(0, 9);
    expect(computeChannelHealth(series, 15).noise_floor!).toBeGreaterThan(0);
    expect(computeChannelHealth(series).noise_floor).toBeCloseTo(
      computeChannelHealth(series, 15).noise_floor!,
      12,
    );
  });
});