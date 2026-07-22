import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import type { BrokerOrder, BrokerOrderRequest, TradingRestClient } from "../src/alpaca/restClient.js";
import type {
  AccountState, FeatureSnapshot, OptionCandidateEvaluation, OptionContract, OptionQuote, OptionSnapshot,
  PositionState, TradeSignal,
} from "../src/types.js";
import { LiveOrderManager } from "../src/execution/liveOrderManager.js";
import { MemoryRecorder } from "../src/ops/recorder.js";
import { zonedDateTimeToEpoch } from "../src/utils/time.js";

const date = "2026-07-22";
const symbol = "SPY260722C00500000";
const start = zonedDateTimeToEpoch(date, "10:20:00");

class FakeTradingClient implements TradingRestClient {
  clock = { timestamp: start, isOpen: true };
  account: AccountState = {
    equity: 100_000, optionBuyingPower: 25_000, active: true, optionsApproved: true, killSwitch: false,
  };
  readonly orders = new Map<string, BrokerOrder>();
  readonly requests: BrokerOrderRequest[] = [];
  replaceCalls = 0;
  cancelCalls = 0;
  failNextSubmitAfterAccept = false;
  #sequence = 0;

  async getAccount(): Promise<AccountState> { return { ...this.account }; }
  async getMarketClock(): Promise<{ timestamp: number; isOpen: boolean }> { return { ...this.clock }; }
  async listOptionContracts(): Promise<OptionContract[]> { return []; }
  async getOptionSnapshots(_symbols: readonly string[]): Promise<OptionSnapshot[]> { return []; }
  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder> {
    this.requests.push({ ...request });
    const order: BrokerOrder = {
      id: `order-${++this.#sequence}`, clientOrderId: request.clientOrderId, symbol: request.symbol,
      status: "new", filledQuantity: 0,
    };
    this.orders.set(order.id, order);
    if (this.failNextSubmitAfterAccept) {
      this.failNextSubmitAfterAccept = false;
      throw new Error("simulated response timeout after broker acceptance");
    }
    return { ...order };
  }
  async getOrder(orderId: string): Promise<BrokerOrder> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`missing order ${orderId}`);
    return { ...order };
  }
  async getOrderByClientOrderId(clientOrderId: string): Promise<BrokerOrder> {
    const order = [...this.orders.values()].reverse().find((value) => value.clientOrderId === clientOrderId);
    if (!order) throw new Error(`missing client order ${clientOrderId}`);
    return { ...order };
  }
  async replaceOrder(orderId: string, _limitPrice: number): Promise<BrokerOrder> {
    const old = this.orders.get(orderId);
    if (!old) throw new Error(`missing order ${orderId}`);
    old.status = "replaced";
    this.replaceCalls += 1;
    const replacement: BrokerOrder = {
      ...old, id: `order-${++this.#sequence}`, status: "new",
    };
    this.orders.set(replacement.id, replacement);
    return { ...replacement };
  }
  async cancelOrder(orderId: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`missing order ${orderId}`);
    order.status = "canceled";
    this.cancelCalls += 1;
  }
  async listOpenOrders(): Promise<BrokerOrder[]> {
    return [...this.orders.values()].filter((order) => ["new", "partially_filled"].includes(order.status)).map((order) => ({ ...order }));
  }
  async listPositions(): Promise<PositionState[]> { return []; }

  fill(orderId: string, filledQuantity: number, averageFillPrice: number, status: "partially_filled" | "filled"): void {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`missing order ${orderId}`);
    order.filledQuantity = filledQuantity;
    order.averageFillPrice = averageFillPrice;
    order.status = status;
  }
}

function optionQuote(timestamp: number, bid = 1.99, ask = 2.01): OptionQuote {
  return { symbol, timestamp, bidPrice: bid, askPrice: ask, bidSize: 100, askSize: 100 };
}

function signal(timestamp = start): TradeSignal {
  return {
    id: `sig-${timestamp}`, timestamp, direction: "BULLISH", kind: "IMPULSE", regime: "STRONG_UP",
    projectedMoveBps: 12, votes: [], reasons: [],
    featureSnapshot: { symbol: "SPY", timestamp } as FeatureSnapshot,
  };
}

function candidate(): OptionCandidateEvaluation {
  return {
    symbol,
    contract: {
      symbol, underlying: "SPY", expirationDate: date, strike: 500, type: "call", active: true, tradable: true,
    },
    mid: 2,
    eligible: true,
    rejectionReasons: [],
  };
}

test("live manager submits an option entry, reconciles partial fill, cancels remainder, and hard-stops exposure", async () => {
  const client = new FakeTradingClient();
  const recorder = new MemoryRecorder();
  const manager = new LiveOrderManager({ config: defaultConfig, client, recorder });
  await manager.initialize(start);

  const submitted = await manager.submitEntry({ timestamp: start, signal: signal(), candidate: candidate(), quote: optionQuote(start) });
  assert.equal(submitted.submitted, true);
  assert.equal(submitted.risk?.quantity, 5);
  assert.equal(client.requests[0]?.symbol, symbol);
  assert.equal(client.requests[0]?.timeInForce, "day");

  client.fill(submitted.brokerOrder!.id, 2, 2.02, "partially_filled");
  let state = await manager.tick({ timestamp: start + 500, optionQuote: optionQuote(start + 500) });
  assert.equal(state.position?.quantity, 2);
  assert.equal(state.position?.averageEntryPrice, 2.02);
  assert.ok(Math.abs(state.position!.stopPrice - 1.515) < 1e-12);
  assert.equal(state.pending?.purpose, "ENTRY");

  state = await manager.tick({ timestamp: start + 1000, optionQuote: optionQuote(start + 1000, 1.48, 1.50) });
  assert.equal(client.cancelCalls, 1);
  assert.equal(state.pending?.purpose, "EXIT");
  assert.equal(state.pending?.exitReason, "HARD_STOP");
  assert.equal(state.pending?.order.marketable, true);
  assert.equal(state.pending?.order.limitPrice, 1.48);

  client.fill(state.pending!.brokerOrderId, 2, 1.48, "filled");
  state = await manager.tick({ timestamp: start + 1400, optionQuote: optionQuote(start + 1400, 1.47, 1.49) });
  assert.equal(state.position, undefined);
  assert.equal(state.pending, undefined);
  assert.ok(recorder.events.some((event) => event.type === "exit_fill" && Number(event.data.realizedPnl) < 0));
});

