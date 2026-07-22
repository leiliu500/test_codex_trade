import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import { StockQuoteSanitizer } from "../src/features/quoteSanitizer.js";
import { SecondAggregator } from "../src/features/secondAggregator.js";
import { orderFlowImbalanceEvent } from "../src/features/quoteMath.js";
import { buildCalibrationProfile, CalibrationResolver } from "../src/features/calibration.js";
import { zonedDateTimeToEpoch } from "../src/utils/time.js";

const quote = (timestamp: number, bid = 500, ask = 500.01, bidSize = 100, askSize = 100) => ({
  symbol: "SPY" as const, timestamp, bidPrice: bid, askPrice: ask, bidSize, askSize,
});

test("quote sanitizer rejects invalid, duplicate, out-of-order and excessive spread", () => {
  const sanitizer = new StockQuoteSanitizer(defaultConfig.dataQuality);
  assert.equal(sanitizer.sanitize(quote(1_000)).usable, true);
  assert.deepEqual(sanitizer.sanitize(quote(1_000)).reasons, ["DUPLICATE"]);
  assert.deepEqual(sanitizer.sanitize(quote(999)).reasons, ["OUT_OF_ORDER"]);
  assert.equal(sanitizer.sanitize(quote(2_000, 500, 501)).reasons.includes("SPREAD_TOO_WIDE"), true);
  assert.equal(sanitizer.sanitize(quote(3_000, 500, 500)).reasons.includes("LOCKED_OR_CROSSED"), true);
});

test("one-second aggregation uses medians, VWAP, OFI and qualified forward fill", () => {
  const aggregator = new SecondAggregator(defaultConfig.dataQuality);
  aggregator.ingestQuote(quote(100, 500, 500.01, 200, 100));
  aggregator.ingestQuote(quote(200, 500.01, 500.02, 300, 100));
  aggregator.ingestQuote(quote(300, 500.02, 500.03, 400, 100));
  aggregator.ingestTrade({ symbol: "SPY", timestamp: 400, price: 500.01, size: 100 });
  aggregator.ingestTrade({ symbol: "SPY", timestamp: 500, price: 500.03, size: 300 });
  const bars = aggregator.flushThrough(3_000);
  assert.equal(bars.length, 3);
  assert.equal(bars[0]!.quoteCount, 3);
  assert.ok(Math.abs(bars[0]!.tradeVwap! - 500.025) < 1e-10);
  assert.ok(bars[0]!.ofiRaw !== 0);
  assert.equal(bars[1]!.quoteCount, 0);
  assert.equal(bars[1]!.microprice, bars[0]!.microprice);
  assert.ok(bars[2]!.quoteAgeMs > defaultConfig.dataQuality.maxStockQuoteAgeMs);
});

test("OFI event follows the specified bid/ask transition equation", () => {
  const previous = quote(1, 100, 100.02, 10, 20);
  const current = quote(2, 100.01, 100.02, 15, 5);
  // bid improvement +15; unchanged ask contributes -current(5)+previous(20).
  assert.equal(orderFlowImbalanceEvent(previous, current), 30);
});

test("calibration uses nearest-rank buckets and refuses same/future-session leakage", () => {
  const timestamp = zonedDateTimeToEpoch("2026-03-02", "10:16:00");
  const observations = Array.from({ length: 30 }, (_, index) => ({
    timestamp: timestamp + index,
    marketDate: "2026-03-02",
    fastSlopeMagnitude: index + 1,
    fastAccelerationMagnitude: index + 1,
    ofi5Magnitude: index + 1,
    efficiency60: (index + 1) / 100,
    rv30: index + 1,
    volume60: index + 1,
  }));
  const profile = buildCalibrationProfile(observations, {
    version: "v1", trainingStartDate: "2026-03-02", trainingEndDate: "2026-03-02",
    sourceDataVersion: "data", parameterHash: "hash",
  });
  const resolver = new CalibrationResolver(defaultConfig, profile);
  assert.equal(resolver.thresholds(timestamp, "2026-03-02").source, "static");
  const historical = resolver.thresholds(timestamp, "2026-03-03");
  assert.equal(historical.source, "calibrated");
  assert.equal(historical.fastSlope, 21);
  assert.ok(Math.abs((resolver.rvPercentile(timestamp, "2026-03-03", 24) ?? 0) - 0.8) < 1e-9);
});
