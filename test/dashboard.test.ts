import test from "node:test";
import assert from "node:assert/strict";
import {
  dashboardDisplayDate,
  nextDashboardDisplayRollover,
  TradingDashboardStore,
  tradingDashboardHtml,
  type DashboardOrderCard,
} from "../src/ops/tradingDashboard.js";
import type { AuditEvent } from "../src/ops/recorder.js";
import type { HistoricalMarketEvent } from "../src/history/types.js";

const timestamp = Date.parse("2026-07-22T14:20:00Z");
const symbol = "SPY260722C00501000";
const dashboardNow = () => timestamp + 120_000;

function historicalDashboard(): TradingDashboardStore {
  return new TradingDashboardStore(timestamp, true, 0, 0, dashboardNow);
}

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
  assert.match(html, /scheduleDisplayRollover/);
  assert.match(html, /window\.location\.reload/);
  assert.match(html, /resets at 10:00 PM Pacific/);
});

test("dashboard starts a new empty display day at 10 PM Pacific without restoring older rows", () => {
  const beforeRollover = Date.parse("2026-07-23T04:59:59Z");
  const rollover = Date.parse("2026-07-23T05:00:00Z");
  let now = beforeRollover;
  const dashboard = new TradingDashboardStore(beforeRollover, true, 250, 7, () => now);
  const signalEvent = (eventTimestamp: number, signalId: string): AuditEvent => ({
    timestamp: eventTimestamp,
    marketDate: "2026-07-22",
    type: "live_signal_selection",
    configVersion: "test",
    data: {
      signalId,
      timestamp: eventTimestamp,
      direction: "BULLISH",
      kind: "IMPULSE",
      regime: "STRONG_UP",
      candidate: symbol,
    },
  });

  dashboard.record(signalEvent(beforeRollover, "old-signal"));
  dashboard.recordMarketEvent({
    type: "stock_quote",
    providerTimestamp: beforeRollover - 1,
    receivedTimestamp: beforeRollover,
    marketDate: "2026-07-22",
    symbol: "SPY",
    data: { bidPrice: 500, askPrice: 500.01 },
  });
  let snapshot = dashboard.snapshot();
  assert.equal(dashboardDisplayDate(beforeRollover), "2026-07-22");
  assert.equal(nextDashboardDisplayRollover(beforeRollover), rollover);
  assert.equal(snapshot.displayDate, "2026-07-22");
  assert.equal(snapshot.displayTimeZone, "America/Los_Angeles");
  assert.equal(snapshot.nextDisplayRolloverAt, rollover);
  assert.equal(snapshot.signals.length, 1);
  assert.equal(snapshot.liveData.totalEvents, 1);

  now = rollover;
  snapshot = dashboard.snapshot();
  assert.equal(dashboardDisplayDate(rollover), "2026-07-23");
  assert.equal(snapshot.displayDate, "2026-07-23");
  assert.equal(snapshot.nextDisplayRolloverAt, Date.parse("2026-07-24T05:00:00Z"));
  assert.equal(snapshot.signals.length, 0);
  assert.equal(snapshot.orders.length, 0);
  assert.equal(snapshot.trades.length, 0);
  assert.equal(snapshot.decisions.length, 0);
  assert.equal(snapshot.liveData.totalEvents, 0);
  assert.equal(snapshot.lastMarketDate, undefined);

  dashboard.record(signalEvent(beforeRollover, "restored-old-signal"));
  assert.equal(dashboard.snapshot().signals.length, 0);
  dashboard.record(signalEvent(rollover + 1, "new-display-day-signal"));
  assert.equal(dashboard.snapshot().signals[0]?.id, "new-display-day-signal");
});

test("dashboard keeps restored completed order cards available across display-day rollover", () => {
  const now = Date.parse("2026-07-23T14:00:00Z");
  const dashboard = new TradingDashboardStore(now, true, 250, 7, () => now);
  dashboard.restoreOrderCards([{
    id: "historical-entry",
    symbol,
    direction: "BULLISH",
    active: false,
    stage: "CLOSED",
    status: "filled",
    quantity: 1,
    remainingQuantity: 0,
    entryPrice: 2,
    exitPrice: 2.25,
    realizedPnl: 25,
    unrealizedPnl: 0,
    totalPnl: 25,
    entryTimestamp: timestamp,
    exitTimestamp: timestamp + 60_000,
    exitReason: "PROFIT_TARGET",
    updates: [{
      timestamp: timestamp + 60_000,
      stage: "CLOSED",
      status: "filled",
      remainingQuantity: 0,
      realizedPnl: 25,
      unrealizedPnl: 0,
      totalPnl: 25,
    }],
  }]);

  const snapshot = dashboard.snapshot();
  assert.equal(snapshot.orders.length, 0);
  assert.equal(snapshot.trades.length, 0);
  assert.equal(snapshot.orderCards[0]?.id, "historical-entry");
  assert.equal(snapshot.orderCards[0]?.updates[0]?.totalPnl, 25);
});

