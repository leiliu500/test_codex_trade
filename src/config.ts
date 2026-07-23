import defaultConfigJson from "../config/default.json" with { type: "json" };
import { parseClock } from "./utils/time.js";

export type FollowThroughScope = "BULLISH_IMPULSE" | "IMPULSE" | "ALL";
export type EntryQualityMode = "SHADOW" | "ENFORCE";
export type LateEntryGuardMode = "DISABLED" | "ENFORCE";

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
    entryQualityMode: EntryQualityMode;
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
    minimumSignalIntervalSec: number;
    lateBullishImpulseStart: string;
    lateBullishImpulseRequiresUpRegime: boolean;
    bullishImpulseCutoff: string;
    followThroughMinSec: number;
    followThroughMaxSec: number;
    followThroughMinimumBps: number;
    followThroughScope: FollowThroughScope;
    shadowFollowThroughScope: FollowThroughScope | "DISABLED";
    lateEntryGuard: {
      mode: LateEntryGuardMode;
      start: string;
      minProjectedMoveBps: number;
      minCostMarginBps: number;
      maxOptionSpreadPct: number;
      followThroughMinSec: number;
      followThroughMaxSec: number;
      followThroughMinimumBps: number;
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
  };
  risk: {
    riskFractionOfEquity: number;
    maxRiskDollarsPerTrade: number;
    maxPremiumDollarsPerTrade: number;
    maxContracts: number;
    maxTradesPerDay: number;
    entryQualityMaxTradesPerDay: number;
    maxDailyLossDollars: number;
    hardOptionStopPct: number;
    optionProfitTargetPct: number;
    trailingDrawdownPct: number;
    trailingActivationPct: number;
    trailingProfitFloorPct: number;
    maxHoldSec: number;
    trendInvalidationGraceSec: number;
    earlyScratchMinAgeSec: number;
    earlyScratchMaxAgeSec: number;
    earlyScratchMinimumFavorablePct: number;
    earlyScratchUnderlyingReversalBps: number;
    staleDataEmergencySec: number;
    onePositionAtATime: boolean;
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
    config.risk.trailingProfitFloorPct,
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
  if (config.risk.trailingProfitFloorPct >= config.risk.trailingActivationPct) {
    throw new Error("Trailing profit floor must be below trailing activation");
  }
  const entryStart = parseClock(config.session.entryStart);
  const lateBullishImpulseStart = parseClock(config.signals.lateBullishImpulseStart);
  const bullishImpulseCutoff = parseClock(config.signals.bullishImpulseCutoff);
  const lateEntryGuardStart = parseClock(config.signals.lateEntryGuard.start);
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
  if (!(config.signals.followThroughMinSec >= 0 &&
        config.signals.followThroughMaxSec >= config.signals.followThroughMinSec &&
        config.signals.followThroughMinimumBps >= 0)) {
    throw new Error("Follow-through confirmation requires 0 <= minSec <= maxSec and non-negative bps");
  }
  const scopes = new Set<FollowThroughScope>(["BULLISH_IMPULSE", "IMPULSE", "ALL"]);
  if (!scopes.has(config.signals.followThroughScope) ||
      (config.signals.shadowFollowThroughScope !== "DISABLED" && !scopes.has(config.signals.shadowFollowThroughScope))) {
    throw new Error("Follow-through scope must be BULLISH_IMPULSE, IMPULSE, ALL, or DISABLED for shadow evaluation");
  }
  if (!new Set<EntryQualityMode>(["SHADOW", "ENFORCE"]).has(config.signals.entryQualityMode)) {
    throw new Error("Entry-quality mode must be SHADOW or ENFORCE");
  }
  if (!new Set<LateEntryGuardMode>(["DISABLED", "ENFORCE"]).has(config.signals.lateEntryGuard.mode)) {
    throw new Error("Late-entry guard mode must be DISABLED or ENFORCE");
  }
  if (!(config.signals.lateEntryGuard.minProjectedMoveBps > 0 &&
        config.signals.lateEntryGuard.minCostMarginBps >= 0 &&
        config.signals.lateEntryGuard.maxOptionSpreadPct > 0 &&
        config.signals.lateEntryGuard.maxOptionSpreadPct <= config.dataQuality.maxOptionSpreadPct &&
        config.signals.lateEntryGuard.followThroughMinSec >= 0 &&
        config.signals.lateEntryGuard.followThroughMaxSec >= config.signals.lateEntryGuard.followThroughMinSec &&
        config.signals.lateEntryGuard.followThroughMinimumBps >= 0)) {
    throw new Error("Late-entry guard thresholds or follow-through window are invalid");
  }
  if (!(Number.isInteger(config.risk.maxTradesPerDay) && config.risk.maxTradesPerDay > 0 &&
        Number.isInteger(config.risk.entryQualityMaxTradesPerDay) && config.risk.entryQualityMaxTradesPerDay > 0)) {
    throw new Error("Daily entry caps must be positive integers");
  }
  if (config.risk.maxContracts !== 1) {
    throw new Error("Entry order sizing is hard-limited to exactly one option contract");
  }
  if (!(config.risk.earlyScratchMinAgeSec >= 0 &&
        config.risk.earlyScratchMaxAgeSec >= config.risk.earlyScratchMinAgeSec &&
        config.risk.earlyScratchMinimumFavorablePct >= 0 &&
        config.risk.earlyScratchUnderlyingReversalBps >= 0)) {
    throw new Error("Early scratch thresholds must be non-negative and use minAgeSec <= maxAgeSec");
  }
}
