export const EPSILON = 1e-12;

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Nearest-rank empirical quantile, Q_p = x_(ceil(pN)). */
export function quantileNearestRank(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  if (p <= 0) return Math.min(...values);
  if (p >= 1) return Math.max(...values);
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1]!;
}

export function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return sum(values.map((x) => (x - m) ** 2)) / (values.length - 1);
}

export function sampleStdDev(values: readonly number[]): number {
  return Math.sqrt(sampleVariance(values));
}

export function correlation(a: readonly number[], b: readonly number[]): number | undefined {
  if (a.length !== b.length || a.length < 2) return undefined;
  const ma = mean(a);
  const mb = mean(b);
  let covariance = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    covariance += da * db;
    va += da * da;
    vb += db * db;
  }
  const denominator = Math.sqrt(va * vb);
  return denominator <= EPSILON ? undefined : covariance / denominator;
}

export function clip(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function signNonzero(value: number, previous = 0): number {
  return value > 0 ? 1 : value < 0 ? -1 : previous;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export function hashString(value: string): string {
  // Stable, dependency-free FNV-1a hash for IDs/audit hashes (not cryptographic).
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
