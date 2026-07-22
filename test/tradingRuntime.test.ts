import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import type { BrokerOrder, BrokerOrderRequest } from "../src/alpaca/restClient.js";
import type { StockStream, StockStreamHandlers } from "../src/alpaca/stockStream.js";
import type { OptionStream, OptionStreamHandlers } from "../src/alpaca/optionStream.js";
import type { SpyOptionsRuntimeClient } from "../src/runtime/spyOptionsTradingRuntime.js";
import {
  optionUniverseRequired, restoreRuntimeState, SpyOptionsTradingRuntime,
} from "../src/runtime/spyOptionsTradingRuntime.js";
import type {
  AccountState, FeatureSnapshot, OptionContract, OptionQuote, OptionSnapshot, PositionState, StockQuote,
  WindowMetrics,
} from "../src/types.js";
import { zonedDateTimeToEpoch } from "../src/utils/time.js";
import type { HistoricalMarketEvent, MarketHistorySink } from "../src/history/types.js";
import { MemoryRecorder, type AuditEvent } from "../src/ops/recorder.js";
import { RiskManager } from "../src/risk/riskManager.js";

const date = "2026-07-22";
const now = zonedDateTimeToEpoch(date, "10:20:00");
const callSymbol = "SPY260722C00501000";
const immediateRuntimeConfig = structuredClone(defaultConfig);
immediateRuntimeConfig.signals.followThroughMinSec = 0;
immediateRuntimeConfig.signals.followThroughMaxSec = 0;
const enforcedRuntimeConfig = structuredClone(defaultConfig);
enforcedRuntimeConfig.signals.entryQualityMode = "ENFORCE";

test("option universe readiness follows the 0DTE cutoff while protecting open exposure", () => {
  const beforeCutoff = zonedDateTimeToEpoch(date, "14:29:59");
  const atCutoff = zonedDateTimeToEpoch(date, "14:30:00");
  const afterCutoff = zonedDateTimeToEpoch(date, "14:30:01");

  assert.equal(optionUniverseRequired(beforeCutoff, true, false, defaultConfig), true);
  assert.equal(optionUniverseRequired(atCutoff, true, false, defaultConfig), true);
  assert.equal(optionUniverseRequired(afterCutoff, true, false, defaultConfig), false);
  assert.equal(optionUniverseRequired(afterCutoff, true, true, defaultConfig), true);
  assert.equal(optionUniverseRequired(beforeCutoff, false, true, defaultConfig), false);
});

class FakeStockStream implements StockStream {
  handlers: StockStreamHandlers | undefined;
  connectCalls = 0;
  closeCalls = 0;
  async connect(handlers: StockStreamHandlers): Promise<void> {
    this.connectCalls += 1;
    this.handlers = handlers;
    handlers.onState?.(true);
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.handlers?.onState?.(false);
  }
}

class FakeOptionStream implements OptionStream {
  handlers: OptionStreamHandlers | undefined;
  readonly subscribed = new Set<string>();
  connectCalls = 0;
  closeCalls = 0;
  async subscribe(symbols: readonly string[]): Promise<void> { for (const symbol of symbols) this.subscribed.add(symbol); }
  async unsubscribe(symbols: readonly string[]): Promise<void> { for (const symbol of symbols) this.subscribed.delete(symbol); }
  async connect(handlers: OptionStreamHandlers): Promise<void> {
    this.connectCalls += 1;
    this.handlers = handlers;
    handlers.onState?.(true);
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.handlers?.onState?.(false);
  }
  async quote(quote: OptionQuote): Promise<void> { await this.handlers?.onQuote(quote); }
}

class FakeHistory implements MarketHistorySink {
  readonly events: HistoricalMarketEvent[] = [];
  readonly priorityChanges: string[][] = [];
  recordMarketEvent(event: HistoricalMarketEvent): void { this.events.push(event); }
  setPrioritySymbols(symbols: ReadonlySet<string>): void { this.priorityChanges.push([...symbols]); }
  healthy(): boolean { return true; }
}

