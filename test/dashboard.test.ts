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

test("dashboard reconstructs fired entries, broker execution, trades, and performance from audit history", () => {
  const dashboard = new TradingDashboardStore(timestamp);
  dashboard.record(event("live_signal_selection", {
    signalId: "signal-1", timestamp, direction: "BULLISH", kind: "IMPULSE", regime: "STRONG_UP",
    projectedMoveBps: 8.5, candidate: symbol,
  }));
  dashboard.record(event("broker_order_request", {
    purpose: "ENTRY",
    order: {
      clientOrderId: "entry-1", symbol, side: "buy", requestedQuantity: 2, filledQuantity: 0,
      averageFillPrice: 0, limitPrice: 2.01, status: "SUBMITTED", submittedAt: timestamp, replacements: 0,
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
      stopPrice: 1.5, targetPrice: 2.7,
    },
  }, 30));
  dashboard.recordMarketEvent({
    type: "option_quote", providerTimestamp: timestamp + 45, receivedTimestamp: timestamp + 46,
    marketDate: "2026-07-22", symbol,
    data: { symbol, timestamp: timestamp + 45, bidPrice: 2.4, askPrice: 2.42, bidSize: 50, askSize: 40 },
  } satisfies HistoricalMarketEvent);

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
    realizedPnl: 140, remainingQuantity: 0,
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
  assert.match(tradingDashboardHtml(), /Orders &amp; Executions/);
  assert.match(tradingDashboardHtml(), /Live Orders/);
});
