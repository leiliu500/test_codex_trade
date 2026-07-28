import defaultConfigJson from "../config/default.json" with { type: "json" };
import { parseClock } from "./utils/time.js";

export type FollowThroughScope = "BULLISH_IMPULSE" | "IMPULSE" | "ALL";
export type EntryConfirmationMode = "SHADOW" | "ENFORCE";
export type LateEntryGuardMode = "DISABLED" | "ENFORCE";
export type MorningEntryGuardMode = "DISABLED" | "ENFORCE";

export interface EngineConfig {
  version: string;
  symbol: "SPY";
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
    morningEntryGuard: {
      mode: MorningEntryGuardMode;
      start: string;
      end: string;
      minProjectedMoveBps: number;
      minCostMarginBps: number;
      maxOptionSpreadPct: number;
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
    subscriptionCandidatesPerSide: number;
    chainRefreshSec: number;
    riskFreeRate: number;
    dividendYield: number;
    maxImpliedVolatility: number;
    fallbackImpliedVolatility: number;
    slippagePerSidePctOfSpread: number;
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
    adverseFillSpreadFraction: number;
    exitTtlMinMs: number;
    exitTtlMaxMs: number;
    exitPriceCollarPct: number;
    exitMarketableOffsetTicks: number;
  };
  risk: {
    riskFractionOfEquity: number;
    maxRiskDollarsPerTrade: number;
    maxPremiumDollarsPerTrade: number;
    maxContracts: number;
    maxTradesPerDay: number;
    maxDailyLossDollars: number;
    hardOptionStopPct: number;
    maxHoldSec: number;
    trendInvalidationGraceSec: number;
    staleDataEmergencySec: number;
    onePositionAtATime: boolean;
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

export function validateConfig(config: EngineConfig): void {
  const fractions = [
    config.regression.halfLifeFraction,
    config.dataQuality.sizeWinsorQuantile,
    config.signals.projectionAccelerationRvCap,
    config.execution.entryLimitSpreadFraction,
    config.execution.exitLimitSpreadFraction,
    config.execution.adverseFillSpreadFraction,
    config.execution.exitPriceCollarPct,
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
    throw new Error("This engine is hard-limited to SPY options expiring on the current market date (0DTE)");
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
  if (!(Number.isFinite(config.signals.sameDirectionCooldownSec) &&
        config.signals.sameDirectionCooldownSec >= 0 &&
        Number.isFinite(config.signals.oppositeDirectionCooldownSec) &&
        config.signals.oppositeDirectionCooldownSec >= 0 &&
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
        config.signals.morningEntryGuard.maxOptionSpreadPct <= config.dataQuality.maxOptionSpreadPct)) {
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
  if (!(config.execution.entrySignalTtlMs > 0 &&
        config.execution.exitTtlMinMs > 0 &&
        config.execution.exitTtlMaxMs >= config.execution.exitTtlMinMs &&
        config.execution.exitMarketableOffsetTicks >= 0)) {
    throw new Error("Order-management TTL and marketable-offset settings are invalid");
  }
  if (!(config.risk.minimumProfitFloorDollars >= 0 &&
        config.risk.directWinnerActivationDollars >= config.risk.minimumProfitFloorDollars &&
        config.risk.recoveredActivationDollars >= config.risk.directWinnerActivationDollars &&
        config.risk.meaningfulAdverseExcursionDollars >= 0 &&
        config.risk.recoveryDeadlineSec > 0 &&
        config.risk.stallSec > 0 &&
        config.risk.profitRetentionBase <= config.risk.profitRetentionMax &&
        config.risk.profitRetentionPeakScaleDollars > 0 &&
        config.risk.pnlEwmaHalfLifeSec > 0 &&
        config.risk.pnlNoiseMultiplier >= 0 &&
        config.risk.reversalCusumReference >= 0 &&
        config.risk.reversalCusumThreshold > 0 &&
        config.risk.recoveryProbabilityMinAgeSec >= 0 &&
        Number.isInteger(config.risk.recoveryProbabilityMinObservations) &&
        config.risk.recoveryProbabilityMinObservations >= 2 &&
        config.risk.recoveryProbabilityGraceSec >= 0 &&
        config.risk.optionSnapshotMaxAgeSec > 0 &&
        config.risk.greeksExitGraceSec >= 0 &&
        config.risk.continuationConfidenceZ >= 0 &&
        config.risk.ivCrushThreshold >= 0)) {
    throw new Error("Unified stopping-controller settings are invalid");
  }
}
