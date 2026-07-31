import type { EngineConfig } from "../config.js";
import type { FeatureSnapshot, OptionQuote, OptionSnapshot, PositionState } from "../types.js";
import { blackScholes, impliedVolatility } from "../options/blackScholes.js";
import { parseOccSymbol } from "../options/occSymbol.js";
import { zonedDateTimeToEpoch } from "../utils/time.js";

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
  if (snapshot && snapshot.symbol !== position.symbol) {
    return { position, exitReady: false };
  }
  const providerTimestamp = snapshot?.timestamp ?? timestamp;
  const providerSnapshotFresh = snapshot !== undefined &&
    providerTimestamp <= timestamp &&
    timestamp - providerTimestamp <= config.risk.optionSnapshotMaxAgeSec * 1000;
  const freshSnapshot = providerSnapshotFresh ? snapshot : undefined;
  const hasProviderGreeks = [
    freshSnapshot?.greeks?.delta,
    freshSnapshot?.greeks?.gamma,
    freshSnapshot?.greeks?.theta,
    freshSnapshot?.greeks?.vega,
  ].some((value) => finiteValue(value) !== undefined);
  const horizonSec = config.signals.projectionHorizonSec;
  const quantityMultiplier = 100 * position.quantity;
  const spot = feature?.price ?? position.lastUnderlyingPrice ?? position.underlyingEntryPrice;
  const modeled = modelOptionState(
    position,
    quote,
    spot,
    freshSnapshot?.impliedVolatility,
    timestamp,
    config,
  );
  const resolvedDelta = finiteValue(freshSnapshot?.greeks?.delta) ?? modeled?.delta;
  const resolvedGamma = finiteValue(freshSnapshot?.greeks?.gamma) ?? modeled?.gamma;
  const resolvedTheta = finiteValue(freshSnapshot?.greeks?.theta) ?? modeled?.theta;
  const resolvedVega = finiteValue(freshSnapshot?.greeks?.vega) ?? modeled?.vega;
  if (![resolvedDelta, resolvedGamma, resolvedTheta, resolvedVega]
    .some((value) => value !== undefined)) {
    return { position, exitReady: false };
  }
  const delta = resolvedDelta ?? 0;
  const gamma = Math.max(0, resolvedGamma ?? 0);
  const theta = resolvedTheta ?? 0;
  const vega = Math.max(0, resolvedVega ?? 0);

  const previousSpot = position.lastUnderlyingPrice ?? position.underlyingEntryPrice;
  const previousSpotTimestamp = position.lastUnderlyingTimestamp ?? position.entryTimestamp;
  const spotElapsedSec = Math.max(1, ((feature?.timestamp ?? timestamp) - previousSpotTimestamp) / 1000);
  const observedSlopeBpsPerSec =
    spot !== undefined && previousSpot !== undefined && previousSpot > 0
      ? Math.log(spot / previousSpot) * 10_000 / spotElapsedSec
      : 0;
  const regressionSlope = feature?.fast.regression?.slopeBpsPerSec;
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

  const providerIv = validImpliedVolatility(
    freshSnapshot?.impliedVolatility,
    config.options.maxImpliedVolatility,
  );
  const currentIv = providerIv ?? modeled?.observedImpliedVolatility;
  const snapshotTimestamp = providerIv !== undefined ? providerTimestamp : timestamp;
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
  if (hasProviderGreeks && lcbDollars <= 0) {
    position.optionContinuationInvalidSince ??= timestamp;
  } else {
    delete position.optionContinuationInvalidSince;
  }
  const invalidSince = position.optionContinuationInvalidSince;
  const graceSec = position.tradeState === "PROTECTED_WINNER" ||
      position.tradeState === "PROTECTED_RECOVERED"
    ? config.risk.protectedGreeksExitGraceSec
    : config.risk.greeksExitGraceSec;
  const exitReady = hasProviderGreeks &&
    lcbDollars <= 0 &&
    invalidSince !== undefined &&
    timestamp - invalidSince >=
      graceSec * 1000;
  return { position, estimate, exitReady };
}

interface ModeledOptionState {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  observedImpliedVolatility?: number;
}

function modelOptionState(
  position: PositionState,
  quote: OptionQuote,
  spot: number | undefined,
  providerImpliedVolatility: number | undefined,
  timestamp: number,
  config: EngineConfig,
): ModeledOptionState | undefined {
  const contract = parseOccSymbol(position.symbol);
  if (!contract || contract.underlying !== "SPY" || !(spot !== undefined && spot > 0)) {
    return undefined;
  }
  const expiry = zonedDateTimeToEpoch(
    contract.expirationDate,
    "16:00:00",
    config.timeZone,
  );
  const timeToExpiryYears = Math.max(
    1 / (365 * 24 * 60 * 60),
    (expiry - timestamp) / (365 * 24 * 60 * 60 * 1000),
  );
  const modelBase = {
    spot,
    strike: contract.strike,
    timeToExpiryYears,
    riskFreeRate: config.options.riskFreeRate,
    dividendYield: config.options.dividendYield,
    type: contract.type,
  } as const;
  const providerIv = validImpliedVolatility(
    providerImpliedVolatility,
    config.options.maxImpliedVolatility,
  );
  const invertedIv = providerIv === undefined
    ? impliedVolatility({
        ...modelBase,
        marketPrice: (quote.bidPrice + quote.askPrice) / 2,
        maximumVolatility: config.options.maxImpliedVolatility,
      })
    : undefined;
  const observedImpliedVolatility = providerIv ?? invertedIv;
  const volatility =
    observedImpliedVolatility ??
    validImpliedVolatility(position.lastImpliedVolatility, config.options.maxImpliedVolatility) ??
    validImpliedVolatility(position.entryImpliedVolatility, config.options.maxImpliedVolatility) ??
    config.options.fallbackImpliedVolatility;
  const greeks = blackScholes({ ...modelBase, volatility });
  return {
    delta: greeks.delta,
    gamma: greeks.gamma,
    theta: greeks.thetaPerCalendarDay,
    vega: greeks.vegaPerVolPoint,
    ...(observedImpliedVolatility !== undefined
      ? { observedImpliedVolatility }
      : {}),
  };
}

function finiteValue(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function validImpliedVolatility(
  value: number | undefined,
  maximum: number,
): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 && value <= maximum
    ? value
    : undefined;
}
