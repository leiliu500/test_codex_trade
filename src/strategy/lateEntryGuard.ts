import type { EngineConfig } from "../config.js";
import type { Direction, FeatureSnapshot, RegimeDecision, TradeSignal } from "../types.js";
import { parseClock, secondsSinceMidnight } from "../utils/time.js";

export type StaticEntryGuardReasonPrefix = "MORNING_ENTRY_" | "LATE_ENTRY_";

export interface ActiveStaticEntryGuard {
  reasonPrefix: StaticEntryGuardReasonPrefix;
  minProjectedMoveBps: number;
  minCostMarginBps: number;
  maxOptionSpreadPct: number;
}

export function morningEntryGuardActive(
  config: EngineConfig,
  timestamp: number,
): boolean {
  const seconds = secondsSinceMidnight(timestamp, config.timeZone);
  return config.signals.morningEntryGuard.mode === "ENFORCE" &&
    seconds >= parseClock(config.signals.morningEntryGuard.start) &&
    seconds < parseClock(config.signals.morningEntryGuard.end);
}

export function lateEntryGuardActive(
  config: EngineConfig,
  timestamp: number,
): boolean {
  return config.signals.lateEntryGuard.mode === "ENFORCE" &&
    secondsSinceMidnight(timestamp, config.timeZone) >= parseClock(config.signals.lateEntryGuard.start);
}

export function activeStaticEntryGuard(
  config: EngineConfig,
  timestamp: number,
): ActiveStaticEntryGuard | undefined {
  if (morningEntryGuardActive(config, timestamp)) {
    return {
      reasonPrefix: "MORNING_ENTRY_",
      minProjectedMoveBps: config.signals.morningEntryGuard.minProjectedMoveBps,
      minCostMarginBps: config.signals.morningEntryGuard.minCostMarginBps,
      maxOptionSpreadPct: config.signals.morningEntryGuard.maxOptionSpreadPct,
    };
  }
  if (lateEntryGuardActive(config, timestamp)) {
    return {
      reasonPrefix: "LATE_ENTRY_",
      minProjectedMoveBps: config.signals.lateEntryGuard.minProjectedMoveBps,
      minCostMarginBps: config.signals.lateEntryGuard.minCostMarginBps,
      maxOptionSpreadPct: config.signals.lateEntryGuard.maxOptionSpreadPct,
    };
  }
  return undefined;
}

export function isBullishTrendContinuationFeature(
  config: EngineConfig,
  direction: Direction,
  feature: FeatureSnapshot,
  regime: RegimeDecision["regime"],
  directionalProjectionBps: number,
): boolean {
  const profile = config.signals.bullishTrendContinuation;
  const bullishTrendRegime = regime === "STRONG_UP" ||
    regime === "GRIND_UP" ||
    regime === "GAP_AND_GO_UP";
  return profile.enabled &&
    direction === "BULLISH" &&
    bullishTrendRegime &&
    directionalProjectionBps >= profile.minDirectionalProjectionBps &&
    feature.fast.noiseFloorBps <= profile.maxFastNoiseFloorBps &&
    feature.fast.normalizedSlope >= profile.minFastNormalizedSlope &&
    feature.medium.normalizedSlope >= config.signals.grindMediumSlopeScore &&
    (feature.medium.regression.r2 ?? -Infinity) >= profile.minMediumR2 &&
    feature.slow.normalizedSlope >= config.signals.grindSlowSlopeScore &&
    (feature.slow.regression.r2 ?? -Infinity) >= profile.minSlowR2 &&
    feature.efficiency60 >= feature.thresholds.efficiency60 &&
    (feature.vwap.rollingVwapSlopeBpsPerSec ?? -Infinity) > 0 &&
    feature.fast.normalizedAcceleration >= config.signals.grindNegativeAccelerationLimit &&
    feature.ofi5 >= feature.thresholds.absoluteOfi5;
}

export function projectedMoveContinuationGuard(
  config: EngineConfig,
  signal: TradeSignal,
): ActiveStaticEntryGuard | undefined {
  const guard = activeStaticEntryGuard(config, signal.timestamp);
  return guard &&
    signal.projectedMoveBps < guard.minProjectedMoveBps &&
    isBullishTrendContinuationFeature(
      config,
      signal.direction,
      signal.featureSnapshot,
      signal.regime,
      signal.projectedMoveBps,
    )
    ? guard
    : undefined;
}