class FakeRuntimeClient implements SpyOptionsRuntimeClient {
  readonly requests: BrokerOrderRequest[] = [];
  readonly contract: OptionContract = {
    symbol: callSymbol, underlying: "SPY", expirationDate: date, strike: 501,
    type: "call", active: true, tradable: true,
  };
  readonly account: AccountState = {
    equity: 100_000, optionBuyingPower: 25_000, active: true, optionsApproved: true, killSwitch: false,
  };
  clock = { timestamp: now, isOpen: true };
  latestQuoteCalls = 0;
  listContractCalls = 0;
  async getAccount(): Promise<AccountState> { return { ...this.account }; }
  async getMarketClock(): Promise<{ timestamp: number; isOpen: boolean }> { return { ...this.clock }; }
  async getLatestSpySipQuote(): Promise<StockQuote> {
    this.latestQuoteCalls += 1;
    return { symbol: "SPY", timestamp: now, bidPrice: 500.99, askPrice: 501.01, bidSize: 100, askSize: 100 };
  }
  async listOptionContracts(): Promise<OptionContract[]> {
    this.listContractCalls += 1;
    return [{ ...this.contract }];
  }
  async getOptionSnapshots(symbols: readonly string[]): Promise<OptionSnapshot[]> {
    return symbols.map((symbol) => ({
      symbol, timestamp: now - 86_400_000, impliedVolatility: 0.22, greeks: { delta: 0.52, gamma: 0.02 },
      dailyVolume: 1_000, openInterest: 5_000,
    }));
  }
  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder> {
    this.requests.push({ ...request });
    return {
      id: "paper-order-1", clientOrderId: request.clientOrderId, symbol: request.symbol,
      status: "new", filledQuantity: 0,
    };
  }
  async getOrder(): Promise<BrokerOrder> { throw new Error("unexpected order poll"); }
  async getOrderByClientOrderId(): Promise<BrokerOrder> { throw new Error("unexpected submission recovery"); }
  async replaceOrder(): Promise<BrokerOrder> { throw new Error("unexpected order replacement"); }
  async cancelOrder(): Promise<void> { throw new Error("unexpected order cancellation"); }
  async listOpenOrders(): Promise<BrokerOrder[]> { return []; }
  async listPositions(): Promise<PositionState[]> { return []; }
}

function windowMetric(
  windowSec: number, slope: number, acceleration: number, normalizedSlope: number, normalizedAcceleration: number,
): WindowMetrics {
  return {
    windowSec,
    regression: {
      valid: true, windowSec, pointCount: windowSec + 1, coverageFraction: 1, levelLog: Math.log(501),
      slopeBpsPerSec: slope, accelerationBpsPerSec2: acceleration, r2: 0.8,
      coefficients: [Math.log(501), slope * windowSec / 10_000, acceleration * windowSec ** 2 / 20_000],
    },
    realizedVolatilityBps: 2, efficiencyRatio: 0.6, noiseFloorBps: 2,
    normalizedSlope, normalizedAcceleration, signChanges: 0,
  };
}

function bullishFeature(): FeatureSnapshot {
  return {
    symbol: "SPY", timestamp: now, marketDate: date, price: 501, mid: 501,
    spreadBps: 0.2, quoteAgeMs: 100, quoteImbalance: 0.5,
    quoteImbalanceEwma5: 0.5, quoteImbalanceEwma15: 0.4, micropriceDisplacementBps: 0.1,
    ofi1: 0.1, ofi5: 0.2, ofi15: 0.1, volume60: 100_000,
    fast: windowMetric(10, 0.6, 0.02, 0.8, 0.2),
    medium: windowMetric(30, 0.2, 0, 0.6, 0),
    slow: windowMetric(120, 0.04, 0, 0.3, 0),
    efficiency60: 0.6, signChanges60: 0,
    vwap: { sessionVwap: 500, rollingVwap: 500.5, rollingVwapSlopeBpsPerSec: 0.05, anchoredVwaps: {} },
    openingRange: {
      complete: true, high: 500.8, low: 499.2, midpoint: 500, widthBps: 32,
      nearHigh: true, nearLow: false, bullishRetest: false, bearishRetest: false,
    },
    thresholds: {
      source: "static", bucket: "10:20", sampleCount: 0, fastSlope: 0.42,
      fastAcceleration: 0.1, absoluteOfi5: 0.08, efficiency60: 0.28,
    },
    dataValid: true, invalidReasons: [],
  };
}