test("dashboard persists a completed card with all captured P&L updates", async () => {
  const dashboard = historicalDashboard();
  const saved: DashboardOrderCard[] = [];
  dashboard.setOrderCardPersistence({
    async saveOrderCard(card) { saved.push(card); },
  });
  await dashboard.record(event("entry_fill", {
    position: {
      symbol, direction: "BULLISH", quantity: 1, averageEntryPrice: 2,
      entryTimestamp: timestamp, stopPrice: 1.5, targetPrice: 2.7,
      highWaterMark: 2, lowWaterMark: 2,
    },
  }));
  dashboard.recordMarketEvent({
    type: "option_quote", providerTimestamp: timestamp + 100, receivedTimestamp: timestamp + 101,
    marketDate: "2026-07-22", symbol,
    data: { timestamp: timestamp + 100, bidPrice: 2.1, askPrice: 2.12 },
  });
  dashboard.recordMarketEvent({
    type: "option_quote", providerTimestamp: timestamp + 200, receivedTimestamp: timestamp + 201,
    marketDate: "2026-07-22", symbol,
    data: { timestamp: timestamp + 200, bidPrice: 2.2, askPrice: 2.22 },
  });
  await dashboard.record(event("exit_fill", {
    reason: "PROFIT_TARGET", symbol, direction: "BULLISH", entryTimestamp: timestamp,
    averageEntryPrice: 2, incrementalQuantity: 1, incrementalPrice: 2.25,
    realizedPnl: 25, remainingQuantity: 0,
  }, 300));

  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.active, false);
  assert.equal(saved[0]?.stage, "CLOSED");
  assert.equal(saved[0]?.realizedPnl, 25);
  assert.deepEqual(
    saved[0]?.updates.filter((update) =>
      update.stage === "POSITION_OPEN" && update.totalPnl !== undefined).map((update) => Math.round(update.totalPnl!)),
    [10, 20],
  );
  assert.equal(saved[0]?.updates.at(-1)?.totalPnl, 25);
});

test("completed cards keep the exit order from their own trade window when symbols repeat", () => {
  const dashboard = historicalDashboard();
  dashboard.record(event("entry_fill", {
    position: {
      symbol, direction: "BULLISH", quantity: 1, averageEntryPrice: 2,
      entryTimestamp: timestamp, highWaterMark: 2, lowWaterMark: 2,
    },
  }));
  dashboard.record(event("broker_order_request", {
    purpose: "EXIT", reason: "TREND_INVALIDATION",
    order: {
      clientOrderId: "first-exit", symbol, side: "sell", requestedQuantity: 1,
      filledQuantity: 0, limitPrice: 1.9, status: "SUBMITTED",
      submittedAt: timestamp + 100, replacements: 0,
    },
  }, 100));
  dashboard.record(event("exit_fill", {
    reason: "TREND_INVALIDATION", symbol, direction: "BULLISH", entryTimestamp: timestamp,
    averageEntryPrice: 2, incrementalQuantity: 1, incrementalPrice: 1.9,
    realizedPnl: -10, remainingQuantity: 0,
  }, 110));
  dashboard.record(event("broker_order_state", {
    purpose: "EXIT",
    broker: {
      id: "first-broker-exit", clientOrderId: "first-exit", status: "filled",
      filledQuantity: 1, averageFillPrice: 1.9,
    },
    localOrder: {
      clientOrderId: "first-exit", status: "FILLED", filledQuantity: 1,
      averageFillPrice: 1.9, limitPrice: 1.9, replacements: 0,
    },
  }, 111));

  dashboard.record(event("entry_fill", {
    position: {
      symbol, direction: "BULLISH", quantity: 1, averageEntryPrice: 2.1,
      entryTimestamp: timestamp + 1_000, highWaterMark: 2.1, lowWaterMark: 2.1,
    },
  }, 1_000));
  dashboard.record(event("broker_order_request", {
    purpose: "EXIT", reason: "PROFIT_TARGET",
    order: {
      clientOrderId: "second-exit", symbol, side: "sell", requestedQuantity: 1,
      filledQuantity: 0, limitPrice: 2.3, status: "SUBMITTED",
      submittedAt: timestamp + 1_100, replacements: 0,
    },
  }, 1_100));

  const firstCard = dashboard.snapshot().orderCards.find((card) => card.entryTimestamp === timestamp);
  assert.equal(firstCard?.workingOrder?.clientOrderId, "first-exit");
  assert.equal(firstCard?.status, "filled");
  assert.ok(firstCard?.updates.every((update) => update.timestamp <= timestamp + 111));
});

