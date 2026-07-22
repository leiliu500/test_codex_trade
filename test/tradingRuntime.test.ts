import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import type { BrokerOrder, BrokerOrderRequest } from "../src/alpaca/restClient.js";
import type { StockStream, StockStreamHandlers } from "../src/alpaca/stockStream.js";
import type { OptionStream, OptionStreamHandlers } from "../src/alpaca/optionStream.js";
import type { SpyOptionsRuntimeClient } from "../src/runtime/spyOptionsTradingRuntime.js";
import { SpyOptionsTradingRuntime } from "../src/runtime/spyOptionsTradingRuntime.js";
import type {
  AccountState, FeatureSnapshot, OptionContract, OptionQuote, OptionSnapshot, PositionState, StockQuote,
  WindowMetrics,
} from "../src/types.js";
import { zonedDateTimeToEpoch } from "../src/utils/time.js";
import type { HistoricalMarketEvent, MarketHistorySink } from "../src/history/types.js";

const date = "2026-07-22";
const now = zonedDateTimeToEpoch(date, "10:20:00");
const callSymbol = "SPY260722C00501000";

class FakeStockStream implements StockStream {
  handlers: StockStreamHandlers | undefined;
  async connect(handlers: StockStreamHandlers): Promise<void> {
    this.handlers = handlers;
    handlers.onState?.(true);
  }
  async close(): Promise<void> { this.handlers?.onState?.(false); }
}

class FakeOptionStream implements OptionStream {
  handlers: OptionStreamHandlers | undefined;
  readonly subscribed = new Set<string>();
  async subscribe(symbols: readonly string[]): Promise<void> { for (const symbol of symbols) this.subscribed.add(symbol); }
  async unsubscribe(symbols: readonly string[]): Promise<void> { for (const symbol of symbols) this.subscribed.delete(symbol); }
  async connect(handlers: OptionStreamHandlers): Promise<void> {
    this.handlers = handlers;
    handlers.onState?.(true);
  }
  async close(): Promise<void> { this.handlers?.onState?.(false); }
  async quote(quote: OptionQuote): Promise<void> { await this.handlers?.onQuote(quote); }
}

class FakeHistory implements MarketHistorySink {
  readonly events: HistoricalMarketEvent[] = [];
  recordMarketEvent(event: HistoricalMarketEvent): void { this.events.push(event); }
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
  async getAccount(): Promise<AccountState> { return { ...this.account }; }
  async getMarketClock(): Promise<{ timestamp: number; isOpen: boolean }> { return { timestamp: now, isOpen: true }; }
  async getLatestSpySipQuote(): Promise<StockQuote> {
    return { symbol: "SPY", timestamp: now, bidPrice: 500.99, askPrice: 501.01, bidSize: 100, askSize: 100 };
  }
  async listOptionContracts(): Promise<OptionContract[]> { return [{ ...this.contract }]; }
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

test("end-to-end paper runtime arms SIP/OPRA and routes an eligible signal to a same-day SPY option order", async () => {
  const client = new FakeRuntimeClient();
  const stockStream = new FakeStockStream();
  const optionStream = new FakeOptionStream();
  const history = new FakeHistory();
  const runtime = new SpyOptionsTradingRuntime({
    config: defaultConfig, client, stockStream, optionStream, executionEnabled: true,
    executionMode: "paper", now: () => now, executionTickMs: 60_000, history,
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
  assert.ok(history.events.some((event) => event.type === "option_contract" && event.symbol === callSymbol));
  assert.ok(history.events.some((event) => event.type === "option_snapshot" && event.symbol === callSymbol));
  assert.equal(history.events.find((event) => event.type === "option_snapshot")?.marketDate, date);
  assert.ok(history.events.some((event) => event.type === "option_quote" && event.symbol === callSymbol));
  assert.ok(history.events.some((event) => event.type === "feature_snapshot" && event.symbol === "SPY"));
  await runtime.close();
});