function bearishFeature(timestamp = now, price = 499): FeatureSnapshot {
  const bullish = bullishFeature();
  return {
    ...bullish,
    timestamp,
    price,
    mid: price,
    quoteImbalance: -0.5,
    quoteImbalanceEwma5: -0.5,
    quoteImbalanceEwma15: -0.4,
    micropriceDisplacementBps: -0.1,
    ofi1: -0.1,
    ofi5: -0.2,
    ofi15: -0.1,
    fast: windowMetric(10, -0.6, -0.02, -0.8, -0.2),
    medium: windowMetric(30, -0.2, 0, -0.6, 0),
    slow: windowMetric(120, -0.04, 0, -0.3, 0),
    vwap: { sessionVwap: 500, rollingVwap: 499.5, rollingVwapSlopeBpsPerSec: -0.05, anchoredVwaps: {} },
    openingRange: {
      ...bullish.openingRange,
      nearHigh: false,
      nearLow: true,
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime state transition");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("market-closed startup remains idle without SIP, OPRA, universe, or strategy activity", async () => {
  const closedAt = zonedDateTimeToEpoch(date, "16:30:00");
  const client = new FakeRuntimeClient();
  client.clock = { timestamp: closedAt, isOpen: false };
  const stockStream = new FakeStockStream();
  const optionStream = new FakeOptionStream();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config: defaultConfig,
    client,
    stockStream,
    optionStream,
    executionEnabled: true,
    executionMode: "paper",
    now: () => closedAt,
    executionTickMs: 10,
    recorder,
  });
  await runtime.start();
  const health = runtime.healthState();
  assert.equal(health.ready, true);
  assert.equal(health.marketDataIdle, true);
  assert.equal(health.marketClockState, "market-closed-idle");
  assert.equal(health.websocketConnected, false);
  assert.equal(stockStream.connectCalls, 0);
  assert.equal(optionStream.connectCalls, 0);
  assert.equal(client.latestQuoteCalls, 0);
  assert.equal(client.listContractCalls, 0);
  assert.equal(health.restoredStockEvents, 0);
  assert.equal(health.strategyStateStatus, "MARKET_CLOSED_IDLE");
  assert.equal(recorder.events.some((event) => event.type === "strategy_state_recovery"), false);
  const eventCount = recorder.events.length;
  await runtime.ingestFeature({ ...bullishFeature(), timestamp: closedAt });
  assert.equal(recorder.events.length, eventCount);
  assert.ok(recorder.events.some((event) => event.type === "market_session_idle"));
  await runtime.close();
});

test("market close disconnects activity and the next open reconnects automatically", async () => {
  let decisionTime = now;
  const client = new FakeRuntimeClient();
  const stockStream = new FakeStockStream();
  const optionStream = new FakeOptionStream();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config: defaultConfig,
    client,
    stockStream,
    optionStream,
    executionEnabled: true,
    executionMode: "paper",
    now: () => decisionTime,
    executionTickMs: 10,
    recorder,
  });
  await runtime.start();
  assert.equal(stockStream.connectCalls, 1);
  assert.equal(optionStream.connectCalls, 1);

  decisionTime = zonedDateTimeToEpoch(date, "16:00:01");
  client.clock = { timestamp: decisionTime, isOpen: false };
  await waitFor(() => runtime.healthState().marketDataIdle === true);
  await waitFor(() => stockStream.closeCalls > 0 && optionStream.closeCalls > 0);
  assert.equal(runtime.healthState().websocketConnected, false);
  assert.equal(runtime.healthState().ready, true);
  const evaluationCount = recorder.events.filter((event) => event.type === "live_entry_evaluation").length;
  await runtime.ingestFeature({ ...bullishFeature(), timestamp: decisionTime });
  assert.equal(recorder.events.filter((event) => event.type === "live_entry_evaluation").length, evaluationCount);

  decisionTime = zonedDateTimeToEpoch("2026-07-23", "09:30:01");
  client.clock = { timestamp: decisionTime, isOpen: true };
  await waitFor(() => stockStream.connectCalls === 2 && optionStream.connectCalls === 2);
  assert.equal(runtime.healthState().marketDataIdle, false);
  assert.ok(recorder.events.some((event) => event.type === "market_session_resumed"));
  await runtime.close();
});

