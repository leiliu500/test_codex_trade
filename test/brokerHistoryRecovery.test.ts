import assert from "node:assert/strict";
import test from "node:test";
import type { MultiUnderlyingTradingRestClient } from "../src/alpaca/restClient.js";
import { recoverTerminalDashboardOrders } from "../src/execution/brokerHistoryRecovery.js";
import type { DashboardOrderCard } from "../src/ops/orderCards.js";

const symbol = "QQQ260811P00719000";
const entryTimestamp = Date.parse("2026-08-11T16:28:41.242Z");
const fillTimestamp = Date.parse("2026-08-11T16:28:50.925Z");

function exitCard(): DashboardOrderCard {
  return {
    id: "entry-order",
    symbol,
    direction: "BEARISH",
    active: true,
    stage: "EXIT_WORKING",
    status: "pending_new",
    quantity: 1,
    remainingQuantity: 1,
    entryPrice: 1.4,
    entryTimestamp,
    realizedPnl: 0,
    exitReason: "STALE_DATA",
    updates: [],
    workingOrder: {
      clientOrderId: "exit-order",
      brokerOrderId: "broker-exit",
      purpose: "EXIT",
      side: "sell",
      status: "pending_new",
      limitPrice: 1.35,
      requestedQuantity: 1,
      filledQuantity: 0,
      replacements: 0,
      exitIntentId: "exit-intent",
      triggers: ["BROKER_OR_POSITION_RISK"],
    },
  };
}

test("startup history recovery converts a broker-filled exit into durable terminal events", async () => {
  const client = {
    getOrder: async () => ({
      id: "broker-exit",
      clientOrderId: "exit-order",
      symbol,
      status: "filled",
      filledQuantity: 1,
      averageFillPrice: 1.4,
      filledAt: fillTimestamp,
    }),
  } as unknown as MultiUnderlyingTradingRestClient;
  const result = await recoverTerminalDashboardOrders(
    client,
    [exitCard()],
    { SPY: "spy-test", QQQ: "qqq-test" },
    "America/New_York",
  );

  assert.equal(result.checkedOrders, 1);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.events.map((event) => event.type), ["broker_order_state", "exit_fill"]);
  assert.equal(result.events[1]?.timestamp, fillTimestamp);
  assert.equal(result.events[1]?.data.incrementalPrice, 1.4);
  assert.equal(result.events[1]?.data.realizedPnl, 0);
  assert.equal(result.events[1]?.data.remainingQuantity, 0);
  assert.equal(result.events[1]?.data.recoveredFromBroker, true);
});

test("terminal unfilled orders update status without inventing an exit fill", async () => {
  const client = {
    getOrder: async () => ({
      id: "broker-exit",
      clientOrderId: "exit-order",
      symbol,
      status: "canceled",
      filledQuantity: 0,
      canceledAt: fillTimestamp,
    }),
  } as unknown as MultiUnderlyingTradingRestClient;
  const result = await recoverTerminalDashboardOrders(
    client,
    [exitCard()],
    { SPY: "spy-test", QQQ: "qqq-test" },
    "America/New_York",
  );
  assert.deepEqual(result.events.map((event) => event.type), ["broker_order_state"]);
});
