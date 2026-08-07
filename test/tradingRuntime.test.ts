import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import type { BrokerOrder, BrokerOrderRequest } from "../src/alpaca/restClient.js";
import type { StockStream, StockStreamHandlers } from "../src/alpaca/stockStream.js";
import type { OptionStream, OptionStreamHandlers } from "../src/alpaca/optionStream.js";
import type { SpyOptionsRuntimeClient } from "../src/runtime/spyOptionsTradingRuntime.js";
import {
  OPTION_QUOTE_STALL_TIMEOUT_MS, optionUniverseRequired, restoreRuntimeState, SpyOptionsTradingRuntime,
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
immediateRuntimeConfig.signals.entryConfirmationMode = "SHADOW";
immediateRuntimeConfig.signals.followThroughMinSec = 0;
immediateRuntimeConfig.signals.followThroughMaxSec = 0;
const enforcedRuntimeConfig = structuredClone(defaultConfig);
enforcedRuntimeConfig.signals.entryConfirmationMode = "ENFORCE";

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
  async quotes(quotes: readonly OptionQuote[]): Promise<void> {
    if (this.handlers?.onQuotes) await this.handlers.onQuotes(quotes);
    else for (const quote of quotes) await this.handlers?.onQuote(quote);
  }
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
  latestOptionQuoteCalls = 0;
  latestOptionQuotes: OptionQuote[] = [];
  listContractCalls = 0;
  contractListGate: Promise<void> | undefined;
  async getAccount(): Promise<AccountState> { return { ...this.account }; }
  async getMarketClock(): Promise<{ timestamp: number; isOpen: boolean }> { return { ...this.clock }; }
  async getLatestSpySipQuote(): Promise<StockQuote> {
    this.latestQuoteCalls += 1;
    return { symbol: "SPY", timestamp: now, bidPrice: 500.99, askPrice: 501.01, bidSize: 100, askSize: 100 };
  }
  async listOptionContracts(): Promise<OptionContract[]> {
    this.listContractCalls += 1;
    await this.contractListGate;
    return [{ ...this.contract }];
  }
  async getOptionSnapshots(symbols: readonly string[]): Promise<OptionSnapshot[]> {
    return symbols.map((symbol) => ({
      symbol, timestamp: now - 86_400_000, impliedVolatility: 0.22, greeks: { delta: 0.52, gamma: 0.02 },
      dailyVolume: 1_000, openInterest: 5_000,
    }));
  }
  async getLatestOptionQuotes(symbols: readonly string[]): Promise<OptionQuote[]> {
    this.latestOptionQuoteCalls += 1;
    const requested = new Set(symbols);
    return this.latestOptionQuotes.filter((quote) => requested.has(quote.symbol)).map((quote) => ({ ...quote }));
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

function lateLowNoiseBullishGrindFeature(timestamp: number): FeatureSnapshot {
  const base = bullishFeature();
  const {
    bullishBreakoutTimestamp: _bullishBreakoutTimestamp,
    ...openingRangeWithoutBullishBreakout
  } = base.openingRange;
  return {
    ...base,
    timestamp,
    micropriceDisplacementBps: -0.1,
    fast: {
      ...base.fast,
      noiseFloorBps: 0.8,
      normalizedSlope: 4.5,
      normalizedAcceleration: 1,
    },
    medium: {
      ...base.medium,
      normalizedSlope: 3.1,
      regression: { ...base.medium.regression, r2: 0.8 },
    },
    slow: {
      ...base.slow,
      normalizedSlope: 0.45,
      regression: { ...base.slow.regression, r2: 0.8 },
    },
    openingRange: {
      ...openingRangeWithoutBullishBreakout,
      high: base.price + 1,
      nearHigh: false,
      bullishRetest: false,
    },
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
  await waitFor(() => optionStream.subscribed.size === 0);
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

test("OPRA quote silence fails readiness and reconnects the option stream", async () => {
  let decisionTime = now;
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
    now: () => decisionTime,
    executionTickMs: 10,
    recorder,
  });
  await runtime.start();
  assert.equal(runtime.healthState().lastOptionQuoteAgeMs, 0);

  decisionTime += OPTION_QUOTE_STALL_TIMEOUT_MS + 1;
  client.clock.timestamp = decisionTime;
  await waitFor(() => recorder.events.some((event) => event.type === "option_stream_stalled"));
  const stalled = runtime.healthState();
  assert.equal(stalled.ready, false);
  assert.equal(stalled.optionQuoteStalled, true);
  assert.equal(stalled.optionWebsocketConnected, false);
  assert.equal(stalled.lastOptionQuoteAgeMs, OPTION_QUOTE_STALL_TIMEOUT_MS + 1);
  assert.equal(stalled.optionQuoteStallThresholdMs, OPTION_QUOTE_STALL_TIMEOUT_MS);
  assert.equal(stalled.reconnectAttempt, 1);
  assert.match(stalled.lastStreamError ?? "", /OPRA option quote stream stalled/);
  await runtime.ingestFeature({ ...bullishFeature(), timestamp: decisionTime });
  const blockedEvaluation = recorder.events
    .filter((event) => event.type === "live_entry_evaluation")
    .at(-1);
  assert.deepEqual(blockedEvaluation?.data.reasons, ["OPTION_FEED_STALLED"]);

  await waitFor(() => optionStream.connectCalls === 2, 2_000);
  assert.equal(runtime.healthState().optionQuoteStalled, false);
  assert.equal(runtime.healthState().optionWebsocketConnected, true);
  assert.equal(runtime.healthState().optionQuotePrimed, false);
  assert.equal(runtime.healthState().ready, false);
  await runtime.ingestFeature({ ...bullishFeature(), timestamp: decisionTime });
  const warmingEvaluation = recorder.events
    .filter((event) => event.type === "live_entry_evaluation")
    .at(-1);
  assert.deepEqual(warmingEvaluation?.data.reasons, ["OPTION_FEED_NOT_READY"]);
  await optionStream.quote({
    symbol: callSymbol,
    timestamp: decisionTime,
    bidPrice: 1.995,
    askPrice: 2.005,
    bidSize: 100,
    askSize: 100,
  });
  assert.equal(runtime.healthState().receivedOptionQuotes, 1);
  assert.equal(runtime.healthState().lastOptionQuoteAgeMs, 0);
  assert.equal(runtime.healthState().lastOptionQuoteProviderAgeMs, 0);
  assert.equal(runtime.healthState().optionQuotePrimed, true);
  assert.equal(runtime.healthState().ready, true);
  await runtime.close();
});

test("OPRA provider lag degrades readiness and blocks entries before receive silence", async () => {
  let decisionTime = now;
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
    now: () => decisionTime,
    executionTickMs: 10,
    recorder,
  });
  await runtime.start();
  await optionStream.quote({
    symbol: callSymbol,
    timestamp: decisionTime,
    bidPrice: 1.995,
    askPrice: 2.005,
    bidSize: 100,
    askSize: 100,
  });

  client.latestOptionQuotes = [{
    symbol: callSymbol,
    timestamp: decisionTime,
    bidPrice: 1.995,
    askPrice: 2.005,
    bidSize: 100,
    askSize: 100,
  }];
  decisionTime += defaultConfig.dataQuality.maxOptionQuoteAgeMs + 1;
  client.clock.timestamp = decisionTime;
  const lagged = runtime.healthState();
  assert.equal(lagged.ready, false);
  assert.equal(lagged.optionQuoteProviderLagged, true);
  assert.equal(lagged.optionQuoteStalled, false);
  assert.equal(lagged.optionWebsocketConnected, true);
  assert.equal(lagged.lastOptionQuoteAgeMs, defaultConfig.dataQuality.maxOptionQuoteAgeMs + 1);
  assert.equal(lagged.lastOptionQuoteProviderAgeMs, defaultConfig.dataQuality.maxOptionQuoteAgeMs + 1);
  assert.equal(lagged.optionQuoteFreshnessThresholdMs, defaultConfig.dataQuality.maxOptionQuoteAgeMs);

  await runtime.ingestFeature({ ...bullishFeature(), timestamp: decisionTime });
  const blockedEvaluation = recorder.events
    .filter((event) => event.type === "live_entry_evaluation")
    .at(-1);
  assert.deepEqual(blockedEvaluation?.data.reasons, ["OPTION_FEED_PROVIDER_LAGGED"]);
  await waitFor(() => client.latestOptionQuoteCalls > 0);
  const staleRestResult = recorder.events
    .filter((event) => event.type === "option_rest_fallback_result")
    .at(-1);
  assert.equal(staleRestResult?.data.freshQuotes, 0);
  assert.equal(staleRestResult?.data.reconnectScheduled, false);
  assert.equal(runtime.healthState().optionRestFallbackFreshQuotes, 0);
  assert.equal(runtime.healthState().optionQuoteProviderLagged, true);

  decisionTime = now + OPTION_QUOTE_STALL_TIMEOUT_MS + 1;
  client.clock.timestamp = decisionTime;
  await optionStream.quote({
    symbol: callSymbol,
    timestamp: now,
    bidPrice: 1.995,
    askPrice: 2.005,
    bidSize: 100,
    askSize: 100,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(runtime.healthState().optionQuoteProviderLagged, true);
  assert.equal(runtime.healthState().optionQuoteStalled, false);
  assert.equal(runtime.healthState().optionWebsocketConnected, true);
  assert.equal(optionStream.connectCalls, 1);
  await runtime.close();
});

test("fresh explicit OPRA REST quotes recover stale WebSocket pricing and trigger a bounded reconnect", async () => {
  let decisionTime = now;
  const client = new FakeRuntimeClient();
  const optionStream = new FakeOptionStream();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config: immediateRuntimeConfig,
    client,
    stockStream: new FakeStockStream(),
    optionStream,
    executionEnabled: true,
    executionMode: "paper",
    now: () => decisionTime,
    executionTickMs: 10,
    recorder,
  });
  await runtime.start();
  await optionStream.quote({
    symbol: callSymbol,
    timestamp: decisionTime,
    bidPrice: 1.80,
    askPrice: 1.82,
    bidSize: 100,
    askSize: 100,
  });

  decisionTime += immediateRuntimeConfig.dataQuality.maxOptionQuoteAgeMs + 1;
  client.clock.timestamp = decisionTime;
  client.latestOptionQuotes = [{
    symbol: callSymbol,
    timestamp: decisionTime,
    bidPrice: 1.995,
    askPrice: 2.005,
    bidSize: 100,
    askSize: 100,
  }];
  await waitFor(() => (runtime.healthState().optionRestFallbackFreshQuotes ?? 0) > 0);

  const recovered = runtime.healthState();
  assert.equal(recovered.optionQuoteProviderLagged, false);
  assert.equal(recovered.ready, true);
  assert.equal(recovered.lastOptionRestQuoteProviderAgeMs, 0);
  assert.equal(recovered.optionRestFallbackRequests, 1);
  const restResult = recorder.events
    .filter((event) => event.type === "option_rest_fallback_result")
    .at(-1);
  assert.equal(restResult?.data.requestedContracts, 1);
  assert.equal(restResult?.data.freshQuotes, 1);
  assert.equal(restResult?.data.reconnectScheduled, true);
  assert.equal(runtime.healthState().reconnectAttempt, 1);

  await runtime.ingestFeature({ ...bullishFeature(), timestamp: decisionTime });
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0]?.symbol, callSymbol);
  const selection = recorder.events.filter((event) => event.type === "live_signal_selection").at(-1);
  assert.deepEqual(selection?.data.candidateQuote, {
    timestamp: decisionTime,
    bidPrice: 1.995,
    askPrice: 2.005,
  });
  await runtime.close();
});

