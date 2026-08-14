import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, googlConfig, qqqConfig } from "../src/config.js";
import type {
  AccountState, FeatureSnapshot, OptionContract, OptionQuote, OptionSnapshot, StockQuote, StockTrade,
  TradeSignal, UnderlyingSymbol, WindowMetrics,
} from "../src/types.js";
import type {
  BrokerOrder, BrokerOrderRequest, BrokerPosition, MultiUnderlyingTradingRestClient,
  TradingRestClient,
} from "../src/alpaca/restClient.js";
import { UnderlyingTradingRestClient } from "../src/alpaca/restClient.js";
import type { StockStream, StockStreamHandlers } from "../src/alpaca/stockStream.js";
import type { OptionStream, OptionStreamHandlers } from "../src/alpaca/optionStream.js";
import { SharedOptionStreamHub, SharedStockStreamHub } from "../src/runtime/sharedStreams.js";
import { PortfolioRiskCoordinator } from "../src/risk/portfolioRiskCoordinator.js";
import { FeatureEngine } from "../src/features/featureEngine.js";
import { sameDayOptionContractReasons } from "../src/options/tradingInvariants.js";
import { restoreRuntimeState } from "../src/runtime/spyOptionsTradingRuntime.js";
import { ReplayEngine } from "../src/backtest/replay.js";
import type { AuditEvent } from "../src/ops/recorder.js";
import { zonedDateTimeToEpoch } from "../src/utils/time.js";
import { LiveOrderManager } from "../src/execution/liveOrderManager.js";
import { TradingDashboardStore } from "../src/ops/tradingDashboard.js";

const date = "2026-07-22";
const timestamp = zonedDateTimeToEpoch(date, "10:20:00");
const spyOption = "SPY260722C00500000";
const qqqOption = "QQQ260722C00600000";
const googlOption = "GOOGL260722C00190000";

test("QQQ has an independent configuration and rejects SPY contracts without mutating SPY", () => {
  assert.equal(defaultConfig.symbol, "SPY");
  assert.equal(qqqConfig.symbol, "QQQ");
  assert.notEqual(qqqConfig.version, defaultConfig.version);
  assert.equal(defaultConfig.risk.maxContracts, 3);
  assert.equal(qqqConfig.risk.maxContracts, 3);
  assert.equal(qqqConfig.risk.onePositionAtATime, true);
  const qqq: OptionContract = {
    symbol: qqqOption, underlying: "QQQ", expirationDate: date, strike: 600,
    type: "call", active: true, tradable: true,
  };
  const spy: OptionContract = {
    symbol: spyOption, underlying: "SPY", expirationDate: date, strike: 500,
    type: "call", active: true, tradable: true,
  };
  assert.deepEqual(sameDayOptionContractReasons(qqq, timestamp, qqqConfig.timeZone, "QQQ"), []);
  assert.deepEqual(sameDayOptionContractReasons(spy, timestamp, qqqConfig.timeZone, "QQQ"), ["WRONG_UNDERLYING"]);
  assert.deepEqual(sameDayOptionContractReasons(spy, timestamp, defaultConfig.timeZone, "SPY"), []);
});

test("GOOGL has an isolated options-only paper configuration", () => {
  assert.equal(googlConfig.symbol, "GOOGL");
  assert.notEqual(googlConfig.version, defaultConfig.version);
  assert.equal(googlConfig.options.expirationDaysMin, 0);
  assert.equal(googlConfig.options.expirationDaysMax, 0);
  assert.equal(googlConfig.risk.maxContracts, 1);
  assert.equal(googlConfig.risk.maxPositionsPerUnderlying, 3);
  const contract: OptionContract = {
    symbol: googlOption, underlying: "GOOGL", expirationDate: date, strike: 190,
    type: "call", active: true, tradable: true,
  };
  assert.deepEqual(sameDayOptionContractReasons(
    contract, timestamp, googlConfig.timeZone, "GOOGL",
  ), []);
});

