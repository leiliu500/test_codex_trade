import test from "node:test";
import assert from "node:assert/strict";
import { AlpacaOptionFeatureEngine } from "../src/alpaca/optionFeatures.js";
import type { OptionQuote, OptionTrade } from "../src/types.js";

const symbol = "SPY260822C00500000";
const timestamp = Date.parse("2026-08-22T14:30:00Z");

test("Alpaca option features confirm rising premium with bid depth and buyer-initiated trades", () => {
  const engine = new AlpacaOptionFeatureEngine({ windowMs: 5_000, maximumQuoteAgeMs: 2_000 });
  assert.equal(engine.observeQuote(quote(timestamp, 1, 1.04, 30, 70)), true);
  assert.equal(engine.observeQuote(quote(timestamp + 1_000, 1.01, 1.05, 80, 30)), true);
  assert.equal(engine.observeTrade(trade(timestamp + 1_000, 1.05, 50)), true);
  assert.equal(engine.observeQuote(quote(timestamp + 2_000, 1.03, 1.06, 120, 20)), true);
  assert.equal(engine.observeTrade(trade(timestamp + 2_000, 1.06, 75)), true);

  const features = engine.snapshot(symbol, timestamp + 2_100)!;
  assert.equal(features.dataFresh, true);
  assert.equal(features.quoteEvents, 3);
  assert.equal(features.tradeEvents, 2);
  assert.equal(features.buyVolume, 125);
  assert.equal(features.sellVolume, 0);
  assert.ok(features.quoteImbalance > 0);
  assert.ok(features.quoteOfi > 0);
  assert.ok(features.premiumMomentumBps > 0);
  assert.ok(features.confirmationScore > 0);
});

test("Alpaca option features detect seller pressure, bid deterioration, and spread expansion", () => {
  const engine = new AlpacaOptionFeatureEngine({ windowMs: 5_000, maximumQuoteAgeMs: 2_000 });
  engine.observeQuote(quote(timestamp, 1.02, 1.04, 80, 30));
  engine.observeQuote(quote(timestamp + 1_000, 1, 1.04, 30, 90));
  engine.observeTrade(trade(timestamp + 1_000, 1, 40));
  engine.observeQuote(quote(timestamp + 2_000, 0.97, 1.05, 15, 120));
  engine.observeTrade(trade(timestamp + 2_000, 0.97, 80));

  const features = engine.snapshot(symbol, timestamp + 2_100)!;
  assert.equal(features.sellVolume, 120);
  assert.equal(features.buyVolume, 0);
  assert.ok(features.spreadExpansionRatio > 1);
  assert.ok(features.bidMomentumBps < 0);
  assert.ok(features.confirmationScore < 0);
});

test("Alpaca snapshot bars and VWAP contribute causally while stale quotes disable evidence", () => {
  const engine = new AlpacaOptionFeatureEngine({ windowMs: 5_000, maximumQuoteAgeMs: 2_000 });
  const latestQuote = quote(timestamp, 1, 1.02, 50, 50);
  engine.observeSnapshot({
    symbol,
    timestamp,
    latestQuote,
    latestTrade: trade(timestamp, 1, 10),
    minuteBar: {
      timestamp: timestamp - 60_000, open: 0.98, high: 1.03, low: 0.97, close: 1.01,
      volume: 100, tradeCount: 20, vwap: 1,
    },
    dailyBar: {
      timestamp: timestamp - 3_600_000, open: 0.8, high: 1.1, low: 0.7, close: 1.01,
      volume: 500, tradeCount: 80, vwap: 0.95,
    },
    previousDailyBar: {
      timestamp: timestamp - 86_400_000, open: 0.7, high: 0.9, low: 0.6, close: 0.8,
      volume: 400, tradeCount: 60, vwap: 0.75,
    },
  });
  assert.equal(engine.observeQuote(latestQuote), false, "duplicate snapshot quote is ignored");

  const fresh = engine.snapshot(symbol, timestamp + 1_000)!;
  assert.equal(fresh.dataFresh, true);
  assert.ok(fresh.minuteBarReturnBps! > 0);
  assert.ok(fresh.dailyBarReturnBps! > 0);
  assert.ok(fresh.vwapDisplacementBps! > 0);
  assert.equal(engine.snapshot(symbol, timestamp + 2_001)!.dataFresh, false);
});

function quote(
  quoteTimestamp: number, bidPrice: number, askPrice: number, bidSize: number, askSize: number,
): OptionQuote {
  return { symbol, timestamp: quoteTimestamp, bidPrice, askPrice, bidSize, askSize };
}

function trade(tradeTimestamp: number, price: number, size: number): OptionTrade {
  return { symbol, timestamp: tradeTimestamp, price, size };
}
