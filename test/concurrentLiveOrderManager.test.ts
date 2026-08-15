import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, qqqConfig } from "../src/config.js";
import {
  ConcurrentLiveOrderManager,
} from "../src/execution/concurrentLiveOrderManager.js";
import type {
  BrokerOrder, BrokerOrderRequest, BrokerPosition, TradingRestClient,
} from "../src/alpaca/restClient.js";
import type {
  AccountState, OptionCandidateEvaluation, OptionContract, OptionQuote, OptionSnapshot,
  TradeSignal, UnderlyingSymbol,
} from "../src/types.js";
import { PortfolioRiskCoordinator } from "../src/risk/portfolioRiskCoordinator.js";

const timestamp = Date.parse("2026-07-22T15:00:00.000Z");
const spySymbols = [
  "SPY260722C00500000",
  "SPY260722C00501000",
  "SPY260722C00502000",
  "SPY260722C00503000",
] as const;

class ImmediateFillBroker implements TradingRestClient {
  readonly positions = new Map<string, BrokerPosition>();
  readonly orders = new Map<string, BrokerOrder>();

  getAccount(): Promise<AccountState> {
    return Promise.resolve({
      equity: 100_000,
      optionBuyingPower: 50_000,
      active: true,
      optionsApproved: true,
      killSwitch: false,
    });
  }

  getMarketClock() { return Promise.resolve({ timestamp, isOpen: true }); }
  listOptionContracts(_underlying?: UnderlyingSymbol): Promise<OptionContract[]> { return Promise.resolve([]); }
  getOptionSnapshots(_symbols: readonly string[]): Promise<OptionSnapshot[]> { return Promise.resolve([]); }

  submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder> {
    const prior = this.positions.get(request.symbol);
    if (request.side === "buy") {
      const priorQuantity = prior?.quantity ?? 0;
      this.positions.set(request.symbol, {
        symbol: request.symbol,
        direction: "BULLISH",
        quantity: priorQuantity + request.quantity,
        averageEntryPrice: request.limitPrice,
        underlyingEntryPrice: 500,
      });
    } else if (prior) {
      const quantity = prior.quantity - request.quantity;
      if (quantity > 0) this.positions.set(request.symbol, { ...prior, quantity });
      else this.positions.delete(request.symbol);
    }
    const order: BrokerOrder = {
      id: `order-${this.orders.size + 1}`,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      status: "filled",
      filledQuantity: request.quantity,
      averageFillPrice: request.limitPrice,
    };
    this.orders.set(order.id, order);
    return Promise.resolve(order);
  }

  getOrder(orderId: string): Promise<BrokerOrder> {
    return Promise.resolve(this.orders.get(orderId)!);
  }

  getOrderByClientOrderId(clientOrderId: string): Promise<BrokerOrder> {
    return Promise.resolve([...this.orders.values()].find((order) =>
      order.clientOrderId === clientOrderId)!);
  }

  replaceOrder(orderId: string, _limitPrice: number): Promise<BrokerOrder> {
    return this.getOrder(orderId);
  }

  cancelOrder(_orderId: string): Promise<void> { return Promise.resolve(); }
  listOpenOrders(): Promise<BrokerOrder[]> { return Promise.resolve([]); }
  listPositions(): Promise<BrokerPosition[]> { return Promise.resolve([...this.positions.values()]); }
}

function entry(symbol: string, id: string) {
  const contract: OptionContract = {
    symbol,
    underlying: "SPY",
    expirationDate: "2026-07-22",
    strike: Number(symbol.slice(-8)) / 1_000,
    type: "call",
    tradable: true,
    active: true,
  };
  const signal: TradeSignal = {
    id,
    timestamp,
    direction: "BULLISH",
    kind: "IMPULSE",
    regime: "STRONG_UP",
    projectedMoveBps: 20,
    votes: [],
    reasons: [],
    featureSnapshot: {
      symbol: "SPY",
      timestamp,
      price: 500,
    } as TradeSignal["featureSnapshot"],
  };
  const candidate: OptionCandidateEvaluation = {
    symbol,
    contract,
    eligible: true,
    rejectionReasons: [],
    mid: 1.05,
    spreadPct: 0.095,
  };
  const quote: OptionQuote = {
    symbol,
    timestamp,
    bidPrice: 1,
    bidSize: 10,
    askPrice: 1.1,
    askSize: 10,
  };
  return { timestamp, signal, candidate, quote };
}