test("feature engines stamp their own underlying and restoration state remains isolated", () => {
  const qqqFeatures = new FeatureEngine(qqqConfig);
  const feature = qqqFeatures.onBar({
    timestamp, microprice: 600, mid: 600, bidPrice: 599.99, askPrice: 600.01,
    bidSize: 100, askSize: 100, quoteCount: 1, quoteAgeMs: 0, ofiRaw: 0,
    depthSum: 200, depthEventCount: 1, tradeVolume: 100,
  });
  assert.equal(feature?.symbol, "QQQ");

  const events: AuditEvent[] = [
    audit("entry_fill", "SPY", { position: { symbol: spyOption, direction: "BULLISH", entryTimestamp: timestamp } }),
    audit("exit_fill", "SPY", { realizedPnl: 5, direction: "BULLISH", reason: "TRAILING_PROFIT" }),
    audit("entry_fill", "QQQ", { position: { symbol: qqqOption, direction: "BULLISH", entryTimestamp: timestamp + 1 } }),
    audit("exit_fill", "QQQ", { realizedPnl: -3, direction: "BULLISH", reason: "HARD_STOP" }),
  ];
  assert.deepEqual(restoreRuntimeState(events, timestamp, defaultConfig.timeZone, "SPY").risk, {
    marketDate: date, entries: 1, realizedPnl: 5,
  });
  assert.deepEqual(restoreRuntimeState(events, timestamp, defaultConfig.timeZone, "QQQ").risk, {
    marketDate: date, entries: 1, realizedPnl: -3,
  });
});

test("shared SIP and OPRA hubs route events and union subscriptions without cross-symbol leakage", async () => {
  const stock = new FakeStockStream();
  const stockHub = new SharedStockStreamHub(stock, ["SPY", "QQQ"]);
  const spyStocks: string[] = [];
  const qqqStocks: string[] = [];
  const spyChannel = stockHub.channel("SPY");
  const qqqChannel = stockHub.channel("QQQ");
  await Promise.all([
    spyChannel.connect(stockCollector(spyStocks)),
    qqqChannel.connect(stockCollector(qqqStocks)),
  ]);
  await stock.emit([
    { type: "quote", value: stockQuote("SPY", 500) },
    { type: "trade", value: stockTrade("QQQ", 600) },
  ]);
  assert.deepEqual(spyStocks, ["SPY"]);
  assert.deepEqual(qqqStocks, ["QQQ"]);
  assert.equal(stock.connectCalls, 1);
  await spyChannel.close();
  assert.equal(stock.closeCalls, 0);

  const option = new FakeOptionStream();
  const optionHub = new SharedOptionStreamHub(option, ["SPY", "QQQ"]);
  const spyOptions: string[] = [];
  const qqqOptions: string[] = [];
  const spyObservations: string[] = [];
  const qqqObservations: string[] = [];
  let spyActivities = 0;
  let qqqActivities = 0;
  const spyOptionChannel = optionHub.channel("SPY");
  const qqqOptionChannel = optionHub.channel("QQQ");
  await spyOptionChannel.subscribe([spyOption]);
  await qqqOptionChannel.subscribe([qqqOption]);
  await Promise.all([
    spyOptionChannel.connect({
      ...optionCollector(spyOptions),
      onQuoteObservations: (observations) => spyObservations.push(...observations.map(({ quote }) => quote.symbol)),
      onActivity: () => { spyActivities += 1; },
    }),
    qqqOptionChannel.connect({
      ...optionCollector(qqqOptions),
      onQuoteObservations: (observations) => qqqObservations.push(...observations.map(({ quote }) => quote.symbol)),
      onActivity: () => { qqqActivities += 1; },
    }),
  ]);
  assert.deepEqual([...option.subscribed].sort(), [qqqOption, spyOption]);
  assert.equal(option.connectCalls, 1);
  await option.emit([optionQuote(spyOption), optionQuote(qqqOption)]);
  assert.deepEqual(spyOptions, [spyOption]);
  assert.deepEqual(qqqOptions, [qqqOption]);
  assert.deepEqual(spyObservations, [spyOption]);
  assert.deepEqual(qqqObservations, [qqqOption]);
  assert.equal(spyActivities, 1);
  assert.equal(qqqActivities, 1);
  await spyOptionChannel.close();
  assert.deepEqual([...option.subscribed], [qqqOption]);
  assert.equal(option.closeCalls, 0);
  await Promise.all([qqqChannel.close(), qqqOptionChannel.close()]);
  assert.equal(stock.closeCalls, 1);
  assert.equal(option.closeCalls, 1);
});

