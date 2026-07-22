import test from "node:test";
import assert from "node:assert/strict";
import { TradingDashboardStore, tradingDashboardHtml } from "../src/ops/tradingDashboard.js";
import type { AuditEvent } from "../src/ops/recorder.js";
import type { HistoricalMarketEvent } from "../src/history/types.js";

const timestamp = Date.parse("2026-07-22T14:20:00Z");
const symbol = "SPY260722C00501000";

function event(type: string, data: Record<string, unknown>, offset = 0): AuditEvent {
  return { timestamp: timestamp + offset, marketDate: "2026-07-22", type, configVersion: "test", data };
}

test("dashboard exposes liveness and feed tabs before any entries, orders, or history", () => {
  const dashboard = new TradingDashboardStore(Date.now() - 2_000, true, 250, 7);
  const snapshot = dashboard.snapshot();
  assert.equal(snapshot.activeOrders.length, 0);
  assert.equal(snapshot.decisions.length, 0);
  assert.equal(snapshot.liveData.persistenceEnabled, true);
  assert.equal(snapshot.liveData.quoteSampleIntervalMs, 250);
  assert.equal(snapshot.liveData.retentionDays, 7);
  assert.equal(snapshot.liveData.totalEvents, 0);
  assert.deepEqual(snapshot.liveData.recentEvents, []);
  assert.ok(snapshot.liveData.uptimeMs >= 2_000);
  const html = tradingDashboardHtml();
  assert.match(html, /Engine heartbeat/);
  assert.match(html, /data-tab="liveDataTab"/);
  assert.match(html, /data-tab="tuningTab"/);
  assert.match(html, /Entry &amp; Order Tuning/);
  assert.match(html, /Live Feed Into System/);
  assert.match(html, /Entry Evaluations &amp; Decisions/);
  assert.match(html, /Potential Missed Entry Review/);
  assert.match(html, /Entry Gate Blocks/);
  assert.match(html, /Strategy state/);
  assert.match(html, /Actionable stages only/);
});

test("dashboard separates potential hindsight misses from routine no-signal evaluations", () => {
  const dashboard = new TradingDashboardStore(timestamp, true);
  const noSignal = (price: number) => ({
    decision: "NO_SIGNAL",
    reasons: ["NO_DIRECTION_PASSED"],
    regime: "GRIND_UP",
    feature: { price },
    directions: [{
      direction: "BULLISH",
      passed: false,
      reasons: ["MEDIUM_SLOPE_MISALIGNED"],
      votes: [{ name: "FAST_SLOPE", passed: false, value: 0.2, threshold: 0.42 }],
    }, {
      direction: "BEARISH",
      passed: false,
      reasons: ["MEDIUM_SLOPE_MISALIGNED"],
      votes: [{ name: "FAST_SLOPE", passed: false, value: 0.2, threshold: -0.42 }],
    }],
  });

  dashboard.record(event("live_entry_evaluation", noSignal(500)));
  dashboard.record(event("live_entry_evaluation", noSignal(500.15), 5_000));
  dashboard.record(event("live_entry_evaluation", noSignal(500.30), 10_000));

  const snapshot = dashboard.snapshot();
  assert.equal(snapshot.tuning.falseNegativeSummary.evaluations, 3);
  assert.equal(snapshot.tuning.falseNegativeSummary.noSignalEvaluations, 3);
  assert.equal(snapshot.tuning.falseNegativeSummary.matureNoSignalEvaluations, 2);
  assert.equal(snapshot.tuning.falseNegativeSummary.potentialMisses, 1);
  assert.equal(snapshot.tuning.falseNegativeSummary.bullishPotentialMisses, 1);
  assert.equal(snapshot.tuning.falseNegativeSummary.bearishPotentialMisses, 0);
  assert.deepEqual(snapshot.tuning.falseNegativeSummary.gateBlocks, [{ reason: "NO_DIRECTION_PASSED", count: 3 }]);
  assert.equal(snapshot.tuning.potentialMisses[0]?.direction, "BULLISH");
  assert.ok(Math.abs((snapshot.tuning.potentialMisses[0]?.forwardMoveBps ?? 0) - 3) < 1e-9);
  assert.deepEqual(snapshot.tuning.potentialMisses[0]?.failedGates, [
    "MEDIUM_SLOPE_MISALIGNED",
    "FAST_SLOPE 0.200 vs 0.420",
  ]);

  const safetyBlocked = new TradingDashboardStore(timestamp, true);
  safetyBlocked.record(event("live_entry_evaluation", {
    ...noSignal(500),
    reasons: ["WHIPSAW_REGIME_BLOCKED"],
  }));
  safetyBlocked.record(event("live_entry_evaluation", noSignal(500.15), 5_000));
  assert.equal(safetyBlocked.snapshot().tuning.falseNegativeSummary.matureNoSignalEvaluations, 1);
  assert.equal(safetyBlocked.snapshot().tuning.falseNegativeSummary.potentialMisses, 0);
});

