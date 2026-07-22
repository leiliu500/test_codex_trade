import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { readEnvironment } from "../src/utils/env.js";
import { healthReadiness, startHealthServer, type HealthState } from "../src/ops/healthServer.js";
import type { StockStream, StockStreamHandlers } from "../src/alpaca/stockStream.js";
import type { StockQuote, StockTrade } from "../src/types.js";
import { SpySipReceiver } from "../src/runtime/spySipReceiver.js";
import { defaultConfig } from "../src/config.js";
import { TradingDashboardStore } from "../src/ops/tradingDashboard.js";

test("runtime environment is paper-safe and validates the health listener", () => {
  assert.deepEqual(readEnvironment({}), {
    tradingMode: "paper",
    liveOrdersEnabled: false,
    marketDataEnabled: false,
    stockDataFeed: "sip",
    optionDataFeed: "opra",
    historyDatabaseEnabled: false,
    killSwitch: false,
    healthHost: "127.0.0.1",
    healthPort: 3001,
  });
  assert.throws(() => readEnvironment({ HEALTH_PORT: "0" }), /HEALTH_PORT/);
  assert.throws(() => readEnvironment({ HEALTH_PORT: "not-a-port" }), /HEALTH_PORT/);
  assert.throws(() => readEnvironment({ STOCK_DATA_FEED: "iex" }), /hard-limited.*SIP/i);
  assert.throws(() => readEnvironment({ OPTION_DATA_FEED: "indicative" }), /OPRA/i);
  assert.throws(() => readEnvironment({ ENABLE_LIVE_ORDERS: "true" }), /MARKET_DATA_ENABLED/);
  assert.throws(() => readEnvironment({ HISTORY_DATABASE_ENABLED: "true" }), /DATABASE_URL/);
  assert.throws(() => readEnvironment({ MARKET_DATA_ENABLED: "true" }), /ALPACA_API_KEY/);
  assert.throws(() => readEnvironment({ TRADING_MODE: "live" }), /ENABLE_LIVE_ORDERS/);
  assert.equal(readEnvironment({
    MARKET_DATA_ENABLED: "true", ALPACA_API_KEY: "key", ALPACA_API_SECRET: "secret",
  }).marketDataEnabled, true);
});

test("health server exposes liveness while paper-idle readiness is degraded", async (context) => {
  const state: HealthState = {
    ready: false,
    subscribedOptionContracts: 0,
    websocketConnected: false,
    brokerAvailable: false,
    marketClockState: "paper-idle",
    openOrderCount: 0,
    positionsReconciled: true,
    recorderHealthy: true,
    killSwitch: false,
  };
  const dashboard = new TradingDashboardStore();
  const server = startHealthServer(() => state, 0, "127.0.0.1", () => dashboard.snapshot());
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  const live = await fetch(`http://127.0.0.1:${address.port}/live`);
  const ready = await fetch(`http://127.0.0.1:${address.port}/ready`);
  const dashboardPage = await fetch(`http://127.0.0.1:${address.port}/dashboard`);
  const dashboardApi = await fetch(`http://127.0.0.1:${address.port}/api/dashboard`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "alive" });
  assert.equal(ready.status, 503);
  assert.equal((await ready.json() as { status: string }).status, "degraded");
  assert.equal(dashboardPage.status, 200);
  assert.match(await dashboardPage.text(), /SPY 0DTE Option Day-Trade Dashboard/);
  assert.equal(dashboardApi.status, 200);
  assert.equal((await dashboardApi.json() as { readiness: string }).readiness, "degraded");
});

class FakeStockStream implements StockStream {
  handlers: StockStreamHandlers | undefined;
  async connect(handlers: StockStreamHandlers): Promise<void> {
    this.handlers = handlers;
    handlers.onState?.(true);
  }
  async close(): Promise<void> { this.handlers?.onState?.(false); }
  async quote(value: StockQuote): Promise<void> { await this.handlers?.onQuote(value); }
  async trade(value: StockTrade): Promise<void> { await this.handlers?.onTrade(value); }
}

test("SPY SIP receiver serializes quotes and trades into completed feature bars", async () => {
  const stream = new FakeStockStream();
  const start = Date.parse("2026-07-22T14:30:00Z");
  let now = start;
  const receiver = new SpySipReceiver({
    config: defaultConfig,
    stream,
    now: () => now,
    flushIntervalMs: 60_000,
  });
  await receiver.start();
  await stream.quote({
    symbol: "SPY", timestamp: start + 100, bidPrice: 500, askPrice: 500.01, bidSize: 100, askSize: 120,
  });
  await stream.trade({ symbol: "SPY", timestamp: start + 200, price: 500.005, size: 50 });
  now = start + 1_200;
  await stream.quote({
    symbol: "SPY", timestamp: start + 1_100, bidPrice: 500.01, askPrice: 500.02, bidSize: 110, askSize: 100,
  });
  const health = receiver.healthState();
  assert.equal(healthReadiness(health).status, "ok");
  assert.equal(health.marketDataFeed, "sip");
  assert.equal(health.receivedStockQuotes, 2);
  assert.equal(health.receivedStockTrades, 1);
  assert.equal(health.completedBars, 1);
  assert.equal(health.lastFeatureTimestamp, start + 1_000);
  assert.equal(health.brokerAvailable, false);
  await receiver.close();
});