test("a QQQ stream-consumer failure does not interrupt SPY delivery", async () => {
  const stock = new FakeStockStream();
  const stockHub = new SharedStockStreamHub(stock, ["SPY", "QQQ"]);
  const spyStocks: string[] = [];
  const qqqErrors: string[] = [];
  await Promise.all([
    stockHub.channel("SPY").connect(stockCollector(spyStocks)),
    stockHub.channel("QQQ").connect({
      onQuote: () => { throw new Error("QQQ consumer failed"); },
      onTrade: () => { throw new Error("QQQ consumer failed"); },
      onError: (error) => { qqqErrors.push(error instanceof Error ? error.message : String(error)); },
    }),
  ]);
  await stock.emit([
    { type: "quote", value: stockQuote("QQQ", 600) },
    { type: "quote", value: stockQuote("SPY", 500) },
  ]);
  assert.deepEqual(spyStocks, ["SPY"]);
  assert.deepEqual(qqqErrors, ["QQQ consumer failed"]);
});

test("broker views are scoped by underlying while account state remains shared", async () => {
  const base = new FakeMultiBroker();
  const spy = new UnderlyingTradingRestClient(base, "SPY");
  const qqq = new UnderlyingTradingRestClient(base, "QQQ");
  assert.deepEqual((await spy.listPositions()).map((position) => position.symbol), [spyOption]);
  assert.deepEqual((await qqq.listPositions()).map((position) => position.symbol), [qqqOption]);
  assert.deepEqual((await spy.listOpenOrders()).map((order) => order.symbol), [spyOption]);
  assert.deepEqual((await qqq.listOpenOrders()).map((order) => order.symbol), [qqqOption]);
  assert.equal((await spy.getAccount()).equity, (await qqq.getAccount()).equity);
  await assert.rejects(() => spy.submitOrder(orderRequest(qqqOption)), /cross-underlying/);
  assert.equal((await qqq.listOptionContracts())[0]?.underlying, "QQQ");
});

test("portfolio coordinator atomically permits one SPY and one QQQ risk reservation", async () => {
  const coordinator = new PortfolioRiskCoordinator({
    timeZone: defaultConfig.timeZone,
    maxConcurrentUnderlyings: 2,
    maxAggregateRiskDollars: 1_000,
    maxAggregatePremiumDollars: 3_000,
    maxDailyLossDollars: 1_000,
  }, timestamp);
  const [spy, qqq] = await Promise.all([
    coordinator.reserveEntry({
      underlying: "SPY", timestamp, riskDollars: 500, premiumDollars: 1_500,
      optionBuyingPowerDollars: 25_000,
    }),
    coordinator.reserveEntry({
      underlying: "QQQ", timestamp, riskDollars: 500, premiumDollars: 1_500,
      optionBuyingPowerDollars: 25_000,
    }),
  ]);
  assert.equal(spy.allowed, true);
  assert.equal(qqq.allowed, true);
  assert.deepEqual((await coordinator.snapshot(timestamp)).activeUnderlyings.sort(), ["QQQ", "SPY"]);
  const duplicate = await coordinator.reserveEntry({
    underlying: "QQQ", timestamp, riskDollars: 1, premiumDollars: 1, optionBuyingPowerDollars: 25_000,
  });
  assert.equal(duplicate.allowed, false);
  assert.ok(duplicate.reasons.includes("PORTFOLIO_UNDERLYING_EXPOSURE_EXISTS"));
  await coordinator.recordCompletedExit("QQQ", timestamp, -25);
  assert.deepEqual((await coordinator.snapshot(timestamp)).activeUnderlyings, ["SPY"]);
});

