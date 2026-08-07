import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import { ReplayEngine, replayEvents } from "../src/backtest/replay.js";
import { computeStrategyMetrics, maximumDrawdown, predictionMetrics, sessionBootstrap } from "../src/backtest/metrics.js";
import { buildWalkForwardFolds, purgeAndEmbargo } from "../src/backtest/walkForward.js";
import type { CompletedTrade } from "../src/backtest/metrics.js";
import type { FeatureSnapshot, ReplayEvent, WindowMetrics } from "../src/types.js";
import { zonedDateTimeToEpoch } from "../src/utils/time.js";

function replayWindowMetric(
  windowSec: number,
  slope: number,
  acceleration: number,
  normalizedSlope: number,
  normalizedAcceleration: number,
): WindowMetrics {
  return {
    windowSec,
    regression: {
      valid: true,
      windowSec,
      pointCount: windowSec + 1,
      coverageFraction: 1,
      levelLog: Math.log(501),
      slopeBpsPerSec: slope,
      accelerationBpsPerSec2: acceleration,
      r2: 0.8,
      coefficients: [Math.log(501), slope * windowSec / 10_000, acceleration * windowSec ** 2 / 20_000],
    },
    realizedVolatilityBps: 2,
    efficiencyRatio: 0.6,
    noiseFloorBps: 2,
    normalizedSlope,
    normalizedAcceleration,
    signChanges: 0,
  };
}

function replayBullishFeature(timestamp: number): FeatureSnapshot {
  return {
    symbol: "SPY",
    timestamp,
    marketDate: "2026-07-22",
    price: 501,
    mid: 501,
    spreadBps: 0.2,
    quoteAgeMs: 100,
    quoteImbalance: 0.5,
    quoteImbalanceEwma5: 0.5,
    quoteImbalanceEwma15: 0.4,
    micropriceDisplacementBps: 0.1,
    ofi1: 0.1,
    ofi5: 0.2,
    ofi15: 0.1,
    volume60: 100_000,
    fast: replayWindowMetric(10, 0.6, 0.02, 0.8, 0.2),
    medium: replayWindowMetric(30, 0.2, 0, 0.6, 0),
    slow: replayWindowMetric(120, 0.04, 0, 0.3, 0),
    efficiency60: 0.6,
    signChanges60: 0,
    vwap: {
      sessionVwap: 500,
      rollingVwap: 500.5,
      rollingVwapSlopeBpsPerSec: 0.05,
      anchoredVwaps: {},
    },
    openingRange: {
      complete: true,
      high: 500.8,
      low: 499.2,
      midpoint: 500,
      widthBps: 32,
      nearHigh: true,
      nearLow: false,
      bullishRetest: false,
      bearishRetest: false,
    },
    thresholds: {
      source: "static",
      bucket: "10:20",
      sampleCount: 0,
      fastSlope: 0.42,
      fastAcceleration: 0.1,
      absoluteOfi5: 0.08,
      efficiency60: 0.28,
    },
    dataValid: true,
    invalidReasons: [],
  };
}

test("replay rejects decreasing arrival timestamps", async () => {
  const events: ReplayEvent[] = [
    { type: "prior_close", timestamp: 2, data: { symbol: "SPY", close: 500 } },
    { type: "prior_close", timestamp: 1, data: { symbol: "SPY", close: 500 } },
  ];
  await assert.rejects(() => replayEvents(events), /timestamp decreased/);
});

test("replay results identify the exact strategy, fill, calibration, and fee assumptions", async () => {
  const result = await replayEvents([
    { type: "prior_close", timestamp: 1, data: { symbol: "SPY", close: 500 } },
  ], {
    fillModel: "queue",
    feesPerContractRoundTrip: 1.3,
  });
  assert.deepEqual(result.metadata, {
    underlying: "SPY",
    configVersion: defaultConfig.version,
    fillModel: "queue",
    calibrationVersion: null,
    feesPerContractRoundTrip: 1.3,
  });
});