test("entry evaluation fails closed when the live stock feed is disconnected", async () => {
  const client = new FakeRuntimeClient();
  const stockStream = new FakeStockStream();
  const optionStream = new FakeOptionStream();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config: immediateRuntimeConfig,
    client,
    stockStream,
    optionStream,
    executionEnabled: true,
    executionMode: "paper",
    now: () => now,
    executionTickMs: 60_000,
    recorder,
  });
  await runtime.start();
  await optionStream.quote({
    symbol: callSymbol,
    timestamp: now,
    bidPrice: 1.995,
    askPrice: 2.005,
    bidSize: 100,
    askSize: 100,
  });
  stockStream.handlers?.onState?.(false);
  assert.equal(runtime.healthState().ready, false);

  await runtime.ingestFeature(bullishFeature());

  const evaluation = recorder.events.find((event) => event.type === "live_entry_evaluation");
  assert.equal(evaluation?.data.decision, "SKIPPED");
  assert.deepEqual(evaluation?.data.reasons, ["STOCK_FEED_DISCONNECTED"]);
  assert.equal(client.requests.length, 0);
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
  assert.equal(runtime.healthState().optionQuotePrimed, false);
  assert.equal(runtime.healthState().ready, false);
  assert.equal(runtime.healthState().accountOptionsApproved, true);
  assert.deepEqual([...optionStream.subscribed], [callSymbol]);

  await optionStream.quote({
    symbol: callSymbol, timestamp: now, bidPrice: 1.995, askPrice: 2.005, bidSize: 100, askSize: 100,
  });
  assert.equal(runtime.healthState().optionQuotePrimed, true);
  assert.equal(runtime.healthState().ready, true);
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
  assert.deepEqual(selection?.data.candidateQuote, { timestamp: now, bidPrice: 1.995, askPrice: 2.005 });
  assert.equal((evaluation?.data.morningEntryGuard as Record<string, unknown>).active, true);
  assert.equal((evaluation?.data.morningEntryGuard as Record<string, unknown>).followThrough, "DISABLED");
  assert.equal(
    (evaluation?.data.morningEntryGuard as Record<string, unknown>).bullishGrindRequiresUpRegime,
    true,
  );
  assert.equal((evaluation?.data.morningEntryBaseline as Record<string, unknown>).decision, "SIGNAL");
  assert.equal(typeof (selection?.data.candidateMetrics as Record<string, unknown> | undefined)?.spreadPct, "number");
  const orderRequest = recorder.events.find((event) => event.type === "broker_order_request");
  assert.equal(orderRequest?.data.signalId, selection?.data.signalId);
  const riskRecovery = recorder.events.find((event) => event.type === "daily_risk_state_recovery");
  assert.equal(riskRecovery?.data.restoredEntries, 0);
  assert.equal(riskRecovery?.data.activeMaxTradesPerDay, defaultConfig.risk.maxTradesPerDay);
  assert.equal(
    riskRecovery?.data.entryConfirmationMode,
    immediateRuntimeConfig.signals.entryConfirmationMode,
  );
  const configSnapshot = recorder.events.find((event) => event.type === "runtime_config_snapshot");
  assert.deepEqual(configSnapshot?.data.config, immediateRuntimeConfig);
  assert.equal(configSnapshot?.data.executionTickMs, 60_000);
  await runtime.close();
  assert.deepEqual(history.priorityChanges.at(-1), []);
});

