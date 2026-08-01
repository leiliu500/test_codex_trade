import type { EngineConfig } from "../config.js";
import type { FeatureSnapshot, OptionQuote, TradeSignal } from "../types.js";
import { parseClock, secondsSinceMidnight } from "../utils/time.js";
import { lateEntryGuardActive } from "./lateEntryGuard.js";
import { boundedProjectionBps } from "./projection.js";

export interface LateBullishGrindConfirmationState {
  armedAt: number;
  referenceBidPrice: number;
}

export interface LateBullishGrindConfirmationEvaluation {
  confirmed: boolean;
  expired: boolean;
  elapsedSec: number;
  bidImprovement: number;
  projectedMoveBps: number;
  reasons: string[];
}

export function requiresLateBullishGrindOptionConfirmation(
  config: EngineConfig,
  signal: TradeSignal,
): boolean {
  if (!lateEntryGuardActive(config, signal.timestamp) ||
      signal.direction !== "BULLISH" || signal.kind !== "GRIND") return false;
  const profile = config.signals.lateEntryGuard.bullishLowNoiseGrind;
  const confirmation = config.signals.lateEntryGuard.bullishGrindOptionConfirmation;
  const feature = signal.featureSnapshot;
  const lowNoiseProfile = profile.enabled &&
    feature.fast.noiseFloorBps <= profile.maxFastNoiseFloorBps &&
    feature.fast.normalizedSlope >= profile.minFastNormalizedSlope &&
    feature.medium.normalizedSlope >= profile.minMediumNormalizedSlope &&
    (feature.medium.regression.r2 ?? -Infinity) >= profile.minMediumR2 &&
    feature.slow.normalizedSlope >= profile.minSlowNormalizedSlope &&
    (feature.slow.regression.r2 ?? -Infinity) >= profile.minSlowR2 &&
    (feature.vwap.rollingVwapSlopeBpsPerSec ?? -Infinity) > 0 &&
    feature.fast.normalizedAcceleration >= config.signals.grindNegativeAccelerationLimit &&
    feature.ofi15 >= 0;
  const noisyFastBurst = feature.fast.noiseFloorBps > profile.maxFastNoiseFloorBps &&
    feature.medium.normalizedSlope <
      config.signals.lateEntryGuard.bullishNoisyGrindMinMediumToFastRatio *
        Math.max(0, feature.fast.normalizedSlope);
  return confirmation.enabled && (lowNoiseProfile || noisyFastBurst);
}

export function evaluateLateBullishGrindOptionConfirmation(
  config: EngineConfig,
  state: LateBullishGrindConfirmationState,
  feature: FeatureSnapshot,
  quote: OptionQuote | undefined,
): LateBullishGrindConfirmationEvaluation {
  const profile = config.signals.lateEntryGuard.bullishGrindOptionConfirmation;
  const elapsedSec = Math.max(0, (feature.timestamp - state.armedAt) / 1000);
  const bidImprovement = quote ? quote.bidPrice - state.referenceBidPrice : -Infinity;
  const projectedMoveBps = currentBullishProjectionBps(config, feature);
  const reasons: string[] = [];
  if (elapsedSec < profile.minSec) reasons.push("LATE_ENTRY_BULLISH_GRIND_CONFIRMATION_MIN_WAIT");
  if (!quote) reasons.push("LATE_ENTRY_BULLISH_GRIND_CONFIRMATION_QUOTE_UNAVAILABLE");
  else {
    const midpoint = (quote.bidPrice + quote.askPrice) / 2;
    const spreadPct = midpoint > 0 ? (quote.askPrice - quote.bidPrice) / midpoint : Infinity;
    if (spreadPct > config.signals.lateEntryGuard.maxOptionSpreadPct) {
      reasons.push("LATE_ENTRY_BULLISH_GRIND_CONFIRMATION_SPREAD");
    }
    if (bidImprovement + Number.EPSILON < profile.minimumBidImprovement) {
      reasons.push("LATE_ENTRY_BULLISH_GRIND_CONFIRMATION_BID_RESPONSE");
    }
  }
  if (!feature.dataValid || feature.vwap.sessionVwap === undefined ||
      feature.price <= feature.vwap.sessionVwap ||
      feature.medium.normalizedSlope < config.signals.lateEntryGuard.bullishGrindMinMediumNormalizedSlope ||
      feature.slow.normalizedSlope < config.signals.grindSlowSlopeScore ||
      (feature.vwap.rollingVwapSlopeBpsPerSec ?? -Infinity) <= 0 ||
      feature.fast.normalizedAcceleration < config.signals.grindNegativeAccelerationLimit ||
      feature.ofi15 < 0) {
    reasons.push("LATE_ENTRY_BULLISH_GRIND_CONFIRMATION_STRUCTURE");
  }
  if (projectedMoveBps < profile.minimumProjectedMoveBps) {
    reasons.push("LATE_ENTRY_BULLISH_GRIND_CONFIRMATION_PROJECTION");
  }
  if (secondsSinceMidnight(feature.timestamp, config.timeZone) >
      parseClock(config.options.zeroDteEntryCutoff)) {
    reasons.push("LATE_ENTRY_BULLISH_GRIND_CONFIRMATION_CUTOFF");
  }
  const expired = elapsedSec > profile.maxSec;
  if (expired) reasons.push("LATE_ENTRY_BULLISH_GRIND_CONFIRMATION_EXPIRED");
  return {
    confirmed: !expired && reasons.length === 0,
    expired,
    elapsedSec,
    bidImprovement,
    projectedMoveBps,
    reasons,
  };
}

export function currentBullishProjectionBps(
  config: EngineConfig,
  feature: FeatureSnapshot,
): number {
  return boundedProjectionBps(
    feature.fast.regression.slopeBpsPerSec ?? 0,
    feature.fast.regression.accelerationBpsPerSec2 ?? 0,
    config.signals.projectionHorizonSec,
    feature.fast.realizedVolatilityBps,
    config.signals.projectionAccelerationRvCap,
  ).projectedMoveBps;
}