test("dashboard separates potential hindsight misses from routine no-signal evaluations", () => {
  const dashboard = historicalDashboard();
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

  const safetyBlocked = historicalDashboard();
  safetyBlocked.record(event("live_entry_evaluation", {
    ...noSignal(500),
    reasons: ["WHIPSAW_REGIME_BLOCKED"],
  }));
  safetyBlocked.record(event("live_entry_evaluation", noSignal(500.15), 5_000));
  assert.equal(safetyBlocked.snapshot().tuning.falseNegativeSummary.matureNoSignalEvaluations, 1);
  assert.equal(safetyBlocked.snapshot().tuning.falseNegativeSummary.potentialMisses, 0);
});

test("dashboard reconstructs fired entries, broker execution, trades, and performance from audit history", () => {
  const dashboard = historicalDashboard();
  dashboard.record(event("live_signal_selection", {
    signalId: "signal-1", timestamp, direction: "BULLISH", kind: "IMPULSE", regime: "STRONG_UP",
    projectedMoveBps: 8.5, candidate: symbol, evaluatedContracts: 24,
    candidateMetrics: { score: 12.5, delta: 0.52, mid: 2, spreadPct: 0.02, costMarginBps: 3.1 },
    candidateQuote: { timestamp, bidPrice: 1.98, askPrice: 2.02 },
  }));
  dashboard.record(event("risk_decision", {
    signalId: "signal-1",
    risk: { allowed: true, reasons: [], quantity: 2, stopPrice: 1.5, targetPrice: 2.7 },
  }, 5));
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
  assert.equal(openSnapshot.orderCards.length, 1);
  assert.equal(openSnapshot.orderCards[0]?.id, "entry-1");
  assert.equal(openSnapshot.orderCards[0]?.active, true);
  assert.ok(openSnapshot.orderCards[0]?.updates.some((update) =>
    update.stage === "POSITION_OPEN" && Math.abs((update.totalPnl ?? 0) - 80) < 1e-9));
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
  assert.equal(snapshot.performance.signalsFired, 1);
  assert.equal(snapshot.performance.optionsSelected, 1);
  assert.equal(snapshot.performance.riskAllowed, 1);
  assert.equal(snapshot.performance.riskBlocked, 0);
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
  assert.equal(snapshot.orderCards.length, 1);
  assert.equal(snapshot.orderCards[0]?.stage, "CLOSED");
  assert.equal(snapshot.orderCards[0]?.active, false);
  assert.equal(snapshot.orderCards[0]?.realizedPnl, 140);
  assert.ok((snapshot.orderCards[0]?.updates.length ?? 0) >= 5);
  assert.ok(snapshot.orderCards[0]?.updates.some((update) =>
    update.stage === "CLOSED" && update.status === "filled" && update.totalPnl === 140));
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
  assert.match(tradingDashboardHtml(), /<h2>Orders<\/h2>/);
  assert.doesNotMatch(tradingDashboardHtml(), /<h2>Live Orders<\/h2>/);
  assert.match(tradingDashboardHtml(), /P&amp;L or status change/);
  assert.match(tradingDashboardHtml(), /Entry Timing &amp; Quality/);
  assert.match(tradingDashboardHtml(), /Order Execution Quality/);
  assert.match(tradingDashboardHtml(), /Setup Comparison/);
  assert.match(tradingDashboardHtml(), /Signal → Trade Funnel/);
  assert.match(tradingDashboardHtml(), /Winner Profit Capture/);
});

