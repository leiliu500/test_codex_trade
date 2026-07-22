import type { RegressionResult } from "../types.js";
import type { EngineConfig } from "../config.js";
import { solve3, type Matrix3, type Vector3 } from "./linearAlgebra.js";
import { EPSILON, median } from "../utils/statistics.js";

export interface TimedValue { timestamp: number; value: number }
export type RegressionConfig = EngineConfig["regression"];

interface Fit { coefficients: Vector3; inverse: Matrix3; weights: number[] }

function weightedFit(u: readonly number[], y: readonly number[], weights: readonly number[]): Fit | undefined {
  const powers = [0, 0, 0, 0, 0];
  const rhs: Vector3 = [0, 0, 0];
  for (let i = 0; i < u.length; i += 1) {
    const x = u[i]!;
    const w = weights[i]!;
    const yi = y[i]!;
    let power = 1;
    for (let k = 0; k <= 4; k += 1) {
      powers[k]! += w * power;
      power *= x;
    }
    rhs[0] += w * yi;
    rhs[1] += w * x * yi;
    rhs[2] += w * x * x * yi;
  }
  const matrix: Matrix3 = [
    [powers[0]!, powers[1]!, powers[2]!],
    [powers[1]!, powers[2]!, powers[3]!],
    [powers[2]!, powers[3]!, powers[4]!],
  ];
  const solved = solve3(matrix, rhs);
  return solved ? { coefficients: solved.solution, inverse: solved.inverse, weights: [...weights] } : undefined;
}

function invalid(windowSec: number, pointCount: number, coverageFraction: number, reason: string): RegressionResult {
  return { valid: false, windowSec, pointCount, coverageFraction, reason };
}

/** Causal robust endpoint quadratic regression over [now-T, now]. */
export function robustEndpointQuadratic(
  observations: readonly TimedValue[],
  now: number,
  windowSec: number,
  config: RegressionConfig,
): RegressionResult {
  const start = now - windowSec * 1000;
  const points = observations.filter((point) =>
    point.timestamp >= start && point.timestamp <= now && Number.isFinite(point.value));
  const coverage = points.length > 1
    ? (points.at(-1)!.timestamp - points[0]!.timestamp) / (windowSec * 1000)
    : 0;
  if (points.length < config.minimumPoints) return invalid(windowSec, points.length, coverage, "INSUFFICIENT_POINTS");
  if (coverage < config.minimumCoverageFraction) return invalid(windowSec, points.length, coverage, "INSUFFICIENT_COVERAGE");

  const u = points.map((point) => (point.timestamp - now) / (windowSec * 1000));
  const y = points.map((point) => point.value);
  const halfLifeSec = Math.max(EPSILON, windowSec * config.halfLifeFraction);
  const timeWeights = points.map((point) =>
    Math.exp((Math.log(2) / halfLifeSec) * ((point.timestamp - now) / 1000)));
  let weights = [...timeWeights];
  let fit = weightedFit(u, y, weights);
  if (!fit) return invalid(windowSec, points.length, coverage, "SINGULAR_NORMAL_MATRIX");

  let residualMad = 0;
  for (let iteration = 0; iteration < config.irlsIterations; iteration += 1) {
    const [c0, c1, c2] = fit.coefficients;
    const residuals = y.map((value, i) => value - (c0 + c1 * u[i]! + c2 * u[i]! ** 2));
    const residualMedian = median(residuals);
    residualMad = median(residuals.map((value) => Math.abs(value - residualMedian)));
    const sigma = 1.4826 * residualMad;
    if (!Number.isFinite(sigma) || sigma <= EPSILON) break;
    const threshold = config.huberK * sigma;
    weights = residuals.map((residual, i) =>
      timeWeights[i]! * (Math.abs(residual) <= threshold ? 1 : threshold / Math.abs(residual)));
    const next = weightedFit(u, y, weights);
    if (!next) return invalid(windowSec, points.length, coverage, "SINGULAR_IRLS_MATRIX");
    fit = next;
  }

  const [c0, c1, c2] = fit.coefficients;
  const weightSum = fit.weights.reduce((acc, value) => acc + value, 0);
  const weightedMean = y.reduce((acc, value, i) => acc + fit!.weights[i]! * value, 0) / weightSum;
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < y.length; i += 1) {
    const predicted = c0 + c1 * u[i]! + c2 * u[i]! ** 2;
    sse += fit.weights[i]! * (y[i]! - predicted) ** 2;
    sst += fit.weights[i]! * (y[i]! - weightedMean) ** 2;
  }
  const r2 = sst <= EPSILON ? 1 : 1 - sse / sst;
  const residualVariance = sse / Math.max(1, points.length - 3);
  const coefficientVariance = Math.max(0, residualVariance * fit.inverse[1][1]);
  const slopeStdError = 10_000 * Math.sqrt(coefficientVariance) / windowSec;
  const slope = 10_000 * c1 / windowSec;
  return {
    valid: true,
    windowSec,
    pointCount: points.length,
    coverageFraction: coverage,
    levelLog: c0,
    slopeBpsPerSec: slope,
    accelerationBpsPerSec2: 20_000 * c2 / windowSec ** 2,
    r2,
    residualMad,
    slopeStdErrorBpsPerSec: slopeStdError,
    slopeZScore: slope / (slopeStdError + EPSILON),
    coefficients: [c0, c1, c2],
  };
}

export function ordinaryEndpointQuadratic(
  observations: readonly TimedValue[], now: number, windowSec: number, config: RegressionConfig,
): RegressionResult {
  return robustEndpointQuadratic(observations, now, windowSec, { ...config, irlsIterations: 1, huberK: Number.POSITIVE_INFINITY });
}
