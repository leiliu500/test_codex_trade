import type { EngineConfig } from "../config.js";
import type { FeatureSnapshot, OptionQuote, PositionState } from "../types.js";
import { parseClock, secondsSinceMidnight } from "../utils/time.js";

export interface TradeStateEstimate {
  position: PositionState;
  markPrice: number;
  liquidationPrice: number;
  executablePnl: number;
  midpointPnl: number;
  relativeSpread: number;
  quoteAgeMs: number;
  noiseAllowanceDollars: number;
  microstructureAllowanceDollars: number;
}

/**
 * Causal estimator for a long option position. Midpoint is diagnostic only:
 * state transitions, recovery, floors, and hard risk all use executable P&L.
 */
export class TradeStateEstimator {
  readonly #config: EngineConfig;

  constructor(config: EngineConfig) {
    this.#config = config;
  }

  estimate(
    original: PositionState,
    quote: OptionQuote,
    timestamp: number,
    feature?: FeatureSnapshot,
  ): TradeStateEstimate {
    const position: PositionState = { ...original };
    const spread = Math.max(0, quote.askPrice - quote.bidPrice);
    const markPrice = (quote.bidPrice + quote.askPrice) / 2;
    const adverseFillError = spread * this.#config.execution.adverseFillSpreadFraction;
    const liquidationPrice = Math.max(0, quote.bidPrice - adverseFillError);
    const multiplier = 100 * position.quantity;
    const executablePnl = multiplier * (liquidationPrice - position.averageEntryPrice);
    const midpointPnl = multiplier * (markPrice - position.averageEntryPrice);
    const previousPnl = position.executablePnl;
    const previousTimestamp = position.lastPnlTimestamp;
    const elapsedSec = Math.max(0, (timestamp - previousTimestamp) / 1000);
    const pnlChanged = Math.abs(executablePnl - previousPnl) > Number.EPSILON;

    position.previousExecutablePnl = previousPnl;
    position.executablePnl = executablePnl;
    position.highWaterPnl = Math.max(position.highWaterPnl, executablePnl);
    position.lowWaterPnl = Math.min(position.lowWaterPnl, executablePnl);

    if (executablePnl > original.highWaterPnl) position.lastHighTimestamp = timestamp;

    if (elapsedSec > 0 && pnlChanged) {
      const lambda = 1 - Math.exp(-Math.LN2 * elapsedSec / this.#config.risk.pnlEwmaHalfLifeSec);
      const previousDrift = position.pnlEwmaDriftPerSec;
      const observedDrift = (executablePnl - previousPnl) / elapsedSec;
      const residual = executablePnl - previousPnl - previousDrift * elapsedSec;
      const observedVariancePerSec = residual * residual / elapsedSec;
      position.pnlEwmaDriftPerSec = (1 - lambda) * previousDrift + lambda * observedDrift;
      position.pnlEwmaVariancePerSec =
        (1 - lambda) * position.pnlEwmaVariancePerSec + lambda * observedVariancePerSec;
      position.pnlObservationCount += 1;
      position.lastPnlTimestamp = timestamp;
    }

    const pnlSign = sign(executablePnl);
    const previousSign = position.previousPnlSign ?? 0;
    if (previousSign !== 0 && pnlSign !== 0 && previousSign !== pnlSign) {
      position.zeroCrossings += 1;
    }
    position.previousPnlSign = pnlSign;

    if (feature?.fast &&
        Number.isFinite(feature.fast.normalizedSlope) &&
        feature.timestamp > (position.lastReversalFeatureTimestamp ?? position.entryTimestamp)) {
      const directionSign = position.direction === "BULLISH" ? 1 : -1;
      const signedSlope = directionSign * feature.fast.normalizedSlope;
      position.reversalCusum = Math.max(
        0,
        position.reversalCusum - signedSlope - this.#config.risk.reversalCusumReference,
      );
      position.lastReversalFeatureTimestamp = feature.timestamp;
    }

    const tradeState = position.tradeState;
    if (tradeState === "OPEN_UNPROTECTED" || tradeState === "PROTECTED_SOFT") {
      const meaningfulAdversePath =
        position.lowWaterPnl <= -this.#config.risk.meaningfulAdverseExcursionDollars;
      if (!meaningfulAdversePath &&
          executablePnl >= this.#config.risk.directWinnerActivationDollars) {
        position.tradeState = "PROTECTED_WINNER";
        position.protectionActivatedAt = timestamp;
        delete position.softProtectionCandidateObservationCount;
      } else if (meaningfulAdversePath &&
          executablePnl >= this.#config.risk.recoveredActivationDollars) {
        position.tradeState = "PROTECTED_RECOVERED";
        position.protectionActivatedAt = timestamp;
        delete position.softProtectionCandidateObservationCount;
      }
    }

    if (position.tradeState === "OPEN_UNPROTECTED") {
      if (executablePnl >= this.#config.risk.softProtectionActivationDollars) {
        if (position.softProtectionCandidateObservationCount === undefined) {
          position.softProtectionCandidateObservationCount = position.pnlObservationCount;
        }
        const candidateObservationCount = position.softProtectionCandidateObservationCount;
        if (position.pnlObservationCount - candidateObservationCount >=
            this.#config.risk.softProtectionConfirmationObservations) {
          position.tradeState = "PROTECTED_SOFT";
          position.softProtectionActivatedAt = timestamp;
          delete position.softProtectionCandidateObservationCount;
        }
      } else {
        // Confirmation must be consecutive. A failed touch must not leave a
        // stale latch that arms protection during a later pullback.
        delete position.softProtectionCandidateObservationCount;
      }
    }

    const horizonSec = this.#config.signals.projectionHorizonSec;
    const noiseAllowanceDollars = this.#config.risk.pnlNoiseMultiplier *
      Math.sqrt(Math.max(0, position.pnlEwmaVariancePerSec) * horizonSec);
    const microstructureAllowanceDollars = multiplier *
      (spread * (1 + this.#config.execution.adverseFillSpreadFraction) +
        this.#config.execution.optionTickSize);

    if (position.tradeState === "PROTECTED_SOFT") {
      // Executable P&L already includes adverse-fill spread cost, so the soft
      // floor stays deliberately loose without subtracting that cost twice.
      // Low retention plus a hard cap protects a small win while preserving
      // pullback room for a trade that has not yet proven itself.
      const peak = Math.max(0, position.highWaterPnl);
      const candidateFloor = clamp(
        peak * this.#config.risk.softProtectionRetentionRatio,
        this.#config.risk.softProtectionMinimumFloorDollars,
        this.#config.risk.softProtectionMaximumFloorDollars,
      );
      position.protectedFloorPnl = Math.max(
        position.protectedFloorPnl ??
          this.#config.risk.softProtectionMinimumFloorDollars,
        candidateFloor,
      );
    } else if (position.tradeState === "PROTECTED_WINNER" ||
        position.tradeState === "PROTECTED_RECOVERED") {
      const peak = Math.max(0, position.highWaterPnl);
      const peakProgress = 1 - Math.exp(
        -peak / this.#config.risk.profitRetentionPeakScaleDollars,
      );
      const currentSeconds = secondsSinceMidnight(timestamp, this.#config.timeZone);
      const forcedSeconds = parseClock(this.#config.session.forceExit);
      const timeRemainingSec = Math.max(0, forcedSeconds - currentSeconds);
      const timeTightening = clamp(
        1 - timeRemainingSec / Math.max(1, this.#config.risk.maxHoldSec),
        0,
        1,
      );
      const recoveredBonus = position.tradeState === "PROTECTED_RECOVERED"
        ? this.#config.risk.recoveredRetentionBonus
        : 0;
      const retainedRatio = clamp(
        this.#config.risk.profitRetentionBase +
          (this.#config.risk.profitRetentionMax - this.#config.risk.profitRetentionBase) * peakProgress +
          recoveredBonus +
          this.#config.risk.timeRetentionBonus * timeTightening,
        this.#config.risk.profitRetentionBase,
        this.#config.risk.profitRetentionMax,
      );
      const percentAllowance = (1 - retainedRatio) * peak;
      const givebackAllowance = Math.max(
        microstructureAllowanceDollars,
        noiseAllowanceDollars,
        percentAllowance,
      );
      position.protectedFloorPnl = Math.max(
        position.protectedFloorPnl ?? this.#config.risk.minimumProfitFloorDollars,
        this.#config.risk.minimumProfitFloorDollars,
        peak - givebackAllowance,
      );
    }

    return {
      position,
      markPrice,
      liquidationPrice,
      executablePnl,
      midpointPnl,
      relativeSpread: spread / Math.max(Number.EPSILON, markPrice),
      quoteAgeMs: timestamp - quote.timestamp,
      noiseAllowanceDollars,
      microstructureAllowanceDollars,
    };
  }
}

/** Diffusion baseline from the design: probability of U before L. */
export function firstPassageUpperProbability(
  x: number,
  lower: number,
  upper: number,
  driftPerSec: number,
  variancePerSec: number,
): number {
  if (!(lower < upper) || ![x, lower, upper, driftPerSec, variancePerSec].every(Number.isFinite)) {
    return 0;
  }
  if (x <= lower) return 0;
  if (x >= upper) return 1;
  if (variancePerSec <= Number.EPSILON) return driftPerSec > 0 ? 1 : 0;
  if (Math.abs(driftPerSec) <= Number.EPSILON) {
    return clamp((x - lower) / (upper - lower), 0, 1);
  }
  const numerator = 1 - Math.exp(clamp(
    -2 * driftPerSec * (x - lower) / variancePerSec,
    -700,
    700,
  ));
  const denominator = 1 - Math.exp(clamp(
    -2 * driftPerSec * (upper - lower) / variancePerSec,
    -700,
    700,
  ));
  if (Math.abs(denominator) <= Number.EPSILON) {
    return clamp((x - lower) / (upper - lower), 0, 1);
  }
  return clamp(numerator / denominator, 0, 1);
}

function sign(value: number): -1 | 0 | 1 {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
