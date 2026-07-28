import type { EngineConfig } from "../config.js";
import type { FeatureSnapshot, OptionQuote, OptionSnapshot, PositionState } from "../types.js";

export interface OptionContinuationEstimate {
  deltaDollars: number;
  gammaDollars: number;
  vegaDollars: number;
  thetaDollars: number;
  holdingCostDollars: number;
  uncertaintyDollars: number;
  expectedChangeDollars: number;
  lcbDollars: number;
  ivCrushDetected: boolean;
}

export interface OptionContinuationResult {
  position: PositionState;
  estimate?: OptionContinuationEstimate;
  exitReady: boolean;
}

/**
 * Short-horizon delta/gamma/vega/theta continuation estimate. The broker/API
 * Greeks are sensitivities, not guarantees, so observed P&L variance and
 * executable spread cost are subtracted to form a conservative LCB.
 */
export function estimateOptionContinuation(
  original: PositionState,
  quote: OptionQuote,
  snapshot: OptionSnapshot | undefined,
  feature: FeatureSnapshot | undefined,
  timestamp: number,
  config: EngineConfig,
): OptionContinuationResult {
  const position: PositionState = { ...original };
  if (!snapshot || snapshot.symbol !== position.symbol) {
    return { position, exitReady: false };
  }
  const snapshotTimestamp = snapshot.timestamp ?? timestamp;
  if (snapshotTimestamp > timestamp ||
      timestamp - snapshotTimestamp > config.risk.optionSnapshotMaxAgeSec * 1000) {
    return { position, exitReady: false };
  }

  const delta = finiteOrZero(snapshot.greeks?.delta);
  const gamma = Math.max(0, finiteOrZero(snapshot.greeks?.gamma));
  const theta = finiteOrZero(snapshot.greeks?.theta);
  const vega = Math.max(0, finiteOrZero(snapshot.greeks?.vega));
  const hasGreeks = [snapshot.greeks?.delta, snapshot.greeks?.gamma, snapshot.greeks?.theta,
    snapshot.greeks?.vega].some((value) => value !== undefined && Number.isFinite(value));
  if (!hasGreeks) return { position, exitReady: false };

  const horizonSec = config.signals.projectionHorizonSec;
  const quantityMultiplier = 100 * position.quantity;
  const spot = feature?.price ?? position.lastUnderlyingPrice ?? position.underlyingEntryPrice;
  const previousSpot = position.lastUnderlyingPrice ?? position.underlyingEntryPrice;
  const previousSpotTimestamp = position.lastUnderlyingTimestamp ?? position.entryTimestamp;
  const spotElapsedSec = Math.max(1, ((feature?.timestamp ?? timestamp) - previousSpotTimestamp) / 1000);
  const observedSlopeBpsPerSec =
    spot !== undefined && previousSpot !== undefined && previousSpot > 0
      ? Math.log(spot / previousSpot) * 10_000 / spotElapsedSec
      : 0;
  const regressionSlope = feature?.fast.regression.slopeBpsPerSec;
  const slopeBpsPerSec = regressionSlope !== undefined && Number.isFinite(regressionSlope)
    ? regressionSlope
    : observedSlopeBpsPerSec;
  const expectedUnderlyingMove = spot !== undefined
    ? spot * (Math.exp(slopeBpsPerSec * horizonSec / 10_000) - 1)
    : 0;
  const realizedVolatilityBps = Math.max(0, feature?.fast.realizedVolatilityBps ?? 0);
  const volatilityWindowSec = Math.max(1, feature?.fast.windowSec ?? horizonSec);
  const underlyingMoveSd = spot !== undefined
    ? spot * realizedVolatilityBps / 10_000 * Math.sqrt(horizonSec / volatilityWindowSec)
    : 0;

  const deltaDollars = quantityMultiplier * delta * expectedUnderlyingMove;
  const gammaDollars = quantityMultiplier * 0.5 * gamma *
    (expectedUnderlyingMove ** 2 + underlyingMoveSd ** 2);

  const currentIv = snapshot.impliedVolatility;
  const previousIv = position.lastImpliedVolatility ?? position.entryImpliedVolatility;
  const previousSnapshotTimestamp =
    position.lastOptionSnapshotTimestamp ?? position.entryTimestamp;
  const ivElapsedSec = Math.max(1, (snapshotTimestamp - previousSnapshotTimestamp) / 1000);
  const forecastIvChangePoints =
    currentIv !== undefined && previousIv !== undefined
      ? (currentIv - previousIv) * 100 * Math.min(1, horizonSec / ivElapsedSec)
      : 0;
  const vegaDollars = quantityMultiplier * vega * forecastIvChangePoints;
  const thetaDollars = quantityMultiplier * theta * horizonSec / 86_400;
  const holdingCostDollars = quantityMultiplier *
    Math.max(0, quote.askPrice - quote.bidPrice) *
    config.risk.continuationSpreadCostFraction;
  const uncertaintyDollars = config.risk.continuationConfidenceZ *
    Math.sqrt(Math.max(0, position.pnlEwmaVariancePerSec) * horizonSec);
  const expectedChangeDollars =
    deltaDollars + gammaDollars + vegaDollars + thetaDollars;
  const lcbDollars = expectedChangeDollars - holdingCostDollars - uncertaintyDollars;
  const ivCrushDetected =
    currentIv !== undefined &&
    position.entryImpliedVolatility !== undefined &&
    position.entryImpliedVolatility - currentIv >= config.risk.ivCrushThreshold &&
    vega > 0;
  const estimate: OptionContinuationEstimate = {
    deltaDollars,
    gammaDollars,
    vegaDollars,
    thetaDollars,
    holdingCostDollars,
    uncertaintyDollars,
    expectedChangeDollars,
    lcbDollars,
    ivCrushDetected,
  };

  position.optionContinuation = estimate;
  position.optionContinuationLcbDollars = lcbDollars;
  if (currentIv !== undefined && Number.isFinite(currentIv)) {
    position.lastImpliedVolatility = currentIv;
    position.lastOptionSnapshotTimestamp = snapshotTimestamp;
  }
  if (spot !== undefined) {
    position.lastUnderlyingPrice = spot;
    position.lastUnderlyingTimestamp = feature?.timestamp ?? timestamp;
  }
  if (lcbDollars <= 0) {
    position.optionContinuationInvalidSince ??= timestamp;
  } else {
    delete position.optionContinuationInvalidSince;
  }
  const invalidSince = position.optionContinuationInvalidSince;
  const exitReady = lcbDollars <= 0 &&
    invalidSince !== undefined &&
    timestamp - invalidSince >=
      config.risk.greeksExitGraceSec * 1000;
  return { position, estimate, exitReady };
}

function finiteOrZero(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}