test("synthetic SPY and QQQ replays select and fill only their own option contracts", async () => {
  const [spy, qqq] = await Promise.all([
    replayOne(defaultConfig, "SPY", spyOption, 500),
    replayOne(qqqConfig, "QQQ", qqqOption, 600),
  ]);
  assert.equal(spy.funnel.ordersSubmitted, 1);
  assert.equal(spy.funnel.fills, 1);
  assert.equal(qqq.funnel.ordersSubmitted, 1);
  assert.equal(qqq.funnel.fills, 1);
  assert.equal(spy.openPosition?.symbol, spyOption);
  assert.equal(qqq.openPosition?.symbol, qqqOption);
  assert.equal(spy.metadata.underlying, "SPY");
  assert.equal(qqq.metadata.underlying, "QQQ");
  assert.equal(spy.metadata.configVersion, defaultConfig.version);
  assert.equal(qqq.metadata.configVersion, qqqConfig.version);
});

test("live order managers share the portfolio reservation before broker submission", async () => {
  const coordinator = new PortfolioRiskCoordinator({
    timeZone: defaultConfig.timeZone,
    maxConcurrentUnderlyings: 2,
    maxAggregateRiskDollars: 225,
    maxAggregatePremiumDollars: 1_000,
    maxDailyLossDollars: 1_000,
  }, timestamp);
  const spyBroker = new FlatUnderlyingBroker("SPY", spyOption);
  const qqqBroker = new FlatUnderlyingBroker("QQQ", qqqOption);
  const spyManager = new LiveOrderManager({ config: defaultConfig, client: spyBroker, portfolioRisk: coordinator });
  const qqqManager = new LiveOrderManager({ config: qqqConfig, client: qqqBroker, portfolioRisk: coordinator });
  await Promise.all([spyManager.initialize(timestamp), qqqManager.initialize(timestamp)]);
  const spyResult = await spyManager.submitEntry(entryRequest("SPY", spyOption, 500));
  const qqqResult = await qqqManager.submitEntry(entryRequest("QQQ", qqqOption, 600));
  assert.equal(spyResult.submitted, true);
  assert.equal(qqqResult.submitted, false);
  assert.ok(qqqResult.reasons.includes("PORTFOLIO_RISK_BUDGET_EXCEEDED"));
  assert.equal(spyBroker.requests.length, 1);
  assert.equal(qqqBroker.requests.length, 0);
});

test("QQQ serializes concurrent entries to one risk-sized broker order", async () => {
  const broker = new FlatUnderlyingBroker("QQQ", qqqOption);
  const manager = new LiveOrderManager({ config: qqqConfig, client: broker });
  await manager.initialize(timestamp);
  const firstRequest = entryRequest("QQQ", qqqOption, 600);
  const secondRequest = {
    ...entryRequest("QQQ", qqqOption, 600),
    signal: {
      ...entryRequest("QQQ", qqqOption, 600).signal,
      id: "QQQ-concurrent-signal",
    },
  };

  const [first, second] = await Promise.all([
    manager.submitEntry(firstRequest),
    manager.submitEntry(secondRequest),
  ]);

  assert.equal(first.submitted, true);
  assert.equal(second.submitted, false);
  assert.ok(second.reasons.includes("ORDER_ALREADY_PENDING"));
  assert.equal(broker.requests.length, 1);
  assert.equal(broker.requests[0]?.quantity, 3);
});

test("dashboard forward-move diagnostics never compare QQQ evaluations with SPY prices", () => {
  const store = new TradingDashboardStore(timestamp, false, 0, 0, () => timestamp + 5_000);
  store.record(entryEvaluation("QQQ", timestamp, 600, "NO_SIGNAL"));
  store.record(entryEvaluation("SPY", timestamp + 5_000, 500, "NO_SIGNAL"));
  assert.equal(store.snapshot().tuning.potentialMisses.length, 0);
  store.record(entryEvaluation("QQQ", timestamp + 5_000, 601, "NO_SIGNAL"));
  const misses = store.snapshot().tuning.potentialMisses;
  assert.equal(misses.length, 1);
  assert.equal(misses[0]?.underlying, "QQQ");
  assert.equal(misses[0]?.forwardPrice, 601);
});