test("transient option spread rejection retries from OPRA and submits only after signal revalidation", async () => {
  let decisionTime = now;
  const config = structuredClone(immediateRuntimeConfig);
  config.execution.optionSelectionRetryMs = 1_000;
  const client = new FakeRuntimeClient();
  client.clock.timestamp = decisionTime;
  const optionStream = new FakeOptionStream();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config,
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
    symbol: callSymbol, timestamp: decisionTime,
    bidPrice: 1.99, askPrice: 2.01, bidSize: 100, askSize: 100,
  });
  await runtime.ingestFeature({ ...bullishFeature(), timestamp: decisionTime });

  const armed = recorder.events.find((event) => event.type === "live_signal_selection");
  assert.equal(armed?.data.selectionStatus, "RETRYING");
  assert.equal(armed?.data.candidate, null);
  assert.equal((armed?.data.closestCandidate as Record<string, unknown>).symbol, callSymbol);
  assert.deepEqual(armed?.data.selectionReasons, ["MORNING_ENTRY_OPTION_SPREAD_TOO_WIDE"]);
  assert.equal(client.requests.length, 0);

  decisionTime += 100;
  client.clock.timestamp = decisionTime;
  await optionStream.quote({
    symbol: callSymbol, timestamp: decisionTime,
    bidPrice: 1.995, askPrice: 2.005, bidSize: 100, askSize: 100,
  });

  assert.equal(client.requests.length, 1);
  const selections = recorder.events.filter((event) => event.type === "live_signal_selection");
  assert.equal(selections.length, 2);
  assert.equal(selections[1]?.data.signalId, selections[0]?.data.signalId);
  assert.equal(selections[1]?.data.selectionStatus, "SELECTED");
  assert.equal(selections[1]?.data.retryOutcome, "SELECTED_AFTER_RETRY");
  assert.equal(selections[1]?.data.retryWaitMs, 100);
  assert.equal(selections[1]?.data.candidate, callSymbol);
  await runtime.close();
});