test("trailing protection locks a configured profit floor after activation", async () => {
  const client = new FakeTradingClient();
  const manager = new LiveOrderManager({ config: defaultConfig, client });
  await manager.initialize(start);
  const submitted = await manager.submitEntry({ timestamp: start, signal: signal(), candidate: candidate(), quote: optionQuote(start) });
  client.fill(submitted.brokerOrder!.id, submitted.risk!.quantity, 2, "filled");
  let state = await manager.tick({ timestamp: start + 400, optionQuote: optionQuote(start + 400) });
  assert.equal(state.position?.averageEntryPrice, 2);

  state = await manager.tick({ timestamp: start + 500, optionQuote: optionQuote(start + 500, 2.39, 2.41) });
  assert.ok(Math.abs(state.position!.highWaterMark - 2.4) < 1e-12);
  assert.equal(state.pending, undefined);

  state = await manager.tick({ timestamp: start + 600, optionQuote: optionQuote(start + 600, 2.02, 2.04) });
  assert.equal(state.pending?.purpose, "EXIT");
  assert.equal(state.pending?.exitReason, "TRAILING_STOP");
  assert.equal(state.pending?.order.marketable, true);
});

test("unfilled entry is replaced toward market and canceled at its deadline", async () => {
  const client = new FakeTradingClient();
  const manager = new LiveOrderManager({ config: defaultConfig, client });
  await manager.initialize(start);
  await manager.submitEntry({ timestamp: start, signal: signal(), candidate: candidate(), quote: optionQuote(start) });

  let state = await manager.tick({ timestamp: start + 1900, optionQuote: optionQuote(start + 1900, 2, 2.04) });
  assert.equal(client.replaceCalls, 1);
  assert.equal(state.pending?.order.replacements, 1);

  state = await manager.tick({ timestamp: start + 7000, optionQuote: optionQuote(start + 7000, 2, 2.04) });
  assert.equal(client.cancelCalls, 1);
  assert.equal(state.pending, undefined);
  assert.equal(state.position, undefined);
});

test("forced session exit remains marketable and is repriced instead of canceled", async () => {
  const client = new FakeTradingClient();
  const manager = new LiveOrderManager({ config: defaultConfig, client });
  await manager.initialize(start);
  const submitted = await manager.submitEntry({ timestamp: start, signal: signal(), candidate: candidate(), quote: optionQuote(start) });
  client.fill(submitted.brokerOrder!.id, submitted.risk!.quantity, 2, "filled");
  await manager.tick({ timestamp: start + 400, optionQuote: optionQuote(start + 400) });

  const forceExit = zonedDateTimeToEpoch(date, defaultConfig.session.forceExit);
  let state = await manager.tick({ timestamp: forceExit, optionQuote: optionQuote(forceExit, 2.10, 2.12) });
  assert.equal(state.pending?.exitReason, "FORCED_SESSION_EXIT");
  assert.equal(state.pending?.order.marketable, true);
  assert.equal(state.pending?.order.limitPrice, 2.10);

  state = await manager.tick({ timestamp: forceExit + 7000, optionQuote: optionQuote(forceExit + 7000, 2.05, 2.07) });
  assert.equal(state.pending?.purpose, "EXIT");
  assert.equal(client.cancelCalls, 0);
  assert.ok(client.replaceCalls >= 1);
});

test("ambiguous submission is recovered by deterministic client order ID without a duplicate", async () => {
  const client = new FakeTradingClient();
  client.failNextSubmitAfterAccept = true;
  const recorder = new MemoryRecorder();
  const manager = new LiveOrderManager({ config: defaultConfig, client, recorder });
  await manager.initialize(start);
  const result = await manager.submitEntry({ timestamp: start, signal: signal(), candidate: candidate(), quote: optionQuote(start) });
  assert.equal(result.submitted, true);
  assert.equal(client.requests.length, 1);
  assert.equal(manager.snapshot().pending?.brokerOrderId, result.brokerOrder?.id);
  assert.ok(recorder.events.some((event) => event.type === "broker_submission_recovered"));
});

test("startup halts when an open broker order has no restored local lifecycle state", async () => {
  const client = new FakeTradingClient();
  await client.submitOrder({
    clientOrderId: "unknown-open-order", symbol, side: "buy", quantity: 1, limitPrice: 2, timeInForce: "day",
  });
  const manager = new LiveOrderManager({ config: defaultConfig, client });
  await assert.rejects(() => manager.initialize(start), /OPEN_ORDERS_REQUIRE_RESTORED_LOCAL_STATE/);
  assert.equal(manager.snapshot().halted, true);
});
