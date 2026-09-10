import { describe, expect, it } from "vitest";
import { OsmellFile } from "../src/types.js";

/** Deterministic 60 s exposure recording: auto-R0 window, ramp to peak, decay. */
export function makeExposureFile(
  opts: { role?: string; baseline?: string | null; adcMax?: number; rate?: number; samples?: number } = {},
): OsmellFile {
  const rate = opts.rate ?? 10;
  const N = opts.samples ?? 600;
  const time: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < N; i++) {
    time.push(i * (1000 / rate));
    let v: number;
    if (i < 15) v = 10 + 0.01 * Math.sin(i * 1.7);
    else if (i <= 70) v = 10 + 40 * ((i - 15) / 55);
    else v = 10 + 40 * Math.exp(-(i - 70) / 120);
    values.push(Math.round(v * 100000) / 100000);
  }
  return {
    manifest: {
      osmell: { formatVersion: "1.0.0" },
      sensor: {
        sensorType: "mox",
        channels: [{ id: "VOC", unit: "adc" }],
        samplingRateHz: rate,
        adcMax: opts.adcMax ?? 200,
        timeColumn: "elapsed_ms",
      },
      session: { role: opts.role ?? "exposure", label: "exp" },
      baseline: opts.baseline === null ? undefined : { source: opts.baseline ?? "auto" },
      extra: {},
    },
    time,
    data: { VOC: values },
  };
}