test("option selection does not retry a structural midpoint rejection", async () => {
  const config = structuredClone(immediateRuntimeConfig);
  config.execution.optionSelectionRetryMs = 1_000;
  const client = new FakeRuntimeClient();
  const optionStream = new FakeOptionStream();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config,
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
    symbol: callSymbol, timestamp: now,
    bidPrice: 13, askPrice: 13.01, bidSize: 100, askSize: 100,
  });
  await runtime.ingestFeature(bullishFeature());

  const selection = recorder.events.find((event) => event.type === "live_signal_selection");
  assert.equal(selection?.data.selectionStatus, "NO_ELIGIBLE_OPTION");
  assert.equal(selection?.data.retryOutcome, "STRUCTURAL_REJECTION");
  assert.ok((selection?.data.selectionReasons as string[]).includes("MIDPOINT_OUTSIDE_RANGE"));
  assert.equal(client.requests.length, 0);
  await runtime.close();
});

test("option selection retry expires before a later tight quote can submit", async () => {
  let decisionTime = now;
  const config = structuredClone(immediateRuntimeConfig);
  config.execution.optionSelectionRetryMs = 1_000;
  const client = new FakeRuntimeClient();
  client.clock.timestamp = decisionTime;
  const optionStream = new FakeOptionStream();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config,
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
    symbol: callSymbol, timestamp: decisionTime,
    bidPrice: 1.99, askPrice: 2.01, bidSize: 100, askSize: 100,
  });
  await runtime.ingestFeature({ ...bullishFeature(), timestamp: decisionTime });

  decisionTime += 1_000;
  client.clock.timestamp = decisionTime;
  await optionStream.quote({
    symbol: callSymbol, timestamp: decisionTime,
    bidPrice: 1.995, askPrice: 2.005, bidSize: 100, askSize: 100,
  });

  assert.equal(client.requests.length, 0);
  const finalSelection = recorder.events.filter((event) =>
    event.type === "live_signal_selection").at(-1);
  assert.equal(finalSelection?.data.selectionStatus, "NO_ELIGIBLE_OPTION");
  assert.equal(finalSelection?.data.retryOutcome, "EXPIRED");
  await runtime.close();
});