test("replay retries a transient option spread and selects the refreshed quote", async () => {
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "10:20:00");
  const symbol = "SPY260722C00501000";
  const config = structuredClone(defaultConfig);
  config.signals.entryConfirmationMode = "SHADOW";
  config.signals.followThroughMinSec = 0;
  config.signals.followThroughMaxSec = 0;
  const engine = new ReplayEngine({ config });
  await engine.ingest({
    type: "option_contract",
    timestamp: timestamp - 30,
    data: {
      symbol,
      underlying: "SPY",
      expirationDate: "2026-07-22",
      strike: 501,
      type: "call",
      active: true,
      tradable: true,
    },
  });
  await engine.ingest({
    type: "option_snapshot",
    timestamp: timestamp - 20,
    data: {
      symbol,
      timestamp: timestamp - 20,
      impliedVolatility: 0.22,
      greeks: { delta: 0.52, gamma: 0.02 },
      dailyVolume: 1_000,
      openInterest: 5_000,
    },
  });
  await engine.ingest({
    type: "option_quote",
    timestamp: timestamp - 10,
    data: { symbol, timestamp: timestamp - 10, bidPrice: 2, askPrice: 2.016, bidSize: 100, askSize: 100 },
  });
  await engine.ingestRecordedFeature(replayBullishFeature(timestamp));
  await engine.ingest({
    type: "option_quote",
    timestamp: timestamp + 100,
    data: { symbol, timestamp: timestamp + 100, bidPrice: 2.01, askPrice: 2.02, bidSize: 100, askSize: 100 },
  });

  const result = await engine.finish();
  const selections = result.auditEvents.filter((event) => event.type === "option_selection");
  assert.deepEqual(selections.map((event) => event.data.selectionStatus), ["RETRYING", "SELECTED"]);
  assert.equal(selections[1]?.data.retryOutcome, "SELECTED_AFTER_RETRY");
  assert.equal(selections[1]?.data.retryWaitMs, 100);
  assert.equal(result.funnel.signals, 1);
  assert.equal(result.funnel.candidateAvailable, 1);
  assert.equal(result.funnel.ordersSubmitted, 1);
  assert.equal(result.funnel.fills, 1);
});

test("trade, drawdown, Sharpe/Sortino and cost metrics use net fills/fees", () => {
  const trades: CompletedTrade[] = [
    { sessionDate: "2026-01-01", quantity: 1, entryPrice: 1, exitPrice: 1.5, entryTimestamp: 0, exitTimestamp: 1, fees: 1, marks: [0.8, 1.6], estimatedTradingCost: 5 },
    { sessionDate: "2026-01-02", quantity: 1, entryPrice: 2, exitPrice: 1.5, entryTimestamp: 2, exitTimestamp: 3, fees: 1, marks: [1.4, 2.1], estimatedTradingCost: 6 },
    { sessionDate: "2026-01-03", quantity: 2, entryPrice: 1, exitPrice: 1.4, entryTimestamp: 4, exitTimestamp: 5, fees: 2, marks: [0.9, 1.5], estimatedTradingCost: 7 },
  ];
  const metrics = computeStrategyMetrics(trades, 10_000);
  assert.equal(metrics.trades, 3);
  assert.equal(metrics.wins, 2);
  assert.equal(metrics.losses, 1);
  assert.ok(metrics.profitFactor! > 1);
  assert.ok(metrics.maximumDrawdown > 0);
  assert.ok(metrics.costRatio > 0);
  assert.deepEqual(maximumDrawdown([100, -40, -80, 50]), { absolute: 120, percentage: 1.2 });
});

test("prediction diagnostics and session bootstrap preserve complete-session blocks", () => {
  const prediction = predictionMetrics([1, -1, 2], [2, -2, -1], 0.5);
  assert.ok(prediction.mae > 0);
  assert.equal(prediction.directionalAccuracy, 2 / 3);
  const trades: CompletedTrade[] = Array.from({ length: 6 }, (_, index) => ({
    sessionDate: `2026-01-0${1 + Math.floor(index / 2)}`, quantity: 1,
    entryPrice: 1, exitPrice: index % 2 ? 0.9 : 1.2, entryTimestamp: index, exitTimestamp: index + 1, fees: 0,
  }));
  const bootstrap = sessionBootstrap(trades, 20, () => 0.3);
  assert.ok(bootstrap);
  assert.ok(bootstrap!.expectancy.lower <= bootstrap!.expectancy.upper);
});

test("walk-forward folds are chronological and purge overlapping labels", () => {
  const dates = Array.from({ length: 100 }, (_, index) => `2026-${String(1 + Math.floor(index / 28)).padStart(2, "0")}-${String(1 + index % 28).padStart(2, "0")}`);
  const folds = buildWalkForwardFolds(dates, 60, 10, 10, 10);
  assert.equal(folds.length, 3);
  assert.ok(folds[0]!.train.at(-1)! < folds[0]!.validation[0]!);
  assert.ok(folds[0]!.validation.at(-1)! < folds[0]!.test[0]!);
  const purged = purgeAndEmbargo([
    { featureTimestamp: 80, labelEndTimestamp: 95 },
    { featureTimestamp: 90, labelEndTimestamp: 105 },
    { featureTimestamp: 99, labelEndTimestamp: 99 },
  ], 100, 10);
  assert.deepEqual(purged, [{ featureTimestamp: 80, labelEndTimestamp: 95 }]);
});