test("dashboard exposes complete independent SPY, QQQ, and GOOGL views", () => {
  const store = new TradingDashboardStore(timestamp, false, 0, 0, () => timestamp + 5_000);
  store.record(audit("live_signal_selection", "SPY", {
    signalId: "spy-dashboard-signal", timestamp, direction: "BULLISH", kind: "IMPULSE",
    regime: "STRONG_UP", candidate: spyOption, selectionStatus: "SELECTED", reasons: [],
  }));
  store.record(audit("live_signal_selection", "QQQ", {
    signalId: "qqq-dashboard-signal", timestamp, direction: "BEARISH", kind: "IMPULSE",
    regime: "STRONG_DOWN", candidate: qqqOption, selectionStatus: "SELECTED", reasons: [],
  }));
  store.record(audit("entry_fill", "SPY", {
    incrementalQuantity: 1, incrementalPrice: 2, cumulativeQuantity: 1,
    position: {
      symbol: spyOption, direction: "BULLISH", quantity: 1, averageEntryPrice: 2,
      entryTimestamp: timestamp, stopPrice: 1.5,
    },
  }));
  store.record(audit("exit_fill", "SPY", {
    reason: "PROFIT_FLOOR_EXIT", symbol: spyOption, direction: "BULLISH",
    entryTimestamp: timestamp, averageEntryPrice: 2, incrementalQuantity: 1,
    incrementalPrice: 2.2, realizedPnl: 20, remainingQuantity: 0,
  }));
  store.record(audit("entry_fill", "QQQ", {
    incrementalQuantity: 1, incrementalPrice: 2, cumulativeQuantity: 1,
    position: {
      symbol: qqqOption, direction: "BEARISH", quantity: 1, averageEntryPrice: 2,
      entryTimestamp: timestamp, stopPrice: 1.5,
    },
  }));
  store.record(audit("exit_fill", "QQQ", {
    reason: "HARD_STOP", symbol: qqqOption, direction: "BEARISH",
    entryTimestamp: timestamp, averageEntryPrice: 2, incrementalQuantity: 1,
    incrementalPrice: 1.95, realizedPnl: -5, remainingQuantity: 0,
  }));
  store.record(entryEvaluation("SPY", timestamp, 500, "NO_SIGNAL"));
  store.record(entryEvaluation("QQQ", timestamp, 600, "NO_SIGNAL"));
  store.recordMarketEvent({
    type: "stock_quote", providerTimestamp: timestamp, receivedTimestamp: timestamp,
    marketDate: date, symbol: "SPY", data: stockQuote("SPY", 500) as unknown as Record<string, unknown>,
  });
  store.recordMarketEvent({
    type: "stock_quote", providerTimestamp: timestamp, receivedTimestamp: timestamp,
    marketDate: date, symbol: "QQQ", data: stockQuote("QQQ", 600) as unknown as Record<string, unknown>,
  });

  const snapshot = store.snapshot();
  assert.equal(snapshot.performance.signalsFired, 2);
  assert.equal(snapshot.underlyingViews.SPY.performance.signalsFired, 1);
  assert.equal(snapshot.underlyingViews.QQQ.performance.signalsFired, 1);
  assert.equal(snapshot.underlyingViews.GOOGL.performance.signalsFired, 0);
  assert.equal(snapshot.performance.realizedPnl, 15);
  assert.equal(snapshot.underlyingViews.SPY.performance.realizedPnl, 20);
  assert.equal(snapshot.underlyingViews.QQQ.performance.realizedPnl, -5);
  assert.equal(snapshot.underlyingViews.SPY.performance.wins, 1);
  assert.equal(snapshot.underlyingViews.QQQ.performance.losses, 1);
  assert.deepEqual(snapshot.underlyingViews.SPY.trades.map((trade) => trade.symbol), [spyOption]);
  assert.deepEqual(snapshot.underlyingViews.QQQ.trades.map((trade) => trade.symbol), [qqqOption]);
  assert.deepEqual(snapshot.underlyingViews.SPY.signals.map((signal) => signal.underlying), ["SPY"]);
  assert.deepEqual(snapshot.underlyingViews.QQQ.signals.map((signal) => signal.underlying), ["QQQ"]);
  assert.ok(snapshot.underlyingViews.SPY.decisions.every((decision) => decision.underlying === "SPY"));
  assert.ok(snapshot.underlyingViews.QQQ.decisions.every((decision) => decision.underlying === "QQQ"));
  assert.deepEqual(snapshot.underlyingViews.SPY.tuning.entries.map((entry) => entry.underlying), ["SPY"]);
  assert.deepEqual(snapshot.underlyingViews.QQQ.tuning.entries.map((entry) => entry.underlying), ["QQQ"]);
  assert.equal(snapshot.underlyingViews.SPY.liveData.eventCounts.stock_quote, 1);
  assert.equal(snapshot.underlyingViews.QQQ.liveData.eventCounts.stock_quote, 1);
  assert.deepEqual(snapshot.underlyingViews.SPY.liveData.recentEvents.map((event) => event.symbol), ["SPY"]);
  assert.deepEqual(snapshot.underlyingViews.QQQ.liveData.recentEvents.map((event) => event.symbol), ["QQQ"]);
});