test("dashboard reconstructs fired entries, broker execution, trades, and performance from audit history", () => {
  const dashboard = new TradingDashboardStore(timestamp, true);
  dashboard.record(event("live_signal_selection", {
    signalId: "signal-1", timestamp, direction: "BULLISH", kind: "IMPULSE", regime: "STRONG_UP",
    projectedMoveBps: 8.5, candidate: symbol, evaluatedContracts: 24,
    candidateMetrics: { score: 12.5, delta: 0.52, mid: 2, spreadPct: 0.02, costMarginBps: 3.1 },
    candidateQuote: { timestamp, bidPrice: 1.98, askPrice: 2.02 },
  }));
  dashboard.record(event("broker_order_request", {
    purpose: "ENTRY", signalId: "signal-1",
    order: {
      clientOrderId: "entry-1", symbol, side: "buy", requestedQuantity: 2, filledQuantity: 0,
      averageFillPrice: 0, limitPrice: 2.01, status: "SUBMITTED", submittedAt: timestamp + 10, replacements: 0,
    },
  }, 10));
  dashboard.record(event("paper_order_submission_result", {
    signalId: "signal-1", submitted: true, reasons: [], brokerOrderId: "broker-entry-1",
  }, 20));
  dashboard.record(event("broker_order_state", {
    purpose: "ENTRY",
    broker: { id: "broker-entry-1", clientOrderId: "entry-1", status: "filled", filledQuantity: 2, averageFillPrice: 2 },
    localOrder: { clientOrderId: "entry-1", status: "FILLED", filledQuantity: 2, averageFillPrice: 2, limitPrice: 2.01, replacements: 0 },
  }, 30));
  dashboard.record(event("entry_fill", {
    incrementalQuantity: 2, incrementalPrice: 2, cumulativeQuantity: 2,
    position: {
      symbol, direction: "BULLISH", quantity: 2, averageEntryPrice: 2, entryTimestamp: timestamp,
      stopPrice: 1.5, targetPrice: 2.7, highWaterMark: 2, lowWaterMark: 2,
    },
  }, 30));
  dashboard.recordMarketEvent({
    type: "option_quote", providerTimestamp: timestamp + 45, receivedTimestamp: timestamp + 46,
    marketDate: "2026-07-22", symbol,
    data: { symbol, timestamp: timestamp + 45, bidPrice: 2.4, askPrice: 2.42, bidSize: 50, askSize: 40 },
  } satisfies HistoricalMarketEvent);
  dashboard.record(event("live_entry_evaluation", {
    timestamp, decision: "NO_SIGNAL", reasons: ["NO_DIRECTION_PASSED"], regime: "CHOP_DOJI",
    feature: { price: 501 },
    directions: [{
      direction: "BULLISH", passed: false, reasons: ["MEDIUM_SLOPE_MISALIGNED"],
      votes: [{ name: "FAST_SLOPE", passed: false, value: 0.1, threshold: 0.42 }],
    }],
  }, 50));

  const openSnapshot = dashboard.snapshot();
  assert.equal(openSnapshot.activeOrders.length, 1);
  assert.equal(openSnapshot.activeOrders[0]?.stage, "POSITION_OPEN");
  assert.equal(openSnapshot.activeOrders[0]?.markPrice, 2.4);
  assert.ok(Math.abs((openSnapshot.activeOrders[0]?.unrealizedPnl ?? 0) - 80) < 1e-9);
  assert.ok(Math.abs((openSnapshot.activeOrders[0]?.unrealizedReturnPct ?? 0) - 20) < 1e-9);
  assert.equal(openSnapshot.activeOrders[0]?.stopPrice, 1.5);
  assert.equal(openSnapshot.activeOrders[0]?.targetPrice, 2.7);
  assert.ok(Math.abs(openSnapshot.performance.unrealizedPnl - 80) < 1e-9);
  assert.ok(Math.abs(openSnapshot.performance.totalPnl - 80) < 1e-9);
  assert.equal(openSnapshot.liveData.totalEvents, 1);
  assert.equal(openSnapshot.liveData.eventCounts.option_quote, 1);
  assert.equal(openSnapshot.liveData.recentEvents[0]?.channel, "OPRA");
  assert.match(openSnapshot.liveData.recentEvents[0]?.summary ?? "", /bid 2\.40/);
  assert.equal(openSnapshot.decisions[0]?.stage, "ENTRY_EVALUATION");
  assert.equal(openSnapshot.decisions[0]?.outcome, "NO_SIGNAL");
  assert.equal(openSnapshot.decisions[0]?.directions?.[0]?.reasons[0], "MEDIUM_SLOPE_MISALIGNED");

  dashboard.record(event("broker_order_request", {
    purpose: "EXIT", reason: "PROFIT_TARGET",
    order: {
      clientOrderId: "exit-1", symbol, side: "sell", requestedQuantity: 2, filledQuantity: 0,
      averageFillPrice: 0, limitPrice: 2.7, status: "SUBMITTED", submittedAt: timestamp + 60_000, replacements: 0,
    },
  }, 60_000));
  assert.equal(dashboard.snapshot().activeOrders[0]?.stage, "EXIT_WORKING");
  dashboard.record(event("exit_fill", {
    reason: "PROFIT_TARGET", symbol, direction: "BULLISH", entryTimestamp: timestamp,
    averageEntryPrice: 2, incrementalQuantity: 2, incrementalPrice: 2.7,
    realizedPnl: 140, remainingQuantity: 0, highWaterMark: 2.8, lowWaterMark: 1.8,
  }, 60_100));
  dashboard.record(event("broker_order_state", {
    purpose: "EXIT",
    broker: { id: "broker-exit-1", clientOrderId: "exit-1", status: "filled", filledQuantity: 2, averageFillPrice: 2.7 },
    localOrder: { clientOrderId: "exit-1", status: "FILLED", filledQuantity: 2, averageFillPrice: 2.7, limitPrice: 2.7, replacements: 0 },
  }, 60_110));

  const snapshot = dashboard.snapshot();
  assert.equal(snapshot.performance.entriesFired, 1);
  assert.equal(snapshot.performance.entryOrders, 1);
  assert.equal(snapshot.performance.exitOrders, 1);
  assert.equal(snapshot.performance.closedTrades, 1);
  assert.equal(snapshot.performance.wins, 1);
  assert.equal(snapshot.performance.winRate, 1);
  assert.equal(snapshot.performance.realizedPnl, 140);
  assert.equal(snapshot.performance.unrealizedPnl, 0);
  assert.equal(snapshot.performance.totalPnl, 140);
  assert.equal(snapshot.activeOrders.length, 0);
  assert.equal(snapshot.signals[0]?.status, "ORDER_SUBMITTED");
  assert.equal(snapshot.orders.find((order) => order.clientOrderId === "entry-1")?.filledQuantity, 2);
  assert.equal(snapshot.trades[0]?.averageExitPrice, 2.7);
  assert.equal(snapshot.trades[0]?.exitReason, "PROFIT_TARGET");
  assert.ok(Math.abs((snapshot.trades[0]?.maxFavorableExcursionPct ?? 0) - 40) < 1e-9);
  assert.ok(Math.abs((snapshot.trades[0]?.maxAdverseExcursionPct ?? 0) + 10) < 1e-9);
  assert.ok(Math.abs((snapshot.trades[0]?.capturePct ?? 0) - 87.5) < 1e-9);
  const quality = snapshot.tuning.entries[0];
  assert.equal(quality?.signalId, "signal-1");
  assert.equal(quality?.status, "WIN");
  assert.equal(quality?.signalToOrderMs, 10);
  assert.equal(quality?.orderToFirstFillMs, 20);
  assert.equal(quality?.signalToFirstFillMs, 30);
  assert.ok(Math.abs((quality?.entrySlippageBps ?? 0) + 99.0099009901) < 1e-6);
  assert.ok(Math.abs((quality?.priceImprovementBps ?? 0) - 49.7512437811) < 1e-6);
  assert.equal(snapshot.tuning.summary.signals, 1);
  assert.equal(snapshot.tuning.summary.filled, 1);
  assert.equal(snapshot.tuning.summary.fillRate, 1);
  assert.equal(snapshot.orders.find((order) => order.clientOrderId === "entry-1")?.firstFillLatencyMs, 20);
  assert.equal(snapshot.orders.find((order) => order.clientOrderId === "entry-1")?.completionLatencyMs, 20);
  assert.match(tradingDashboardHtml(), /Orders &amp; Executions/);
  assert.match(tradingDashboardHtml(), /Live Orders/);
  assert.match(tradingDashboardHtml(), /Entry Timing &amp; Quality/);
  assert.match(tradingDashboardHtml(), /Order Execution Quality/);
  assert.match(tradingDashboardHtml(), /Setup Comparison/);
});
