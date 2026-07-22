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
import type { HistoricalMarketEvent } from "../src/history/types.js";
import { zonedDateTimeToEpoch } from "../src/utils/time.js";

test("runtime environment is paper-safe and validates the health listener", () => {
  assert.deepEqual(readEnvironment({}), {
    tradingMode: "paper",
    liveOrdersEnabled: false,
    marketDataEnabled: false,
    stockDataFeed: "sip",
    optionDataFeed: "opra",
    historyDatabaseEnabled: false,
    historyQuoteSampleMs: 250,
    historyRetentionDays: 7,
    killSwitch: false,
    healthHost: "127.0.0.1",
    healthPort: 3001,
  });
  assert.throws(() => readEnvironment({ HEALTH_PORT: "0" }), /HEALTH_PORT/);
  assert.throws(() => readEnvironment({ HEALTH_PORT: "not-a-port" }), /HEALTH_PORT/);
  assert.throws(() => readEnvironment({ MARKET_HISTORY_QUOTE_SAMPLE_MS: "-1" }), /QUOTE_SAMPLE/);
  assert.throws(() => readEnvironment({ MARKET_HISTORY_RETENTION_DAYS: "3.5" }), /RETENTION_DAYS/);
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

test("SPY SIP receiver restores complete opening range and VWAP without emitting live callbacks", async () => {
  const stream = new FakeStockStream();
  const start = zonedDateTimeToEpoch("2026-07-22", "09:30:00");
  const end = zonedDateTimeToEpoch("2026-07-22", "10:20:00");
  let callbackFeatures = 0;
  const receiver = new SpySipReceiver({
    config: defaultConfig,
    stream,
    now: () => end,
    flushIntervalMs: 60_000,
    onFeature: () => { callbackFeatures += 1; },
  });
  const events: HistoricalMarketEvent[] = [];
  for (let timestamp = start; timestamp <= end; timestamp += 1_000) {
    const price = 500 + 0.001 * ((timestamp - start) / 1_000);
    events.push({
      type: "stock_quote", providerTimestamp: timestamp + 100, receivedTimestamp: timestamp + 110,
      marketDate: "2026-07-22", symbol: "SPY",
      data: { symbol: "SPY", timestamp: timestamp + 100, bidPrice: price - 0.005, askPrice: price + 0.005,
        bidSize: 100, askSize: 100 },
    }, {
      type: "stock_trade", providerTimestamp: timestamp + 200, receivedTimestamp: timestamp + 210,
      marketDate: "2026-07-22", symbol: "SPY",
      data: { symbol: "SPY", timestamp: timestamp + 200, price, size: 100 },
    });
  }
  const summary = await receiver.restore(events);
  assert.equal(summary.events, events.length);
  assert.ok((summary.bars ?? 0) >= 3_000);
  assert.equal(summary.latestFeature?.openingRange.complete, true);
  assert.ok(summary.latestFeature?.vwap.sessionVwap !== undefined);
  assert.equal(callbackFeatures, 0);
  assert.equal(receiver.healthState().restoredStockEvents, events.length);
  assert.equal(receiver.healthState().receivedStockTrades, 0);
  await receiver.start();
  await receiver.close();
});

test("SPY SIP receiver buffers live events during restoration and suppresses stale catch-up decisions", async () => {
  const stream = new FakeStockStream();
  const start = zonedDateTimeToEpoch("2026-07-22", "10:20:00");
  let featureCallbacks = 0;
  const receiver = new SpySipReceiver({
    config: defaultConfig,
    stream,
    now: () => start + 3_000,
    flushIntervalMs: 60_000,
    onFeature: () => { featureCallbacks += 1; },
  });
  await receiver.startBuffered();
  await stream.quote({
    symbol: "SPY", timestamp: start + 100, bidPrice: 500, askPrice: 500.01, bidSize: 100, askSize: 100,
  });
  await stream.trade({ symbol: "SPY", timestamp: start + 200, price: 500.005, size: 10 });
  await stream.quote({
    symbol: "SPY", timestamp: start + 1_100, bidPrice: 500.01, askPrice: 500.02, bidSize: 100, askSize: 100,
  });
  assert.equal(receiver.healthState().receivedStockQuotes, 0);
  const catchup = await receiver.activate();
  assert.equal(catchup.events, 3);
  assert.equal(catchup.bars, 1);
  assert.equal(featureCallbacks, 0);
  assert.equal(receiver.healthState().receivedStockQuotes, 2);
  assert.equal(receiver.healthState().completedBars, 1);
  await stream.quote({
    symbol: "SPY", timestamp: start + 2_100, bidPrice: 500.02, askPrice: 500.03, bidSize: 100, askSize: 100,
  });
  assert.equal(featureCallbacks, 1);
  await receiver.close();
});