test("option selection retry cancels when the original signal structure invalidates", async () => {
  let decisionTime = now;
  const config = structuredClone(immediateRuntimeConfig);
  config.execution.optionSelectionRetryMs = 1_000;
  const client = new FakeRuntimeClient();
  client.clock.timestamp = decisionTime;
  const optionStream = new FakeOptionStream();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config,
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
    symbol: callSymbol, timestamp: decisionTime,
    bidPrice: 1.99, askPrice: 2.01, bidSize: 100, askSize: 100,
  });
  await runtime.ingestFeature({ ...bullishFeature(), timestamp: decisionTime });

  decisionTime += 500;
  client.clock.timestamp = decisionTime;
  const invalidated = bullishFeature();
  invalidated.timestamp = decisionTime;
  invalidated.medium = { ...invalidated.medium, normalizedSlope: -0.6 };
  await runtime.ingestFeature(invalidated);

  assert.equal(client.requests.length, 0);
  const finalSelection = recorder.events.filter((event) =>
    event.type === "live_signal_selection").at(-1);
  assert.equal(finalSelection?.data.selectionStatus, "NO_ELIGIBLE_OPTION");
  assert.equal(finalSelection?.data.retryOutcome, "SIGNAL_INVALIDATED");
  assert.ok((finalSelection?.data.selectionReasons as string[]).includes("MEDIUM_SLOPE_MISALIGNED"));
  await runtime.close();
});

