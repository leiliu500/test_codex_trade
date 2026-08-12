import defaultConfigJson from "../config/default.json" with { type: "json" };
import qqqConfigJson from "../config/qqq.json" with { type: "json" };
import googlConfigJson from "../config/googl.json" with { type: "json" };
import { parseClock } from "./utils/time.js";
import type { UnderlyingSymbol } from "./types.js";

export type FollowThroughScope = "BULLISH_IMPULSE" | "IMPULSE" | "ALL";
export type EntryConfirmationMode = "SHADOW" | "ENFORCE";
export type LateEntryGuardMode = "DISABLED" | "ENFORCE";
export type MorningEntryGuardMode = "DISABLED" | "ENFORCE";

export interface EngineConfig {
  version: string;
  symbol: UnderlyingSymbol;
  timeZone: string;
  session: {
    marketOpen: string;
    openingRangeEnd: string;
    entryStart: string;
    entryEnd: string;
    forceExit: string;
  };
  dataQuality: {
    maxStockQuoteAgeMs: number;
    maxOptionQuoteAgeMs: number;
    maxStockSpreadBps: number;
    maxOptionSpreadPct: number;
    minQuotesPerSecond: number;
    sizeWinsorWindow: number;
    sizeWinsorQuantile: number;
    fixedMaxSizeLots: number;
  };
  regression: {
    fastWindowSec: number;
    mediumWindowSec: number;
    slowWindowSec: number;
    rollingVwapSlopeWindowSec: number;
    halfLifeFraction: number;
    huberK: number;
    irlsIterations: number;
    minimumCoverageFraction: number;
    minimumPoints: number;
    noiseFloorBps: number;
  };
  signals: {
    entryConfirmationMode: EntryConfirmationMode;
    minEfficiency60: number;
    minR2Medium: number;
    impulseFastSlopeScore: number;
    impulseAccelerationScore: number;
    impulseOfi5: number;
    impulseVotesRequired: number;
    grindMediumSlopeScore: number;
    grindSlowSlopeScore: number;
    grindNegativeAccelerationLimit: number;
    openingRangeNearBps: number;
    openingRangeRetestBps: number;
    breakoutMemorySec: number;
    projectionHorizonSec: number;
    projectionAccelerationRvCap: number;
    costMultiplier: number;
    sameDirectionCooldownSec: number;
    oppositeDirectionCooldownSec: number;
    protectedExitReentry: {
      enabled: boolean;
      cooldownSec: number;
      windowSec: number;
      requiresStrongRegime: boolean;
    };
    minimumSignalIntervalSec: number;
    lateBullishImpulseStart: string;
    lateBullishImpulseRequiresUpRegime: boolean;
    bullishImpulseCutoff: string;
    followThroughMinSec: number;
    followThroughMaxSec: number;
    followThroughMinimumBps: number;
    followThroughNoiseMultiplier: number;
    followThroughScope: FollowThroughScope;
    shadowFollowThroughScope: FollowThroughScope | "DISABLED";
    bullishTrendContinuation: {
      enabled: boolean;
      minDirectionalProjectionBps: number;
      maxFastNoiseFloorBps: number;
      minFastNormalizedSlope: number;
      minMediumR2: number;
      minSlowR2: number;
    };
    morningEntryGuard: {
      mode: MorningEntryGuardMode;
      start: string;
      end: string;
      minProjectedMoveBps: number;
      minCostMarginBps: number;
      maxOptionSpreadPct: number;
      ofiConflictRequiresFollowThrough: boolean;
      bullishGrindRequiresUpRegime: boolean;
    };
    lateEntryGuard: {
      mode: LateEntryGuardMode;
      start: string;
      maxDailyEntries: number;
      minProjectedMoveBps: number;
      minCostMarginBps: number;
      maxOptionSpreadPct: number;
      followThroughMinSec: number;
      followThroughMaxSec: number;
      followThroughMinimumBps: number;
      bearishGrindRequiresFollowThrough: boolean;
      bearishUnclassifiedImpulseMinMediumToFastRatio: number;
      bullishGrindMinMediumNormalizedSlope: number;
      bullishNoisyGrindMinMediumToFastRatio: number;
      bullishLowNoiseGrind: {
        enabled: boolean;
        maxFastNoiseFloorBps: number;
        minFastNormalizedSlope: number;
        minMediumNormalizedSlope: number;
        minMediumR2: number;
        minSlowNormalizedSlope: number;
        minSlowR2: number;
        reentryCooldownSec: number;
      };
      bullishGrindOptionConfirmation: {
        enabled: boolean;
        minSec: number;
        maxSec: number;
        minimumBidImprovement: number;
        minimumProjectedMoveBps: number;
      };
      bearishCleanImpulse: {
        enabled: boolean;
        minDirectionalProjectionBps: number;
        minFastEfficiency: number;
        minFastNormalizedSlope: number;
        minMediumNormalizedSlope: number;
        minMediumR2: number;
        minSlowNormalizedSlope: number;
        minSlowR2: number;
        minEfficiency60: number;
        minCostMarginBps: number;
        maxOptionSpreadPct: number;
        maxOptionSpreadTicks: number;
        maxEntryQuoteAgeMs: number;
      };
      bearishUnclassifiedImpulseFollowThroughStart: string;
      bearishStrongDownImpulse: {
        followThroughMinSec: number;
        followThroughMaxSec: number;
        followThroughMinimumBps: number;
      };
    };
    blockWhipsaw: boolean;
  };
  regimes: {
    strongSlope30: number;
    strongSlope120: number;
    grindSlope30: number;
    grindSlope120: number;
    minimumTrendEfficiency: number;
    chopEfficiency: number;
    whipsawSignChanges60: number;
    wideOpeningRangePercentile: number;
    highRvPercentile: number;
    gapAndGoMinBps: number;
  };
  options: {
    expirationDaysMin: number;
    expirationDaysMax: number;
    zeroDteEntryCutoff: string;
    strikeRangePct: number;
    targetAbsDelta: number;
    minAbsDelta: number;
    maxAbsDelta: number;
    minOptionMid: number;
    maxOptionMid: number;
    minDailyVolume: number;
    minOpenInterest: number;
    minDailyVolumeForOpenInterestFallback: number;
    subscriptionCandidatesPerSide: number;
    chainRefreshSec: number;
    riskFreeRate: number;
    dividendYield: number;
    maxImpliedVolatility: number;
    fallbackImpliedVolatility: number;
    slippagePerSidePctOfSpread: number;
    microstructure: {
      enabled: boolean;
      windowSec: number;
      snapshotRefreshSec: number;
      minimumQuoteEvents: number;
      minimumEntryScore: number;
      maximumSpreadExpansionRatio: number;
      minimumChainAverageScore: number;
      minimumChainObservedContracts: number;
      scoreWeight: number;
      chainScoreWeight: number;
      thetaCostMultiplier: number;
      adverseIvMovePoints: number;
    };
  };
  execution: {
    entryLimitSpreadFraction: number;
    exitLimitSpreadFraction: number;
    replaceAfterMs: number;
    maxReplaces: number;
    cancelAfterMs: number;
    orderPollMs: number;
    optionTickSize: number;
    entrySignalTtlMs: number;
    maxEntryQuoteAgeMs: number;
    optionSelectionRetryMs: number;
    adverseFillSpreadFraction: number;
    exitTtlMinMs: number;
    exitTtlMaxMs: number;
    exitPriceCollarPct: number;
    exitMarketableOffsetTicks: number;
    entryMicrostructureAggressionAdjustment: number;
    entryMicrostructureCancelScore: number;
    entrySpreadExpansionCancelRatio: number;
    entryReplaceMinMs: number;
    exitMicrostructureUrgencyAdjustment: number;
    executionQualityProbeSec: number[];
  };
  risk: {
    riskFractionOfEquity: number;
    maxRiskDollarsPerTrade: number;
    maxPremiumDollarsPerTrade: number;
    maxContracts: number;
    maxPositionsPerUnderlying: number;
    maxTradesPerDay: number;
    maxDailyLossDollars: number;
    hardOptionStopPct: number;
    maxHoldSec: number;
    trendInvalidationGraceSec: number;
    oppositeRegimeGraceSec: number;
    oppositeRegimeMinimumObservations: number;
    staleDataEmergencySec: number;
    onePositionAtATime: boolean;
    softProtectionActivationDollars: number;
    softProtectionRecoveryActivationDollars: number;
    softProtectionConfirmationObservations: number;
    softProtectionRetentionRatio: number;
    softProtectionMinimumFloorDollars: number;
    softProtectionMaximumFloorDollars: number;
    softFloorBreachConfirmationMs: number;
    softFloorBreachMinimumObservations: number;
    softProtectionEmergencyLossDollars: number;
    minimumProfitFloorDollars: number;
    directWinnerActivationDollars: number;
    recoveredActivationDollars: number;
    meaningfulAdverseExcursionDollars: number;
    recoveryDeadlineSec: number;
    stallSec: number;
    profitRetentionBase: number;
    profitRetentionMax: number;
    profitRetentionPeakScaleDollars: number;
    recoveredRetentionBonus: number;
    timeRetentionBonus: number;
    pnlEwmaHalfLifeSec: number;
    pnlNoiseMultiplier: number;
    reversalCusumReference: number;
    reversalCusumThreshold: number;
    recoveryProbabilityMinAgeSec: number;
    recoveryProbabilityMinObservations: number;
    recoveryProbabilityGraceSec: number;
    optionSnapshotMaxAgeSec: number;
    greeksExitGraceSec: number;
    protectedGreeksExitGraceSec: number;
    continuationConfidenceZ: number;
    continuationSpreadCostFraction: number;
    ivCrushThreshold: number;
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

export const defaultConfig = deepFreeze(defaultConfigJson as EngineConfig);

export function mergeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  const merge = (base: unknown, next: unknown): unknown => {
    if (!next || typeof next !== "object" || Array.isArray(next)) return next ?? base;
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(next)) {
      out[key] = merge(out[key], value);
    }
    return out;
  };
  return merge(defaultConfig, overrides) as EngineConfig;
}

