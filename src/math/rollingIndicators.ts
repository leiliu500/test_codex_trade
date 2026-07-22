import { EPSILON, signNonzero } from "../utils/statistics.js";

export function realizedMovementBps(logPrices: readonly number[]): number {
  let squared = 0;
  for (let i = 1; i < logPrices.length; i += 1) squared += (logPrices[i]! - logPrices[i - 1]!) ** 2;
  return 10_000 * Math.sqrt(squared);
}

export function efficiencyRatio(logPrices: readonly number[]): number {
  if (logPrices.length < 2) return 0;
  let path = 0;
  for (let i = 1; i < logPrices.length; i += 1) path += Math.abs(logPrices[i]! - logPrices[i - 1]!);
  const displacement = Math.abs(logPrices.at(-1)! - logPrices[0]!);
  return Math.min(1, displacement / (path + EPSILON));
}

export function directionalSignChanges(logPrices: readonly number[]): number {
  let previous = 0;
  let changes = 0;
  for (let i = 1; i < logPrices.length; i += 1) {
    const current = signNonzero(logPrices[i]! - logPrices[i - 1]!, previous);
    if (current !== 0 && previous !== 0 && current !== previous) changes += 1;
    if (current !== 0) previous = current;
  }
  return changes;
}

export function ewma(values: readonly number[], halfLifePeriods: number): number {
  if (values.length === 0) return 0;
  const alpha = 1 - Math.exp(-Math.log(2) / Math.max(EPSILON, halfLifePeriods));
  let value = values[0]!;
  for (let i = 1; i < values.length; i += 1) value = alpha * values[i]! + (1 - alpha) * value;
  return value;
}

export function relativeVolume(current: number, historicalMedian: number): number {
  return current / (historicalMedian + EPSILON);
}