test("slow option-universe refresh does not block causal SIP feature evaluation", async () => {
  let decisionTime = now;
  const client = new FakeRuntimeClient();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config: defaultConfig,
    client,
    stockStream: new FakeStockStream(),
    optionStream: new FakeOptionStream(),
    executionEnabled: true,
    executionMode: "paper",
    now: () => decisionTime,
    executionTickMs: 60_000,
    recorder,
  });
  await runtime.start();

  let releaseRefresh!: () => void;
  client.contractListGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  decisionTime += defaultConfig.options.chainRefreshSec * 1_000 + 1;
  const evaluation = runtime.ingestFeature({ ...bullishFeature(), timestamp: decisionTime });
  await Promise.race([
    evaluation,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Feature evaluation waited for option-universe REST I/O")), 250)),
  ]);

  assert.equal(client.listContractCalls, 2);
  assert.ok(recorder.events.some((event) =>
    event.type === "live_entry_evaluation" && event.timestamp === decisionTime));
  releaseRefresh();
  await waitFor(() => client.contractListGate !== undefined && runtime.healthState().subscribedOptionContracts > 0);
  await runtime.close();
});

test("OPRA quote bursts update the option book through one causal batch without dropping history", async () => {
  const client = new FakeRuntimeClient();
  const optionStream = new FakeOptionStream();
  const history = new FakeHistory();
  const runtime = new SpyOptionsTradingRuntime({
    config: defaultConfig,
    client,
    stockStream: new FakeStockStream(),
    optionStream,
    executionEnabled: true,
    executionMode: "paper",
    now: () => now,
    executionTickMs: 60_000,
    history,
    recorder: new MemoryRecorder(),
  });
  await runtime.start();
  const before = runtime.healthState().receivedOptionQuotes ?? 0;
  const beforeRejected = runtime.healthState().rejectedMarketEvents ?? 0;
  await optionStream.quotes([
    { symbol: callSymbol, timestamp: now - 2, bidPrice: 1.99, askPrice: 2.01, bidSize: 10, askSize: 12 },
    { symbol: callSymbol, timestamp: now - 1, bidPrice: 2, askPrice: 2, bidSize: 10, askSize: 10 },
    { symbol: callSymbol, timestamp: now - 1, bidPrice: 2, askPrice: 2.02, bidSize: 11, askSize: 13 },
    { symbol: callSymbol, timestamp: now, bidPrice: 2.01, askPrice: 2.03, bidSize: 12, askSize: 14 },
  ]);

  assert.equal(runtime.healthState().receivedOptionQuotes, before + 4);
  assert.equal(runtime.healthState().rejectedMarketEvents, beforeRejected + 1);
  assert.equal(history.events.filter((event) => event.type === "option_quote").length, 4);
  await runtime.close();
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

test("restart restoration preserves the latest profitable protective exit for guarded re-entry", () => {
  const events: AuditEvent[] = [
    {
      timestamp: now - 30_000, marketDate: date, type: "entry_fill", configVersion: "before",
      data: {
        signalId: "bearish-entry",
        position: { symbol: callSymbol, direction: "BEARISH", entryTimestamp: now - 30_000 },
      },
    },
    {
      timestamp: now - 12_000, marketDate: date, type: "exit_fill", configVersion: "before",
      data: {
        direction: "BEARISH",
        reason: "OPPOSITE_REGIME",
        realizedPnl: 4,
      },
    },
  ];
  const restored = restoreRuntimeState(events, now, defaultConfig.timeZone);
  assert.equal(restored.signal.lastProtectedExits?.BEARISH, now - 12_000);
});

test("restart preserves the high daily safety limit after six unique fills", async () => {
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
  assert.equal(recovery?.data.maxTradesPerDay, defaultConfig.risk.maxTradesPerDay);
  await runtime.close();
});

test("active confirmation keeps a weak immediate candidate out of the paper account", async () => {
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
    symbol: callSymbol, timestamp: now, bidPrice: 1.995, askPrice: 2.005, bidSize: 100, askSize: 100,
  });
  await runtime.ingestFeature(bullishFeature());
  assert.equal(client.requests.length, 0);
  const evaluation = recorder.events.find((event) => event.type === "live_entry_evaluation");
  assert.equal(evaluation?.data.decision, "NO_SIGNAL");
  assert.deepEqual(evaluation?.data.reasons, ["FOLLOW_THROUGH_PENDING"]);
  const shadow = evaluation?.data.shadowEvaluation as Record<string, unknown>;
  assert.equal(shadow.decision, "NO_SIGNAL");
  assert.deepEqual(shadow.reasons, ["FOLLOW_THROUGH_PENDING"]);
  await runtime.close();
});