export function morningEntryGuardAudit(
  config: EngineConfig,
  timestamp: number,
): Record<string, unknown> {
  return {
    mode: config.signals.morningEntryGuard.mode,
    active: morningEntryGuardActive(config, timestamp),
    start: config.signals.morningEntryGuard.start,
    end: config.signals.morningEntryGuard.end,
    minProjectedMoveBps: config.signals.morningEntryGuard.minProjectedMoveBps,
    minCostMarginBps: config.signals.morningEntryGuard.minCostMarginBps,
    maxOptionSpreadPct: config.signals.morningEntryGuard.maxOptionSpreadPct,
    ofiConflictRequiresFollowThrough:
      config.signals.morningEntryGuard.ofiConflictRequiresFollowThrough,
    bullishGrindRequiresUpRegime:
      config.signals.morningEntryGuard.bullishGrindRequiresUpRegime,
    followThrough: config.signals.entryConfirmationMode === "ENFORCE"
      ? config.signals.followThroughScope
      : "DISABLED",
    followThroughMinSec: config.signals.followThroughMinSec,
    followThroughMaxSec: config.signals.followThroughMaxSec,
    followThroughMinimumBps: config.signals.followThroughMinimumBps,
    followThroughNoiseMultiplier: config.signals.followThroughNoiseMultiplier,
    bullishTrendContinuation: {
      ...config.signals.bullishTrendContinuation,
    },
  };
}

export function lateEntryGuardAudit(
  config: EngineConfig,
  timestamp: number,
): Record<string, unknown> {
  return {
    mode: config.signals.lateEntryGuard.mode,
    active: lateEntryGuardActive(config, timestamp),
    start: config.signals.lateEntryGuard.start,
    maxDailyEntries: config.signals.lateEntryGuard.maxDailyEntries,
    minProjectedMoveBps: config.signals.lateEntryGuard.minProjectedMoveBps,
    minCostMarginBps: config.signals.lateEntryGuard.minCostMarginBps,
    maxOptionSpreadPct: config.signals.lateEntryGuard.maxOptionSpreadPct,
    followThroughMinSec: config.signals.lateEntryGuard.followThroughMinSec,
    followThroughMaxSec: config.signals.lateEntryGuard.followThroughMaxSec,
    followThroughMinimumBps: config.signals.lateEntryGuard.followThroughMinimumBps,
    followThroughNoiseMultiplier: config.signals.followThroughNoiseMultiplier,
    bearishGrindRequiresFollowThrough:
      config.signals.lateEntryGuard.bearishGrindRequiresFollowThrough,
    bearishUnclassifiedImpulseMinMediumToFastRatio:
      config.signals.lateEntryGuard.bearishUnclassifiedImpulseMinMediumToFastRatio,
    bullishGrindMinMediumNormalizedSlope:
      config.signals.lateEntryGuard.bullishGrindMinMediumNormalizedSlope,
    bullishGrindMinEfficiency60:
      config.signals.lateEntryGuard.bullishGrindMinEfficiency60,
    bullishNoisyGrindMinMediumToFastRatio:
      config.signals.lateEntryGuard.bullishNoisyGrindMinMediumToFastRatio,
    bullishTrendContinuation: {
      ...config.signals.bullishTrendContinuation,
    },
    bullishLowNoiseGrind: {
      ...config.signals.lateEntryGuard.bullishLowNoiseGrind,
    },
    bullishGrindOptionConfirmation: {
      ...config.signals.lateEntryGuard.bullishGrindOptionConfirmation,
    },
    bearishUnclassifiedImpulseFollowThroughStart:
      config.signals.lateEntryGuard.bearishUnclassifiedImpulseFollowThroughStart,
    bearishStrongDownImpulse: {
      followThroughMinSec:
        config.signals.lateEntryGuard.bearishStrongDownImpulse.followThroughMinSec,
      followThroughMaxSec:
        config.signals.lateEntryGuard.bearishStrongDownImpulse.followThroughMaxSec,
      followThroughMinimumBps:
        config.signals.lateEntryGuard.bearishStrongDownImpulse.followThroughMinimumBps,
    },
  };
}