test("SPY coordinator permits three distinct positions and rejects a fourth", async () => {
  const broker = new ImmediateFillBroker();
  const portfolio = new PortfolioRiskCoordinator({
    timeZone: defaultConfig.timeZone,
    maxConcurrentPositions: 6,
    maxPositionsPerUnderlying: 3,
    maxAggregateRiskDollars: 3_000,
    maxAggregatePremiumDollars: 9_000,
    maxDailyLossDollars: 1_000,
  }, timestamp);
  const manager = new ConcurrentLiveOrderManager({
    config: defaultConfig,
    client: broker,
    portfolioRisk: portfolio,
  });
  await manager.initialize(timestamp);

  for (let index = 0; index < 3; index += 1) {
    const result = await manager.submitEntry(entry(spySymbols[index]!, `signal-${index + 1}`));
    assert.equal(result.submitted, true);
  }
  const snapshot = manager.snapshot();
  assert.equal(snapshot.positionCount, 3);
  assert.equal(snapshot.maxPositions, 3);
  assert.deepEqual(snapshot.positions.map((position) => position.symbol), spySymbols.slice(0, 3));
  assert.equal((await portfolio.snapshot(timestamp)).activePositions, 3);

  const fourth = await manager.submitEntry(entry(spySymbols[3], "signal-4"));
  assert.equal(fourth.submitted, false);
  assert.deepEqual(fourth.reasons, ["MAX_POSITIONS_PER_UNDERLYING"]);
  assert.equal(broker.orders.size, 3);
});

test("concurrent manager rejects a duplicate OCC symbol as a separate position", async () => {
  const broker = new ImmediateFillBroker();
  const manager = new ConcurrentLiveOrderManager({ config: defaultConfig, client: broker });
  await manager.initialize(timestamp);
  assert.equal((await manager.submitEntry(entry(spySymbols[0], "signal-1"))).submitted, true);
  const duplicate = await manager.submitEntry(entry(spySymbols[0], "signal-2"));
  assert.equal(duplicate.submitted, false);
  assert.deepEqual(duplicate.reasons, ["POSITION_SYMBOL_ALREADY_OPEN"]);
});

test("startup adopts and independently exits three broker positions", async () => {
  const broker = new ImmediateFillBroker();
  for (const symbol of spySymbols.slice(0, 3)) {
    broker.positions.set(symbol, {
      symbol,
      direction: "BULLISH",
      quantity: 1,
      averageEntryPrice: 1.05,
      underlyingEntryPrice: 500,
    });
  }
  const manager = new ConcurrentLiveOrderManager({ config: defaultConfig, client: broker });
  const restored = await manager.initialize(timestamp);
  assert.equal(restored.positionCount, 3);
  assert.equal(restored.safeMode, true);

  const exited = await manager.tick({
    timestamp,
    optionQuotes: spySymbols.slice(0, 3).map((symbol) => entry(symbol, "exit").quote),
    killSwitch: true,
  });
  assert.equal(exited.positionCount, 0);
  assert.equal(exited.safeMode, false);
  assert.equal(broker.positions.size, 0);
  assert.equal(broker.orders.size, 3);
});

test("SPY and QQQ configurations each allow three position slots", () => {
  assert.equal(defaultConfig.risk.maxPositionsPerUnderlying, 3);
  assert.equal(qqqConfig.risk.maxPositionsPerUnderlying, 3);
});
