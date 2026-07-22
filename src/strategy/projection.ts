import { clip } from "../utils/statistics.js";

export interface ProjectionResult {
  velocityContributionBps: number;
  rawAccelerationContributionBps: number;
  accelerationCapBps: number;
  boundedAccelerationContributionBps: number;
  projectedMoveBps: number;
}

export function boundedProjectionBps(
  slopeBpsPerSec: number,
  accelerationBpsPerSec2: number,
  horizonSec: number,
  realizedMovement10Bps: number,
  accelerationRvCapFraction: number,
): ProjectionResult {
  const velocity = slopeBpsPerSec * horizonSec;
  const rawAcceleration = 0.5 * accelerationBpsPerSec2 * horizonSec ** 2;
  const cap = Math.min(Math.abs(velocity), accelerationRvCapFraction * realizedMovement10Bps);
  const boundedAcceleration = clip(rawAcceleration, -cap, cap);
  return {
    velocityContributionBps: velocity,
    rawAccelerationContributionBps: rawAcceleration,
    accelerationCapBps: cap,
    boundedAccelerationContributionBps: boundedAcceleration,
    projectedMoveBps: velocity + boundedAcceleration,
  };
}

export function ensembleProjection(fast: number, medium: number, fastWeight: number): number {
  return fastWeight * fast + (1 - fastWeight) * medium;
}
