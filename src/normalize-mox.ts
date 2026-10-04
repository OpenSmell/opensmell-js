import { mean, std } from "./normalize.js";
import { ChannelStats, DEFAULT_R0_SAMPLES, OsmellFile, r0WindowSamples } from "./types.js";

/**
 * Median of the leading `n` samples, with the contract guards: mean of the
 * positive values, then 1.0. `n` is a declared baseline window, or `undefined`
 * for the cadence-independent contract default `r0WindowSamples`.
 */
export function r0FromSamples(values: number[], n?: number): number {
  n = r0WindowSamples(values.length, n);
  const window = values.slice(0, n);
  if (window.length === 0) return NaN;
  const sortedWin = [...window].sort((a, b) => a - b);
  const mid = Math.floor(sortedWin.length / 2);
  const r0 =
    sortedWin.length % 2 === 0
      ? (sortedWin[mid - 1]! + sortedWin[mid]!) / 2
      : sortedWin[mid]!;
  if (r0 > 0) return r0;
  const positive = window.filter((v) => v > 0);
  return positive.length ? mean(positive) : 1;
}

export function baselineForChannel(
  file: OsmellFile,
  channelId: string,
  targetValues: number[],
): [number, number[], number] {
  const baseline = file.manifest.baseline;
  const source = baseline?.source ?? "none";
  const r0Samples = r0WindowSamples(targetValues.length, baseline?.r0Samples ?? DEFAULT_R0_SAMPLES);

  if (source === "explicit") {
    const b = file.data[channelId] ?? [];
    const r0 = r0FromSamples(b, b.length);
    const cv = r0 ? std(b) / r0 : Infinity;
    return [r0, b, cv];
  }

  const valid = targetValues.slice(0, r0Samples).filter(Number.isFinite);
  const r0 = r0FromSamples(valid, r0Samples);
  const cv = r0 ? std(valid) / r0 : Infinity;
  return [r0, valid, cv];
}

export function normalizedSeries(values: number[], r0: number): number[] {
  if (!(Number.isFinite(r0) && r0 > 0)) return values.map(() => NaN);
  return values.map((v) => (v - r0) / r0);
}

export function channelStats(values: number[], r0: number): ChannelStats {
  const finite = values.filter(Number.isFinite);
  const nonFinite = values.length - finite.length;
  const m = mean(finite);
  const sd = std(finite);
  const cv = r0 > 0 ? sd / r0 : Infinity;
  const lo = finite.length ? Math.min(...finite) : NaN;
  const hi = finite.length ? Math.max(...finite) : NaN;
  return {
    id: "",
    min: lo,
    max: hi,
    mean: m,
    std: sd,
    r0,
    cv,
    dead: cv < 0.001,
    span: finite.length ? hi - lo : NaN,
    clipped: 0,
    nonFinite,
  };
}