test("end-to-end paper runtime arms SIP/OPRA and routes an eligible signal to a same-day SPY option order", async () => {
  const client = new FakeRuntimeClient();
  const stockStream = new FakeStockStream();
  const optionStream = new FakeOptionStream();
  const history = new FakeHistory();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config: immediateRuntimeConfig, client, stockStream, optionStream, executionEnabled: true,
    executionMode: "paper", now: () => now, executionTickMs: 60_000, history, recorder,
  });
  await runtime.start();
  assert.equal(runtime.healthState().ready, true);
  assert.equal(runtime.healthState().accountOptionsApproved, true);
  assert.deepEqual([...optionStream.subscribed], [callSymbol]);

  await optionStream.quote({
    symbol: callSymbol, timestamp: now, bidPrice: 1.99, askPrice: 2.01, bidSize: 100, askSize: 100,
  });
  await runtime.ingestFeature(bullishFeature());

  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0]?.symbol, callSymbol);
  assert.equal(client.requests[0]?.side, "buy");
  assert.equal(client.requests[0]?.timeInForce, "day");
  assert.notEqual(client.requests[0]?.symbol, "SPY");
  assert.equal(runtime.healthState().pendingOrder, true);
  assert.deepEqual(history.priorityChanges.at(-1), [callSymbol]);
  assert.ok(history.events.some((event) => event.type === "option_contract" && event.symbol === callSymbol));
  assert.ok(history.events.some((event) => event.type === "option_snapshot" && event.symbol === callSymbol));
  assert.equal(history.events.find((event) => event.type === "option_snapshot")?.marketDate, date);
  assert.ok(history.events.some((event) => event.type === "option_quote" && event.symbol === callSymbol));
  assert.ok(history.events.some((event) => event.type === "feature_snapshot" && event.symbol === "SPY"));
  const evaluation = recorder.events.find((event) => event.type === "live_entry_evaluation");
  assert.equal(evaluation?.data.decision, "SIGNAL");
  assert.equal(evaluation?.data.direction, "BULLISH");
  assert.ok(Array.isArray(evaluation?.data.directions));
  const selection = recorder.events.find((event) => event.type === "live_signal_selection");
  assert.equal(selection?.data.candidate, callSymbol);
  assert.deepEqual(selection?.data.candidateQuote, { timestamp: now, bidPrice: 1.99, askPrice: 2.01 });
  assert.equal(typeof (selection?.data.candidateMetrics as Record<string, unknown> | undefined)?.spreadPct, "number");
  const orderRequest = recorder.events.find((event) => event.type === "broker_order_request");
  assert.equal(orderRequest?.data.signalId, selection?.data.signalId);
  const riskRecovery = recorder.events.find((event) => event.type === "daily_risk_state_recovery");
  assert.equal(riskRecovery?.data.restoredEntries, 0);
  assert.equal(riskRecovery?.data.activeMaxTradesPerDay, defaultConfig.risk.maxTradesPerDay);
  assert.equal(riskRecovery?.data.shadowMaxTradesPerDay, defaultConfig.risk.entryQualityMaxTradesPerDay);
  await runtime.close();
  assert.deepEqual(history.priorityChanges.at(-1), []);
});

