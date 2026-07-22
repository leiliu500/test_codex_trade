import test from "node:test";
import assert from "node:assert/strict";
import { replayEvents } from "../src/backtest/replay.js";
import { computeStrategyMetrics, maximumDrawdown, predictionMetrics, sessionBootstrap } from "../src/backtest/metrics.js";
import { buildWalkForwardFolds, purgeAndEmbargo } from "../src/backtest/walkForward.js";
import type { CompletedTrade } from "../src/backtest/metrics.js";
import type { ReplayEvent } from "../src/types.js";

test("replay rejects decreasing arrival timestamps", async () => {
  const events: ReplayEvent[] = [
    { type: "prior_close", timestamp: 2, data: { symbol: "SPY", close: 500 } },
    { type: "prior_close", timestamp: 1, data: { symbol: "SPY", close: 500 } },
  ];
  await assert.rejects(() => replayEvents(events), /timestamp decreased/);
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
