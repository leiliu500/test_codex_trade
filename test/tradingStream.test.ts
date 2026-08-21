import test from "node:test";
import assert from "node:assert/strict";
import {
  AccountTradeUpdateCoordinator,
  adaptAlpacaTradeUpdate,
  type AlpacaTradeUpdate,
  type TradeUpdateStream,
  type TradeUpdateStreamHandlers,
} from "../src/alpaca/tradingStream.js";

const timestamp = Date.parse("2026-07-22T14:20:00.123Z");
const spyOption = "SPY260722C00500000";
const qqqOption = "QQQ260722C00600000";

test("Alpaca account updates map broker order and execution timestamps", () => {
  const update = adaptAlpacaTradeUpdate({
    event: "partial_fill",
    timestamp: "2026-07-22T14:20:00.123456789Z",
    order: {
      id: "order-1",
      client_order_id: "client-1",
      symbol: spyOption,
      status: "partially_filled",
      filled_qty: "1",
      filled_avg_price: "2.05",
      filled_at: "2026-07-22T14:20:00.120000000Z",
    },
  });
  assert.equal(update.event, "partial_fill");
  assert.equal(update.timestamp, timestamp);
  assert.deepEqual(update.order, {
    id: "order-1",
    clientOrderId: "client-1",
    symbol: spyOption,
    status: "partially_filled",
    filledQuantity: 1,
    averageFillPrice: 2.05,
    filledTimestamp: Date.parse("2026-07-22T14:20:00.120Z"),
  });
});

test("one account trade-update stream routes tickers and reconciles all consumers after reconnect", async () => {
  const physical = new FakeTradeUpdateStream();
  const spyUpdates: string[] = [];
  const qqqUpdates: string[] = [];
  let spyReconciliations = 0;
  let qqqReconciliations = 0;
  const coordinator = new AccountTradeUpdateCoordinator(physical, {
    SPY: {
      onUpdate: (update) => { spyUpdates.push(update.order.symbol); },
      onReconcile: () => { spyReconciliations += 1; },
    },
    QQQ: {
      onUpdate: (update) => { qqqUpdates.push(update.order.symbol); },
      onReconcile: () => { qqqReconciliations += 1; },
    },
  }, { reconnectBaseMs: 1, reconnectMaximumMs: 1 });

  await coordinator.start();
  physical.emit(update(spyOption, "spy-client"));
  physical.emit(update(qqqOption, "qqq-client"));
  await waitFor(() => spyUpdates.length === 1 && qqqUpdates.length === 1);
  assert.deepEqual(spyUpdates, [spyOption]);
  assert.deepEqual(qqqUpdates, [qqqOption]);
  assert.equal(spyReconciliations, 1);
  assert.equal(qqqReconciliations, 1);

  physical.disconnect();
  await waitFor(() => physical.connectCalls === 2 && coordinator.ready);
  assert.equal(spyReconciliations, 2);
  assert.equal(qqqReconciliations, 2);
  assert.equal(physical.connectCalls, 2);
  await coordinator.close();
});

test("account updates remain buffered until initial REST reconciliation completes", async () => {
  const physical = new FakeTradeUpdateStream();
  let releaseReconciliation!: () => void;
  const reconciliation = new Promise<void>((resolve) => { releaseReconciliation = resolve; });
  const updates: string[] = [];
  const coordinator = new AccountTradeUpdateCoordinator(physical, {
    SPY: {
      onUpdate: (value) => { updates.push(value.order.id); },
      onReconcile: () => reconciliation,
    },
  });
  const start = coordinator.start();
  await waitFor(() => physical.connectCalls === 1);
  physical.emit(update(spyOption, "buffered"));
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(updates, []);
  releaseReconciliation();
  await start;
  assert.deepEqual(updates, ["buffered-order"]);
  await coordinator.close();
});

test("an update outside the enabled option universe permanently fails the account stream closed", async () => {
  const physical = new FakeTradeUpdateStream();
  const errors: string[] = [];
  const coordinator = new AccountTradeUpdateCoordinator(physical, {
    SPY: {
      onUpdate: () => undefined,
      onReconcile: () => undefined,
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    },
  }, { reconnectBaseMs: 1, reconnectMaximumMs: 1 });
  await coordinator.start();
  physical.emit(update(qqqOption, "disabled"));
  await waitFor(() => physical.closeCalls === 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(physical.connectCalls, 1);
  assert.equal(coordinator.ready, false);
  assert.equal(coordinator.telemetry("SPY").overloaded, true);
  assert.match(errors[0] ?? "", /disabled or invalid option/);
  await coordinator.close();
});

class FakeTradeUpdateStream implements TradeUpdateStream {
  handlers?: TradeUpdateStreamHandlers;
  connectCalls = 0;
  closeCalls = 0;

  async connect(handlers: TradeUpdateStreamHandlers): Promise<void> {
    this.connectCalls += 1;
    this.handlers = handlers;
    handlers.onState?.(true);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.handlers?.onState?.(false);
  }

  emit(value: AlpacaTradeUpdate): void { this.handlers?.onUpdate(value); }
  disconnect(): void { this.handlers?.onState?.(false); }
}

function update(symbol: string, clientOrderId: string): AlpacaTradeUpdate {
  return {
    event: "new",
    timestamp,
    order: {
      id: `${clientOrderId}-order`,
      clientOrderId,
      symbol,
      status: "new",
      filledQuantity: 0,
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error("Timed out waiting for test condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}