/** QQQ starts from the unchanged SPY baseline but has an independent versioned override surface. */
export const qqqConfig = deepFreeze(mergeConfig(qqqConfigJson as Partial<EngineConfig>));

/** GOOGL starts from the SPY baseline and remains isolated behind its own versioned override surface. */
export const googlConfig = deepFreeze(mergeConfig(googlConfigJson as Partial<EngineConfig>));

export function validateConfig(config: EngineConfig): void {
  const fractions = [
    config.regression.halfLifeFraction,
    config.dataQuality.sizeWinsorQuantile,
    config.signals.projectionAccelerationRvCap,
    config.execution.entryLimitSpreadFraction,
    config.execution.exitLimitSpreadFraction,
    config.execution.adverseFillSpreadFraction,
    config.execution.exitPriceCollarPct,
    config.execution.entryMicrostructureAggressionAdjustment,
    config.execution.exitMicrostructureUrgencyAdjustment,
    config.risk.softProtectionRetentionRatio,
    config.risk.profitRetentionBase,
    config.risk.profitRetentionMax,
    config.risk.recoveredRetentionBonus,
    config.risk.timeRetentionBonus,
    config.risk.continuationSpreadCostFraction,
  ];
  if (fractions.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) {
    throw new Error("Configuration contains a fraction outside [0, 1]");
  }
  if (!(config.regression.fastWindowSec < config.regression.mediumWindowSec &&
        config.regression.mediumWindowSec < config.regression.slowWindowSec)) {
    throw new Error("Regression windows must be strictly increasing");
  }
  if (config.regression.minimumPoints < 3 || config.regression.irlsIterations < 1) {
    throw new Error("Regression requires at least 3 points and one IRLS iteration");
  }
  if (config.options.expirationDaysMin !== 0 || config.options.expirationDaysMax !== 0) {
    throw new Error(`The ${config.symbol} engine is hard-limited to options expiring on the current market date (0DTE)`);
  }
  if (!(Number.isFinite(config.options.minDailyVolume) && config.options.minDailyVolume >= 0 &&
        Number.isFinite(config.options.minOpenInterest) && config.options.minOpenInterest >= 0 &&
        Number.isFinite(config.options.minDailyVolumeForOpenInterestFallback) &&
        config.options.minDailyVolumeForOpenInterestFallback >= config.options.minDailyVolume)) {
    throw new Error("Option liquidity thresholds are invalid");
  }
  if (!(typeof config.options.microstructure.enabled === "boolean" &&
        Number.isFinite(config.options.microstructure.windowSec) &&
        config.options.microstructure.windowSec >= 1 &&
        Number.isFinite(config.options.microstructure.snapshotRefreshSec) &&
        config.options.microstructure.snapshotRefreshSec >= 5 &&
        config.options.microstructure.snapshotRefreshSec <= config.options.chainRefreshSec &&
        Number.isInteger(config.options.microstructure.minimumQuoteEvents) &&
        config.options.microstructure.minimumQuoteEvents >= 1 &&
        config.options.microstructure.minimumEntryScore >= -1 &&
        config.options.microstructure.minimumEntryScore <= 1 &&
        config.options.microstructure.maximumSpreadExpansionRatio >= 1 &&
        config.options.microstructure.minimumChainAverageScore >= -1 &&
        config.options.microstructure.minimumChainAverageScore <= 1 &&
        Number.isInteger(config.options.microstructure.minimumChainObservedContracts) &&
        config.options.microstructure.minimumChainObservedContracts >= 1 &&
        config.options.microstructure.scoreWeight >= 0 &&
        config.options.microstructure.chainScoreWeight >= 0 &&
        config.options.microstructure.thetaCostMultiplier >= 0 &&
        config.options.microstructure.adverseIvMovePoints >= 0)) {
    throw new Error("Option microstructure settings are invalid");
  }
  const entryStart = parseClock(config.session.entryStart);
  const lateBullishImpulseStart = parseClock(config.signals.lateBullishImpulseStart);
  const bullishImpulseCutoff = parseClock(config.signals.bullishImpulseCutoff);
  const morningEntryGuardStart = parseClock(config.signals.morningEntryGuard.start);
  const morningEntryGuardEnd = parseClock(config.signals.morningEntryGuard.end);
  const lateEntryGuardStart = parseClock(config.signals.lateEntryGuard.start);
  const bearishUnclassifiedImpulseFollowThroughStart = parseClock(
    config.signals.lateEntryGuard.bearishUnclassifiedImpulseFollowThroughStart,
  );
  const zeroDteCutoff = parseClock(config.options.zeroDteEntryCutoff);
  const entryEnd = parseClock(config.session.entryEnd);
  const forceExit = parseClock(config.session.forceExit);
  if (!(entryStart < zeroDteCutoff && zeroDteCutoff <= entryEnd && entryEnd < forceExit && forceExit < parseClock("16:00:00"))) {
    throw new Error("Day-trade timing requires entryStart < 0DTE cutoff <= entryEnd < forceExit < 16:00 ET");
  }
  if (!(entryStart <= lateBullishImpulseStart && lateBullishImpulseStart <= entryEnd)) {
    throw new Error("Late bullish impulse confirmation must begin inside the entry window");
  }
  if (!(lateBullishImpulseStart <= bullishImpulseCutoff && bullishImpulseCutoff <= zeroDteCutoff)) {
    throw new Error("Bullish impulse cutoff must follow late confirmation and precede the 0DTE cutoff");
  }
  if (!(entryStart <= lateEntryGuardStart && lateEntryGuardStart <= zeroDteCutoff)) {
    throw new Error("Late-entry guard must start inside the executable entry window");
  }
  if (!(lateEntryGuardStart <= bearishUnclassifiedImpulseFollowThroughStart &&
        bearishUnclassifiedImpulseFollowThroughStart <= zeroDteCutoff)) {
    throw new Error(
      "Late bearish unclassified impulse confirmation must begin between the late-entry start and 0DTE cutoff",
    );
  }
  if (!(entryStart <= morningEntryGuardStart &&
        morningEntryGuardStart < morningEntryGuardEnd &&
        morningEntryGuardEnd === lateEntryGuardStart)) {
    throw new Error("Morning-entry guard must satisfy entryStart <= start < end = late-entry guard start");
  }
  if (!(config.signals.followThroughMinSec >= 0 &&
        config.signals.followThroughMaxSec >= config.signals.followThroughMinSec &&
        config.signals.followThroughMinimumBps >= 0 &&
        config.signals.followThroughNoiseMultiplier >= 0)) {
    throw new Error(
      "Follow-through confirmation requires 0 <= minSec <= maxSec and non-negative bps/noise multiplier",
    );
  }
  if (!(typeof config.signals.bullishTrendContinuation.enabled === "boolean" &&
        Number.isFinite(config.signals.bullishTrendContinuation.minDirectionalProjectionBps) &&
        config.signals.bullishTrendContinuation.minDirectionalProjectionBps > 0 &&
        Number.isFinite(config.signals.bullishTrendContinuation.maxFastNoiseFloorBps) &&
        config.signals.bullishTrendContinuation.maxFastNoiseFloorBps > 0 &&
        Number.isFinite(config.signals.bullishTrendContinuation.minFastNormalizedSlope) &&
        config.signals.bullishTrendContinuation.minFastNormalizedSlope > 0 &&
        Number.isFinite(config.signals.bullishTrendContinuation.minMediumR2) &&
        config.signals.bullishTrendContinuation.minMediumR2 >= 0 &&
        config.signals.bullishTrendContinuation.minMediumR2 <= 1 &&
        Number.isFinite(config.signals.bullishTrendContinuation.minSlowR2) &&
        config.signals.bullishTrendContinuation.minSlowR2 >= 0 &&
        config.signals.bullishTrendContinuation.minSlowR2 <= 1)) {
    throw new Error("Bullish trend-continuation thresholds are invalid");
  }
  if (!(Number.isFinite(config.signals.sameDirectionCooldownSec) &&
        config.signals.sameDirectionCooldownSec >= 0 &&
        Number.isFinite(config.signals.oppositeDirectionCooldownSec) &&
        config.signals.oppositeDirectionCooldownSec >= 0 &&
        typeof config.signals.protectedExitReentry.enabled === "boolean" &&
        Number.isFinite(config.signals.protectedExitReentry.cooldownSec) &&
        config.signals.protectedExitReentry.cooldownSec >= 0 &&
        Number.isFinite(config.signals.protectedExitReentry.windowSec) &&
        config.signals.protectedExitReentry.windowSec >=
          config.signals.protectedExitReentry.cooldownSec &&
        config.signals.protectedExitReentry.windowSec <=
          config.signals.sameDirectionCooldownSec &&
        typeof config.signals.protectedExitReentry.requiresStrongRegime === "boolean" &&
        Number.isFinite(config.signals.minimumSignalIntervalSec) &&
        config.signals.minimumSignalIntervalSec >= 0)) {
    throw new Error("Signal cooldowns and minimum interval must be finite and non-negative");
  }
  const scopes = new Set<FollowThroughScope>(["BULLISH_IMPULSE", "IMPULSE", "ALL"]);
  if (!scopes.has(config.signals.followThroughScope) ||
      (config.signals.shadowFollowThroughScope !== "DISABLED" && !scopes.has(config.signals.shadowFollowThroughScope))) {
    throw new Error("Follow-through scope must be BULLISH_IMPULSE, IMPULSE, ALL, or DISABLED for shadow evaluation");
  }
  if (!new Set<EntryConfirmationMode>(["SHADOW", "ENFORCE"]).has(config.signals.entryConfirmationMode)) {
    throw new Error("Entry-confirmation mode must be SHADOW or ENFORCE");
  }
  if (!new Set<LateEntryGuardMode>(["DISABLED", "ENFORCE"]).has(config.signals.lateEntryGuard.mode)) {
    throw new Error("Late-entry guard mode must be DISABLED or ENFORCE");
  }
  if (!new Set<MorningEntryGuardMode>(["DISABLED", "ENFORCE"]).has(config.signals.morningEntryGuard.mode)) {
    throw new Error("Morning-entry guard mode must be DISABLED or ENFORCE");
  }
  if (!(config.signals.morningEntryGuard.minProjectedMoveBps > 0 &&
        config.signals.morningEntryGuard.minCostMarginBps >= 0 &&
        config.signals.morningEntryGuard.maxOptionSpreadPct > 0 &&
        config.signals.morningEntryGuard.maxOptionSpreadPct <= config.dataQuality.maxOptionSpreadPct &&
        typeof config.signals.morningEntryGuard.ofiConflictRequiresFollowThrough === "boolean" &&
        typeof config.signals.morningEntryGuard.bullishGrindRequiresUpRegime === "boolean")) {
    throw new Error("Morning-entry guard thresholds are invalid");
  }
  if (!(Number.isInteger(config.signals.lateEntryGuard.maxDailyEntries) &&
        config.signals.lateEntryGuard.maxDailyEntries > 0 &&
        config.signals.lateEntryGuard.maxDailyEntries <= config.risk.maxTradesPerDay &&
        config.signals.lateEntryGuard.minProjectedMoveBps > 0 &&
        config.signals.lateEntryGuard.minCostMarginBps >= 0 &&
        config.signals.lateEntryGuard.maxOptionSpreadPct > 0 &&
        config.signals.lateEntryGuard.maxOptionSpreadPct <= config.dataQuality.maxOptionSpreadPct &&
        config.signals.lateEntryGuard.followThroughMinSec >= 0 &&
        config.signals.lateEntryGuard.followThroughMaxSec >= config.signals.lateEntryGuard.followThroughMinSec &&
        config.signals.lateEntryGuard.followThroughMinimumBps >= 0 &&
        typeof config.signals.lateEntryGuard.bearishGrindRequiresFollowThrough === "boolean" &&
        config.signals.lateEntryGuard.bearishUnclassifiedImpulseMinMediumToFastRatio >= 0 &&
        config.signals.lateEntryGuard.bearishUnclassifiedImpulseMinMediumToFastRatio <= 1 &&
        config.signals.lateEntryGuard.bullishGrindMinMediumNormalizedSlope > 0 &&
        config.signals.lateEntryGuard.bullishNoisyGrindMinMediumToFastRatio > 0 &&
        typeof config.signals.lateEntryGuard.bullishLowNoiseGrind.enabled === "boolean" &&
        config.signals.lateEntryGuard.bullishLowNoiseGrind.maxFastNoiseFloorBps > 0 &&
        config.signals.lateEntryGuard.bullishLowNoiseGrind.minFastNormalizedSlope > 0 &&
        config.signals.lateEntryGuard.bullishLowNoiseGrind.minMediumNormalizedSlope > 0 &&
        config.signals.lateEntryGuard.bullishLowNoiseGrind.minMediumR2 >= 0 &&
        config.signals.lateEntryGuard.bullishLowNoiseGrind.minMediumR2 <= 1 &&
        config.signals.lateEntryGuard.bullishLowNoiseGrind.minSlowNormalizedSlope > 0 &&
        config.signals.lateEntryGuard.bullishLowNoiseGrind.minSlowR2 >= 0 &&
        config.signals.lateEntryGuard.bullishLowNoiseGrind.minSlowR2 <= 1 &&
        config.signals.lateEntryGuard.bullishLowNoiseGrind.reentryCooldownSec >= 0 &&
        config.signals.lateEntryGuard.bullishLowNoiseGrind.reentryCooldownSec <=
          config.signals.sameDirectionCooldownSec &&
        typeof config.signals.lateEntryGuard.bullishGrindOptionConfirmation.enabled === "boolean" &&
        config.signals.lateEntryGuard.bullishGrindOptionConfirmation.minSec >= 0 &&
        config.signals.lateEntryGuard.bullishGrindOptionConfirmation.maxSec >=
          config.signals.lateEntryGuard.bullishGrindOptionConfirmation.minSec &&
        config.signals.lateEntryGuard.bullishGrindOptionConfirmation.minimumBidImprovement > 0 &&
        config.signals.lateEntryGuard.bullishGrindOptionConfirmation.minimumProjectedMoveBps > 0 &&
        config.signals.lateEntryGuard.bullishGrindOptionConfirmation.minimumProjectedMoveBps <=
          config.signals.lateEntryGuard.minProjectedMoveBps &&
        typeof config.signals.lateEntryGuard.bearishCleanImpulse.enabled === "boolean" &&
        config.signals.lateEntryGuard.bearishCleanImpulse.minDirectionalProjectionBps > 0 &&
        config.signals.lateEntryGuard.bearishCleanImpulse.minDirectionalProjectionBps <
          config.signals.lateEntryGuard.minProjectedMoveBps &&
        config.signals.lateEntryGuard.bearishCleanImpulse.minFastEfficiency > 0 &&
        config.signals.lateEntryGuard.bearishCleanImpulse.minFastEfficiency <= 1 &&
        config.signals.lateEntryGuard.bearishCleanImpulse.minFastNormalizedSlope > 0 &&
        config.signals.lateEntryGuard.bearishCleanImpulse.minMediumNormalizedSlope > 0 &&
        config.signals.lateEntryGuard.bearishCleanImpulse.minMediumR2 >= 0 &&
        config.signals.lateEntryGuard.bearishCleanImpulse.minMediumR2 <= 1 &&
        config.signals.lateEntryGuard.bearishCleanImpulse.minSlowNormalizedSlope > 0 &&
        config.signals.lateEntryGuard.bearishCleanImpulse.minSlowR2 >= 0 &&
        config.signals.lateEntryGuard.bearishCleanImpulse.minSlowR2 <= 1 &&
        config.signals.lateEntryGuard.bearishCleanImpulse.minEfficiency60 >
          config.regimes.chopEfficiency &&
        config.signals.lateEntryGuard.bearishCleanImpulse.minEfficiency60 <= 1 &&
        config.signals.lateEntryGuard.bearishCleanImpulse.minCostMarginBps >= 0 &&
        config.signals.lateEntryGuard.bearishCleanImpulse.minCostMarginBps <=
          config.signals.lateEntryGuard.minCostMarginBps &&
        config.signals.lateEntryGuard.bearishCleanImpulse.maxOptionSpreadPct >=
          config.signals.lateEntryGuard.maxOptionSpreadPct &&
        config.signals.lateEntryGuard.bearishCleanImpulse.maxOptionSpreadPct <=
          config.dataQuality.maxOptionSpreadPct &&
        Number.isInteger(config.signals.lateEntryGuard.bearishCleanImpulse.maxOptionSpreadTicks) &&
        config.signals.lateEntryGuard.bearishCleanImpulse.maxOptionSpreadTicks >= 1 &&
        Number.isFinite(config.signals.lateEntryGuard.bearishCleanImpulse.maxEntryQuoteAgeMs) &&
        config.signals.lateEntryGuard.bearishCleanImpulse.maxEntryQuoteAgeMs >=
          config.dataQuality.maxOptionQuoteAgeMs &&
        config.signals.lateEntryGuard.bearishCleanImpulse.maxEntryQuoteAgeMs <=
          config.execution.entrySignalTtlMs &&
        config.signals.lateEntryGuard.bearishStrongDownImpulse.followThroughMinSec >= 0 &&
        config.signals.lateEntryGuard.bearishStrongDownImpulse.followThroughMaxSec >=
          config.signals.lateEntryGuard.bearishStrongDownImpulse.followThroughMinSec &&
        config.signals.lateEntryGuard.bearishStrongDownImpulse.followThroughMinimumBps >= 0)) {
    throw new Error("Late-entry guard thresholds or follow-through window are invalid");
  }
  if (!(Number.isInteger(config.risk.maxTradesPerDay) && config.risk.maxTradesPerDay > 0)) {
    throw new Error("The daily safety entry limit must be a positive integer");
  }
  if (config.risk.maxContracts !== 1) {
    throw new Error("Entry order sizing is hard-limited to exactly one option contract");
  }
  if (!(Number.isInteger(config.risk.maxPositionsPerUnderlying) &&
        config.risk.maxPositionsPerUnderlying > 0 &&
        config.risk.maxPositionsPerUnderlying <= 10)) {
    throw new Error("Maximum positions per underlying must be an integer in [1, 10]");
  }
  if (!(config.execution.entrySignalTtlMs > 0 &&
        Number.isFinite(config.execution.maxEntryQuoteAgeMs) &&
        config.execution.maxEntryQuoteAgeMs > 0 &&
        config.execution.maxEntryQuoteAgeMs <= config.dataQuality.maxOptionQuoteAgeMs &&
        Number.isFinite(config.execution.optionSelectionRetryMs) &&
        config.execution.optionSelectionRetryMs >= 0 &&
        config.execution.optionSelectionRetryMs <= config.execution.entrySignalTtlMs &&
        config.execution.exitTtlMinMs > 0 &&
        config.execution.exitTtlMaxMs >= config.execution.exitTtlMinMs &&
        config.execution.exitMarketableOffsetTicks >= 0 &&
        config.execution.entryMicrostructureCancelScore >= -1 &&
        config.execution.entryMicrostructureCancelScore <= 1 &&
        config.execution.entrySpreadExpansionCancelRatio >= 1 &&
        config.execution.entryReplaceMinMs > 0 &&
        config.execution.entryReplaceMinMs <= config.execution.replaceAfterMs &&
        Array.isArray(config.execution.executionQualityProbeSec) &&
        config.execution.executionQualityProbeSec.length > 0 &&
        config.execution.executionQualityProbeSec.every((value, index, values) =>
          Number.isFinite(value) && value > 0 && (index === 0 || value > values[index - 1]!)))) {
    throw new Error("Order-management TTL and marketable-offset settings are invalid");
  }
  if (!(config.risk.softProtectionActivationDollars > 0 &&
        config.risk.softProtectionActivationDollars <
        config.risk.directWinnerActivationDollars &&
        config.risk.softProtectionRecoveryActivationDollars > 0 &&
        config.risk.softProtectionRecoveryActivationDollars <=
          config.risk.softProtectionActivationDollars &&
        Number.isInteger(config.risk.softProtectionConfirmationObservations) &&
        config.risk.softProtectionConfirmationObservations >= 1 &&
        config.risk.softProtectionRetentionRatio > 0 &&
        config.risk.softProtectionMinimumFloorDollars >= 0 &&
        config.risk.softProtectionMaximumFloorDollars >=
          config.risk.softProtectionMinimumFloorDollars &&
        config.risk.softProtectionMaximumFloorDollars <=
          config.risk.minimumProfitFloorDollars &&
        config.risk.softFloorBreachConfirmationMs > 0 &&
        Number.isInteger(config.risk.softFloorBreachMinimumObservations) &&
        config.risk.softFloorBreachMinimumObservations >= 2 &&
        config.risk.softProtectionEmergencyLossDollars >= 0 &&
        config.risk.minimumProfitFloorDollars >= 0 &&
        config.risk.directWinnerActivationDollars >= config.risk.minimumProfitFloorDollars &&
        config.risk.recoveredActivationDollars >= config.risk.directWinnerActivationDollars &&
        config.risk.meaningfulAdverseExcursionDollars >= 0 &&
        config.risk.recoveryDeadlineSec > 0 &&
        config.risk.stallSec > 0 &&
        config.risk.profitRetentionBase >= 0 &&
        config.risk.profitRetentionBase <= config.risk.profitRetentionMax &&
        config.risk.profitRetentionMax <= 1 &&
        config.risk.recoveredRetentionBonus >= 0 &&
        config.risk.timeRetentionBonus >= 0 &&
        config.risk.profitRetentionPeakScaleDollars > 0 &&
        config.risk.pnlEwmaHalfLifeSec > 0 &&
        config.risk.pnlNoiseMultiplier >= 0 &&
        config.risk.reversalCusumReference >= 0 &&
        config.risk.reversalCusumThreshold > 0 &&
        config.risk.oppositeRegimeGraceSec >= 0 &&
        Number.isInteger(config.risk.oppositeRegimeMinimumObservations) &&
        config.risk.oppositeRegimeMinimumObservations >= 2 &&
        config.risk.recoveryProbabilityMinAgeSec >= 0 &&
        Number.isInteger(config.risk.recoveryProbabilityMinObservations) &&
        config.risk.recoveryProbabilityMinObservations >= 2 &&
        config.risk.recoveryProbabilityGraceSec >= 0 &&
        config.risk.optionSnapshotMaxAgeSec > 0 &&
        config.risk.greeksExitGraceSec >= 0 &&
        config.risk.protectedGreeksExitGraceSec >= 0 &&
        config.risk.protectedGreeksExitGraceSec <= config.risk.greeksExitGraceSec &&
        config.risk.continuationConfidenceZ >= 0 &&
        config.risk.ivCrushThreshold >= 0)) {
    throw new Error("Unified stopping-controller settings are invalid");
  }
}