test("restart restoration deduplicates partial entry fills and preserves the daily cap", () => {
  const events: AuditEvent[] = [
    {
      timestamp: now - 30_000, marketDate: date, type: "entry_fill", configVersion: "before",
      data: { signalId: "signal-1", position: { symbol: callSymbol, direction: "BULLISH", entryTimestamp: now - 30_000 } },
    },
    {
      timestamp: now - 29_000, marketDate: date, type: "entry_fill", configVersion: "before",
      data: { signalId: "signal-1", position: { symbol: callSymbol, direction: "BULLISH", entryTimestamp: now - 30_000 } },
    },
    {
      timestamp: now - 20_000, marketDate: date, type: "entry_fill", configVersion: "before",
      data: { signalId: "signal-2", position: { symbol: callSymbol, direction: "BEARISH", entryTimestamp: now - 20_000 } },
    },
    {
      timestamp: now - 10_000, marketDate: date, type: "exit_fill", configVersion: "before",
      data: { realizedPnl: -25 },
    },
    {
      timestamp: now - 86_400_000, marketDate: "2026-07-21", type: "entry_fill", configVersion: "before",
      data: { signalId: "prior-day", position: { symbol: callSymbol, direction: "BULLISH", entryTimestamp: now - 86_400_000 } },
    },
  ];
  const restored = restoreRuntimeState(events, now, defaultConfig.timeZone);
  assert.deepEqual(restored.risk, { marketDate: date, entries: 2, realizedPnl: -25 });
  assert.equal(restored.signal.lastEntries?.BULLISH, now - 30_000);
  assert.equal(restored.signal.lastEntries?.BEARISH, now - 20_000);

  const cappedConfig = structuredClone(defaultConfig);
  cappedConfig.risk.maxTradesPerDay = 2;
  const risk = new RiskManager(cappedConfig);
  risk.restoreState(restored.risk);
  const decision = risk.evaluate({
    timestamp: now,
    optionMid: 2,
    hasOpenPosition: false,
    account: { equity: 100_000, optionBuyingPower: 25_000, active: true, optionsApproved: true, killSwitch: false },
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.includes("MAX_DAILY_ENTRIES_REACHED"));
});

test("restart after six unique fills restores an active shadow entry cap", async () => {
  const restoredAuditEvents: AuditEvent[] = Array.from({ length: 6 }, (_, index) => ({
    timestamp: now - (index + 1) * 1_000,
    marketDate: date,
    type: "entry_fill",
    configVersion: "before",
    data: {
      signalId: `restart-fill-${index}`,
      position: {
        symbol: callSymbol,
        direction: index % 2 === 0 ? "BULLISH" : "BEARISH",
        entryTimestamp: now - (index + 1) * 1_000,
      },
    },
  }));
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config: defaultConfig,
    client: new FakeRuntimeClient(),
    stockStream: new FakeStockStream(),
    optionStream: new FakeOptionStream(),
    executionEnabled: false,
    executionMode: "paper",
    now: () => now,
    executionTickMs: 60_000,
    recorder,
    restoredAuditEvents,
  });
  await runtime.start();
  const recovery = recorder.events.find((event) => event.type === "daily_risk_state_recovery");
  assert.equal(recovery?.data.restoredEntries, 6);
  assert.equal(recovery?.data.activeEntryCapReached, false);
  assert.equal(recovery?.data.shadowEntryCapReached, true);
  await runtime.close();
});

test("shadow confirmation observes a pending candidate without delaying the paper order", async () => {
  const client = new FakeRuntimeClient();
  const optionStream = new FakeOptionStream();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config: defaultConfig,
    client,
    stockStream: new FakeStockStream(),
    optionStream,
    executionEnabled: true,
    executionMode: "paper",
    now: () => now,
    executionTickMs: 60_000,
    recorder,
  });
  await runtime.start();
  await optionStream.quote({
    symbol: callSymbol, timestamp: now, bidPrice: 1.99, askPrice: 2.01, bidSize: 100, askSize: 100,
  });
  await runtime.ingestFeature(bullishFeature());
  assert.equal(client.requests.length, 1);
  const evaluation = recorder.events.find((event) => event.type === "live_entry_evaluation");
  assert.equal(evaluation?.data.decision, "SIGNAL");
  const shadow = evaluation?.data.shadowEvaluation as Record<string, unknown>;
  assert.equal(shadow.decision, "NO_SIGNAL");
  assert.deepEqual(shadow.reasons, ["FOLLOW_THROUGH_PENDING"]);
  await runtime.close();
});

test("post-14:30 baseline candidates are labeled research-only before option selection", async () => {
  const afterCutoff = zonedDateTimeToEpoch(date, "14:30:01");
  const client = new FakeRuntimeClient();
  client.clock.timestamp = afterCutoff;
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config: defaultConfig,
    client,
    stockStream: new FakeStockStream(),
    optionStream: new FakeOptionStream(),
    executionEnabled: true,
    executionMode: "paper",
    now: () => afterCutoff,
    executionTickMs: 60_000,
    recorder,
  });
  await runtime.start();
  await runtime.ingestFeature({ ...bullishFeature(), timestamp: afterCutoff });
  const evaluation = recorder.events.find((event) => event.type === "live_entry_evaluation");
  assert.equal(evaluation?.data.decision, "RESEARCH_ONLY");
  assert.equal(evaluation?.data.actionability, "RESEARCH_ONLY");
  assert.ok((evaluation?.data.reasons as string[]).includes("ZERO_DTE_ENTRY_CUTOFF_PASSED"));
  assert.equal(recorder.events.some((event) => event.type === "live_signal_selection"), false);
  assert.equal(client.requests.length, 0);
  await runtime.close();
});