function audit(type: string, underlying: "SPY" | "QQQ", data: Record<string, unknown>): AuditEvent {
  return {
    timestamp, marketDate: date, type, configVersion: "test",
    data: { underlying, ...data },
  };
}

function entryEvaluation(
  underlying: UnderlyingSymbol, eventTimestamp: number, price: number, decision: string,
): AuditEvent {
  return {
    timestamp: eventTimestamp, marketDate: date, type: "live_entry_evaluation", configVersion: "test",
    data: {
      underlying, decision, regime: "UNCLASSIFIED", reasons: ["NO_DIRECTION_PASSED"],
      feature: { symbol: underlying, price }, directions: [],
    },
  };
}

function stockQuote(symbol: "SPY" | "QQQ", price: number): StockQuote {
  return { symbol, timestamp, bidPrice: price - 0.01, askPrice: price + 0.01, bidSize: 10, askSize: 10 };
}

function stockTrade(symbol: "SPY" | "QQQ", price: number): StockTrade {
  return { symbol, timestamp, price, size: 10 };
}

function optionQuote(symbol: string): OptionQuote {
  return { symbol, timestamp, bidPrice: 1, askPrice: 1.01, bidSize: 10, askSize: 10 };
}

function stockCollector(values: string[]): StockStreamHandlers {
  return {
    onQuote: (quote) => { values.push(quote.symbol); },
    onTrade: (trade) => { values.push(trade.symbol); },
  };
}

function optionCollector(values: string[]): OptionStreamHandlers {
  return { onQuote: (quote) => { values.push(quote.symbol); } };
}

class FakeStockStream implements StockStream {
  handlers?: StockStreamHandlers;
  connectCalls = 0;
  closeCalls = 0;
  async connect(handlers: StockStreamHandlers): Promise<void> {
    this.connectCalls += 1;
    this.handlers = handlers;
    handlers.onState?.(true);
  }
  async close(): Promise<void> { this.closeCalls += 1; this.handlers?.onState?.(false); }
  async emit(events: Parameters<NonNullable<StockStreamHandlers["onEvents"]>>[0]): Promise<void> {
    await this.handlers?.onEvents?.(events);
  }
}

class FakeOptionStream implements OptionStream {
  handlers?: OptionStreamHandlers;
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
  async close(): Promise<void> { this.closeCalls += 1; this.handlers?.onState?.(false); }
  async emit(quotes: readonly OptionQuote[]): Promise<void> {
    this.handlers?.onActivity?.({ receiveWallTimestamp: timestamp, receiveMonotonicTimestamp: timestamp });
    this.handlers?.onQuoteObservations?.(quotes.map((quote) => ({
      quote, receiveWallTimestamp: timestamp, receiveMonotonicTimestamp: timestamp,
    })));
    await this.handlers?.onQuotes?.(quotes);
  }
}