test("dashboard exposes the full signal funnel and excludes losses from profit capture", () => {
  const dashboard = historicalDashboard();
  dashboard.record(event("live_signal_selection", {
    signalId: "no-option", timestamp, direction: "BULLISH", kind: "IMPULSE", regime: "STRONG_UP",
    projectedMoveBps: 0.4, candidate: null, evaluatedContracts: 24,
  }));
  dashboard.record(event("live_signal_selection", {
    signalId: "risk-blocked", timestamp: timestamp + 1_000, direction: "BULLISH", kind: "IMPULSE",
    regime: "STRONG_UP", projectedMoveBps: 1, candidate: symbol, evaluatedContracts: 24,
  }, 1_000));
  dashboard.record(event("risk_decision", {
    signalId: "risk-blocked",
    risk: { allowed: false, reasons: ["MAX_DAILY_ENTRIES_REACHED"], quantity: 0 },
  }, 1_010));
  dashboard.record(event("live_signal_selection", {
    signalId: "risk-allowed", timestamp: timestamp + 2_000, direction: "BULLISH", kind: "IMPULSE",
    regime: "STRONG_UP", projectedMoveBps: 1, candidate: symbol, evaluatedContracts: 24,
  }, 2_000));
  dashboard.record(event("risk_decision", {
    signalId: "risk-allowed", risk: { allowed: true, reasons: [], quantity: 1 },
  }, 2_010));

  let snapshot = dashboard.snapshot();
  assert.equal(snapshot.performance.signalsFired, 3);
  assert.equal(snapshot.performance.optionsSelected, 2);
  assert.equal(snapshot.performance.riskAllowed, 1);
  assert.equal(snapshot.performance.riskBlocked, 1);
  assert.equal(snapshot.signals.find((signal) => signal.id === "risk-blocked")?.status, "ORDER_BLOCKED");

  dashboard.record(event("entry_fill", {
    position: {
      symbol, direction: "BULLISH", quantity: 1, averageEntryPrice: 2,
      entryTimestamp: timestamp + 2_100, highWaterMark: 2, lowWaterMark: 2,
    },
  }, 2_100));
  dashboard.recordMarketEvent({
    type: "option_quote", providerTimestamp: timestamp + 2_200, receivedTimestamp: timestamp + 2_201,
    marketDate: "2026-07-22", symbol,
    data: { symbol, timestamp: timestamp + 2_200, bidPrice: 2.09, askPrice: 2.11, bidSize: 50, askSize: 50 },
  });
  dashboard.record(event("exit_fill", {
    reason: "TREND_INVALIDATION", symbol, direction: "BULLISH", entryTimestamp: timestamp + 2_100,
    averageEntryPrice: 2, incrementalQuantity: 1, incrementalPrice: 1.9,
    realizedPnl: -10, remainingQuantity: 0, highWaterMark: 2.1, lowWaterMark: 1.9,
  }, 2_300));
  snapshot = dashboard.snapshot();
  assert.ok(Math.abs((snapshot.trades[0]?.maxFavorableExcursionPct ?? 0) - 5) < 1e-9);
  assert.ok(Math.abs((snapshot.trades[0]?.maxAdverseExcursionPct ?? 0) + 5) < 1e-9);
  assert.equal(snapshot.trades[0]?.capturePct, undefined);
  assert.equal(snapshot.tuning.summary.avgCapturePct, undefined);

  const winner = historicalDashboard();
  winner.record(event("entry_fill", {
    position: {
      symbol, direction: "BULLISH", quantity: 1, averageEntryPrice: 2,
      entryTimestamp: timestamp, highWaterMark: 2, lowWaterMark: 2,
    },
  }));
  winner.record(event("exit_fill", {
    reason: "OPPOSITE_REGIME", symbol, direction: "BULLISH", entryTimestamp: timestamp,
    averageEntryPrice: 2, incrementalQuantity: 1, incrementalPrice: 2.2,
    realizedPnl: 20, remainingQuantity: 0, highWaterMark: 2, lowWaterMark: 2,
  }, 1_000));
  const winningTrade = winner.snapshot().trades[0];
  assert.ok(Math.abs((winningTrade?.maxFavorableExcursionPct ?? 0) - 10) < 1e-9);
  assert.ok(Math.abs((winningTrade?.capturePct ?? 0) - 100) < 1e-9);
});