test("enforced opt-in waits for causal follow-through before submitting an entry", async () => {
  let decisionTime = now;
  const client = new FakeRuntimeClient();
  const optionStream = new FakeOptionStream();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config: enforcedRuntimeConfig,
    client,
    stockStream: new FakeStockStream(),
    optionStream,
    executionEnabled: true,
    executionMode: "paper",
    now: () => decisionTime,
    executionTickMs: 60_000,
    recorder,
  });
  await runtime.start();
  await optionStream.quote({
    symbol: callSymbol, timestamp: decisionTime, bidPrice: 1.99, askPrice: 2.01, bidSize: 100, askSize: 100,
  });
  await runtime.ingestFeature(bullishFeature());
  assert.equal(client.requests.length, 0);
  assert.equal(recorder.events.find((event) => event.type === "live_entry_evaluation")?.data.decision, "NO_SIGNAL");

  decisionTime += defaultConfig.signals.followThroughMinSec * 1000;
  client.clock.timestamp = decisionTime;
  await optionStream.quote({
    symbol: callSymbol, timestamp: decisionTime, bidPrice: 1.99, askPrice: 2.01, bidSize: 100, askSize: 100,
  });
  await runtime.ingestFeature({
    ...bullishFeature(), timestamp: decisionTime, price: 501.02, mid: 501.02,
  });
  assert.equal(client.requests.length, 1);
  const signalEvaluation = recorder.events.find(
    (event) => event.type === "live_entry_evaluation" && event.data.decision === "SIGNAL",
  );
  assert.ok(signalEvaluation);
  assert.equal((signalEvaluation?.data.shadowEvaluation as Record<string, unknown>).decision, "SIGNAL");
  await runtime.close();
});

test("all confirmation scopes are audited together and cannot submit an order", async () => {
  let decisionTime = now;
  const client = new FakeRuntimeClient();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config: defaultConfig,
    client,
    stockStream: new FakeStockStream(),
    optionStream: new FakeOptionStream(),
    executionEnabled: false,
    executionMode: "paper",
    now: () => decisionTime,
    executionTickMs: 60_000,
    recorder,
  });
  await runtime.start();
  await runtime.ingestFeature(bearishFeature());
  decisionTime += defaultConfig.signals.followThroughMinSec * 1000;
  await runtime.ingestFeature(bearishFeature(decisionTime, 498.98));

  const evaluations = recorder.events.filter((event) => event.type === "live_entry_evaluation");
  const latest = evaluations.at(-1)!;
  assert.equal(latest.data.decision, "SKIPPED");
  assert.ok((latest.data.reasons as string[]).includes("EXECUTION_DISABLED"));
  const shadowProfiles = latest.data.shadowEvaluations as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(shadowProfiles), ["BULLISH_IMPULSE", "IMPULSE", "ALL"]);
  assert.equal(shadowProfiles.ALL?.decision, "SIGNAL");
  assert.equal(client.requests.length, 0);
  await runtime.close();
});

test("paper runtime fails closed when current-session SIP recovery is unavailable", async () => {
  const client = new FakeRuntimeClient();
  const optionStream = new FakeOptionStream();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config: defaultConfig,
    client,
    stockStream: new FakeStockStream(),
    optionStream,
    executionEnabled: true,
    executionMode: "paper",
    requireStrategyRecovery: true,
    now: () => now,
    executionTickMs: 60_000,
    recorder,
  });
  await runtime.start();
  assert.equal(runtime.healthState().strategyStateReady, false);
  assert.equal(runtime.healthState().strategyStateStatus, "HISTORY_UNAVAILABLE");
  assert.equal(runtime.healthState().ready, false);
  await optionStream.quote({
    symbol: callSymbol, timestamp: now, bidPrice: 1.99, askPrice: 2.01, bidSize: 100, askSize: 100,
  });
  await runtime.ingestFeature(bullishFeature());
  assert.equal(client.requests.length, 0);
  const evaluation = recorder.events.find((event) => event.type === "live_entry_evaluation");
  assert.equal(evaluation?.data.decision, "SKIPPED");
  assert.deepEqual(evaluation?.data.reasons, ["STRATEGY_STATE_NOT_READY"]);
  await runtime.close();
});