class FakeMultiBroker implements MultiUnderlyingTradingRestClient {
  readonly account: AccountState = {
    equity: 100_000, optionBuyingPower: 25_000, active: true, optionsApproved: true, killSwitch: false,
  };
  async getAccount(): Promise<AccountState> { return { ...this.account }; }
  async getMarketClock(): Promise<{ timestamp: number; isOpen: boolean }> { return { timestamp, isOpen: true }; }
  async getLatestUnderlyingSipQuote(underlying: "SPY" | "QQQ"): Promise<StockQuote> {
    return stockQuote(underlying, underlying === "SPY" ? 500 : 600);
  }
  async listOptionContracts(underlying = "SPY" as const): Promise<OptionContract[]> {
    return [{
      symbol: underlying === "SPY" ? spyOption : qqqOption,
      underlying, expirationDate: date, strike: underlying === "SPY" ? 500 : 600,
      type: "call", active: true, tradable: true,
    }];
  }
  async getOptionSnapshots(symbols: readonly string[]): Promise<OptionSnapshot[]> {
    return symbols.map((symbol) => ({ symbol }));
  }
  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder> {
    return { id: request.clientOrderId, clientOrderId: request.clientOrderId, symbol: request.symbol, status: "new", filledQuantity: 0 };
  }
  async getOrder(orderId: string): Promise<BrokerOrder> {
    return { id: orderId, clientOrderId: orderId, symbol: spyOption, status: "new", filledQuantity: 0 };
  }
  async getOrderByClientOrderId(clientOrderId: string): Promise<BrokerOrder> { return this.getOrder(clientOrderId); }
  async replaceOrder(orderId: string): Promise<BrokerOrder> { return this.getOrder(orderId); }
  async cancelOrder(): Promise<void> {}
  async listOpenOrders(): Promise<BrokerOrder[]> {
    return [
      { id: "s", clientOrderId: "s", symbol: spyOption, status: "new", filledQuantity: 0 },
      { id: "q", clientOrderId: "q", symbol: qqqOption, status: "new", filledQuantity: 0 },
    ];
  }
  async listPositions(): Promise<BrokerPosition[]> {
    return [
      { symbol: spyOption, direction: "BULLISH", quantity: 1, averageEntryPrice: 1 },
      { symbol: qqqOption, direction: "BULLISH", quantity: 1, averageEntryPrice: 1 },
    ];
  }
}

