export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Population standard deviation (ddof=0), matching the reference implementation. */
export function std(values: number[]): number {
  if (values.length === 0) return NaN;
  const m = mean(values);
  let variance = 0;
  for (const v of values) variance += (v - m) * (v - m);
  variance /= values.length;
  return Math.sqrt(variance);
}

export function isFiniteNumber(v: number): boolean {
  return Number.isFinite(v);
}