test("late-session runtime audits and blocks an option whose spread exceeds the tighter limit", async () => {
  const decisionTime = zonedDateTimeToEpoch(date, "12:10:00");
  const config = structuredClone(defaultConfig);
  config.signals.lateEntryGuard.followThroughMinSec = 0;
  config.signals.lateEntryGuard.followThroughMaxSec = 0;
  const client = new FakeRuntimeClient();
  client.clock.timestamp = decisionTime;
  const optionStream = new FakeOptionStream();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config,
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
    symbol: callSymbol,
    timestamp: decisionTime,
    bidPrice: 1.99,
    askPrice: 2.01,
    bidSize: 100,
    askSize: 100,
  });
  await runtime.ingestFeature({ ...bullishFeature(), timestamp: decisionTime });

  const evaluation = recorder.events.find((event) => event.type === "live_entry_evaluation");
  assert.equal(evaluation?.data.decision, "SIGNAL");
  const lateEntryGuard = evaluation?.data.lateEntryGuard as Record<string, unknown>;
  assert.equal(lateEntryGuard.active, true);
  assert.equal(lateEntryGuard.bearishGrindRequiresFollowThrough, true);
  assert.equal(lateEntryGuard.bearishUnclassifiedImpulseMinMediumToFastRatio, 0.4);
  assert.equal(lateEntryGuard.bullishGrindMinMediumNormalizedSlope, 2.5);
  assert.equal(lateEntryGuard.bullishNoisyGrindMinMediumToFastRatio, 1.25);
  assert.equal(lateEntryGuard.bearishUnclassifiedImpulseFollowThroughStart, "13:00:00");
  assert.equal((evaluation?.data.lateEntryBaseline as Record<string, unknown>).decision, "SIGNAL");
  const selection = recorder.events.find((event) => event.type === "live_signal_selection");
  assert.equal(selection?.data.candidate, null);
  assert.ok(
    ((selection?.data.rejectionCounts as Record<string, number>)["LATE_ENTRY_OPTION_SPREAD_TOO_WIDE"] ?? 0) > 0,
  );
  assert.equal(client.requests.length, 0);
  await runtime.close();
});

test("late-session audit preserves an unguarded baseline while active follow-through is pending", async () => {
  const decisionTime = zonedDateTimeToEpoch(date, "12:10:00");
  const client = new FakeRuntimeClient();
  client.clock.timestamp = decisionTime;
  const optionStream = new FakeOptionStream();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config: defaultConfig,
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
    symbol: callSymbol,
    timestamp: decisionTime,
    bidPrice: 1.995,
    askPrice: 2.005,
    bidSize: 100,
    askSize: 100,
  });
  await runtime.ingestFeature({ ...bullishFeature(), timestamp: decisionTime });

  const evaluation = recorder.events.find((event) => event.type === "live_entry_evaluation");
  assert.equal(evaluation?.data.decision, "NO_SIGNAL");
  assert.deepEqual(evaluation?.data.reasons, ["LATE_ENTRY_FOLLOW_THROUGH_PENDING"]);
  const baseline = evaluation?.data.lateEntryBaseline as Record<string, unknown>;
  assert.equal(baseline.decision, "SIGNAL");
  assert.equal(baseline.direction, "BULLISH");
  assert.equal(client.requests.length, 0);
  await runtime.close();
});