class FlatUnderlyingBroker implements TradingRestClient {
  readonly requests: BrokerOrderRequest[] = [];
  readonly #underlying: UnderlyingSymbol;
  readonly #optionSymbol: string;
  constructor(underlying: UnderlyingSymbol, optionSymbol: string) {
    this.#underlying = underlying;
    this.#optionSymbol = optionSymbol;
  }
  async getAccount(): Promise<AccountState> {
    return { equity: 100_000, optionBuyingPower: 25_000, active: true, optionsApproved: true, killSwitch: false };
  }
  async getMarketClock(): Promise<{ timestamp: number; isOpen: boolean }> { return { timestamp, isOpen: true }; }
  async listOptionContracts(): Promise<OptionContract[]> { return []; }
  async getOptionSnapshots(): Promise<OptionSnapshot[]> { return []; }
  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder> {
    this.requests.push(request);
    return {
      id: `${this.#underlying}-order`, clientOrderId: request.clientOrderId,
      symbol: request.symbol, status: "new", filledQuantity: 0,
    };
  }
  async getOrder(): Promise<BrokerOrder> { throw new Error("unexpected order poll"); }
  async getOrderByClientOrderId(): Promise<BrokerOrder> { throw new Error("unexpected order recovery"); }
  async replaceOrder(): Promise<BrokerOrder> { throw new Error("unexpected order replacement"); }
  async cancelOrder(): Promise<void> { throw new Error("unexpected order cancellation"); }
  async listOpenOrders(): Promise<BrokerOrder[]> { return []; }
  async listPositions(): Promise<BrokerPosition[]> { return []; }
  optionSymbol(): string { return this.#optionSymbol; }
}

function orderRequest(symbol: string): BrokerOrderRequest {
  return { clientOrderId: "test", symbol, side: "buy", quantity: 1, limitPrice: 1, timeInForce: "day" };
}

function entryRequest(underlying: UnderlyingSymbol, optionSymbol: string, spot: number) {
  const feature = replayFeature(underlying, spot);
  const signal: TradeSignal = {
    id: `${underlying}-signal`, timestamp, direction: "BULLISH", kind: "IMPULSE",
    regime: "STRONG_UP", projectedMoveBps: 3, votes: [], reasons: [], featureSnapshot: feature,
  };
  const contract: OptionContract = {
    symbol: optionSymbol, underlying, expirationDate: date, strike: spot,
    type: "call", active: true, tradable: true,
  };
  return {
    timestamp, signal,
    candidate: {
      symbol: optionSymbol, contract, delta: 0.52, gamma: 0.02, impliedVolatility: 0.22,
      mid: 2.005, spreadPct: 0.005, eligible: true, rejectionReasons: [],
    },
    quote: optionQuoteAt(optionSymbol, timestamp, 2, 2.01),
  };
}

async function replayOne(
  sourceConfig: typeof defaultConfig, underlying: UnderlyingSymbol, optionSymbol: string, spot: number,
) {
  const config = structuredClone(sourceConfig);
  config.signals.entryConfirmationMode = "SHADOW";
  config.signals.followThroughMinSec = 0;
  config.signals.followThroughMaxSec = 0;
  const engine = new ReplayEngine({ config });
  await engine.ingest({
    type: "option_contract", timestamp: timestamp - 30,
    data: {
      symbol: optionSymbol, underlying, expirationDate: date, strike: spot,
      type: "call", active: true, tradable: true,
    },
  });
  await engine.ingest({
    type: "option_snapshot", timestamp: timestamp - 20,
    data: {
      symbol: optionSymbol, timestamp: timestamp - 20, impliedVolatility: 0.22,
      greeks: { delta: 0.52, gamma: 0.02 }, dailyVolume: 1_000, openInterest: 5_000,
    },
  });
  await engine.ingest({
    type: "option_quote", timestamp: timestamp - 10,
    data: optionQuoteAt(optionSymbol, timestamp - 10, 2, 2.016),
  });
  await engine.ingestRecordedFeature(replayFeature(underlying, spot));
  await engine.ingest({
    type: "option_quote", timestamp: timestamp + 100,
    data: optionQuoteAt(optionSymbol, timestamp + 100, 2.01, 2.02),
  });
  return engine.finish();
}

function replayFeature(symbol: UnderlyingSymbol, price: number): FeatureSnapshot {
  return {
    symbol, timestamp, marketDate: date, price, mid: price,
    spreadBps: 0.2, quoteAgeMs: 100, quoteImbalance: 0.5,
    quoteImbalanceEwma5: 0.5, quoteImbalanceEwma15: 0.4, micropriceDisplacementBps: 0.1,
    ofi1: 0.1, ofi5: 0.2, ofi15: 0.1, volume60: 100_000,
    fast: replayWindow(10, 0.6, 0.02, 0.8, 0.2, price),
    medium: replayWindow(30, 0.2, 0, 0.6, 0, price),
    slow: replayWindow(120, 0.04, 0, 0.3, 0, price),
    efficiency60: 0.6, signChanges60: 0,
    vwap: { sessionVwap: price - 1, rollingVwap: price - 0.5, rollingVwapSlopeBpsPerSec: 0.05, anchoredVwaps: {} },
    openingRange: {
      complete: true, high: price - 0.2, low: price - 1.8, midpoint: price - 1,
      widthBps: 32, nearHigh: true, nearLow: false, bullishRetest: false, bearishRetest: false,
    },
    thresholds: {
      source: "static", bucket: "10:20", sampleCount: 0, fastSlope: 0.42,
      fastAcceleration: 0.1, absoluteOfi5: 0.08, efficiency60: 0.28,
    },
    dataValid: true, invalidReasons: [],
  };
}

function replayWindow(
  windowSec: number, slope: number, acceleration: number,
  normalizedSlope: number, normalizedAcceleration: number, price: number,
): WindowMetrics {
  return {
    windowSec,
    regression: {
      valid: true, windowSec, pointCount: windowSec + 1, coverageFraction: 1,
      levelLog: Math.log(price), slopeBpsPerSec: slope, accelerationBpsPerSec2: acceleration,
      r2: 0.8,
      coefficients: [Math.log(price), slope * windowSec / 10_000, acceleration * windowSec ** 2 / 20_000],
    },
    realizedVolatilityBps: 2, efficiencyRatio: 0.6, noiseFloorBps: 2,
    normalizedSlope, normalizedAcceleration, signChanges: 0,
  };
}

function optionQuoteAt(symbol: string, quoteTimestamp: number, bidPrice: number, askPrice: number): OptionQuote {
  return { symbol, timestamp: quoteTimestamp, bidPrice, askPrice, bidSize: 100, askSize: 100 };
}