test("late low-noise bullish grind waits for option response and records each monitored time", async () => {
  let decisionTime = zonedDateTimeToEpoch(date, "12:12:46");
  const client = new FakeRuntimeClient();
  client.clock.timestamp = decisionTime;
  const optionStream = new FakeOptionStream();
  const recorder = new MemoryRecorder();
  const runtime = new SpyOptionsTradingRuntime({
    config: defaultConfig,
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
    symbol: callSymbol, timestamp: decisionTime,
    bidPrice: 1.9, askPrice: 1.91, bidSize: 100, askSize: 100,
  });
  await runtime.ingestFeature(lateLowNoiseBullishGrindFeature(decisionTime));
  assert.equal(client.requests.length, 0);
  assert.equal(
    recorder.events.find((event) =>
      event.type === "late_bullish_grind_confirmation")?.data.decision,
    "ARMED",
  );

  decisionTime += 1_000;
  client.clock.timestamp = decisionTime;
  await optionStream.quote({
    symbol: callSymbol, timestamp: decisionTime,
    bidPrice: 1.91, askPrice: 1.92, bidSize: 100, askSize: 100,
  });
  await runtime.ingestFeature(lateLowNoiseBullishGrindFeature(decisionTime));
  assert.equal(client.requests.length, 0);

  decisionTime += 2_000;
  client.clock.timestamp = decisionTime;
  await optionStream.quote({
    symbol: callSymbol, timestamp: decisionTime,
    bidPrice: 1.93, askPrice: 1.94, bidSize: 100, askSize: 100,
  });
  await runtime.ingestFeature(lateLowNoiseBullishGrindFeature(decisionTime));
  assert.equal(client.requests.length, 1);
  const confirmationEvents = recorder.events.filter(
    (event) => event.type === "late_bullish_grind_confirmation",
  );
  assert.deepEqual(
    confirmationEvents.map((event) => event.data.decision),
    ["ARMED", "PENDING", "CONFIRMED"],
  );
  assert.deepEqual(
    confirmationEvents.map((event) => event.timestamp),
    [decisionTime - 3_000, decisionTime - 2_000, decisionTime],
  );
  assert.equal((confirmationEvents.at(-1)?.data.bidImprovement as number) >= 0.03, true);
  await runtime.close();
});

test("post-14:30 baseline candidates are labeled research-only before option selection", async () => {
  const afterCutoff = zonedDateTimeToEpoch(date, "14:30:01");
  const client = new FakeRuntimeClient();
  client.clock.timestamp = afterCutoff;
  const recorder = new MemoryRecorder();
  const config = structuredClone(defaultConfig);
  config.signals.lateEntryGuard.mode = "DISABLED";
  config.signals.entryConfirmationMode = "SHADOW";
  const runtime = new SpyOptionsTradingRuntime({
    config,
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
    symbol: callSymbol, timestamp: decisionTime, bidPrice: 1.995, askPrice: 2.005, bidSize: 100, askSize: 100,
  });
  await runtime.ingestFeature(bullishFeature());
  assert.equal(client.requests.length, 0);
  assert.equal(recorder.events.find((event) => event.type === "live_entry_evaluation")?.data.decision, "NO_SIGNAL");

  decisionTime += defaultConfig.signals.followThroughMinSec * 1000;
  client.clock.timestamp = decisionTime;
  await optionStream.quote({
    symbol: callSymbol, timestamp: decisionTime, bidPrice: 1.995, askPrice: 2.005, bidSize: 100, askSize: 100,
  });
  await runtime.ingestFeature({
    ...bullishFeature(), timestamp: decisionTime, price: 501.14, mid: 501.14,
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
    config: immediateRuntimeConfig,
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
  assert.equal(runtime.healthState().strategyOpeningRangeEnd, defaultConfig.session.openingRangeEnd);
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
