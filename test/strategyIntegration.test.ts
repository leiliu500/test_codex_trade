import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import type { FeatureSnapshot, OptionContract, RegimeDecision, SecondBar, TradeSignal, WindowMetrics } from "../src/types.js";
import { classifyRegime } from "../src/strategy/regimeClassifier.js";
import { SignalEngine } from "../src/strategy/signalEngine.js";
import { boundedProjectionBps } from "../src/strategy/projection.js";
import { classifyTrendPhase } from "../src/strategy/trendPhase.js";
import { OptionBook } from "../src/options/optionBook.js";
import { OptionSelector } from "../src/options/optionSelector.js";
import { FeatureEngine } from "../src/features/featureEngine.js";
import { zonedDateTimeToEpoch } from "../src/utils/time.js";

function windowMetric(windowSec: number, slope: number, acceleration: number, normalizedSlope: number, normalizedAcceleration: number): WindowMetrics {
  return {
    windowSec,
    regression: { valid: true, windowSec, pointCount: windowSec + 1, coverageFraction: 1,
      levelLog: Math.log(501), slopeBpsPerSec: slope, accelerationBpsPerSec2: acceleration, r2: 0.8,
      coefficients: [Math.log(501), slope * windowSec / 10_000, acceleration * windowSec ** 2 / 20_000] },
    realizedVolatilityBps: 2,
    efficiencyRatio: 0.6,
    noiseFloorBps: 2,
    normalizedSlope,
    normalizedAcceleration,
    signChanges: 0,
  };
}

function feature(direction: 1 | -1 = 1): FeatureSnapshot {
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "10:20:00");
  const price = direction > 0 ? 501 : 499;
  return {
    symbol: "SPY", timestamp, marketDate: "2026-07-22", price, mid: price,
    spreadBps: 0.2, quoteAgeMs: 100, quoteImbalance: 0.5 * direction,
    quoteImbalanceEwma5: 0.5 * direction, quoteImbalanceEwma15: 0.4 * direction,
    micropriceDisplacementBps: 0.1 * direction,
    ofi1: 0.1 * direction, ofi5: 0.2 * direction, ofi15: 0.1 * direction,
    volume60: 100_000,
    fast: windowMetric(10, 0.6 * direction, 0.02 * direction, 0.8 * direction, 0.2 * direction),
    medium: windowMetric(30, 0.2 * direction, 0, 0.6 * direction, 0),
    slow: windowMetric(120, 0.04 * direction, 0, 0.3 * direction, 0),
    efficiency60: 0.6, signChanges60: 0,
    vwap: { sessionVwap: 500, rollingVwap: 500.5, rollingVwapSlopeBpsPerSec: 0.05 * direction, anchoredVwaps: {} },
    openingRange: { complete: true, high: 500.8, low: 499.2, midpoint: 500, widthBps: 32,
      nearHigh: direction > 0, nearLow: direction < 0, bullishRetest: false, bearishRetest: false },
    thresholds: { source: "static", bucket: "10:20", sampleCount: 0, fastSlope: 0.42,
      fastAcceleration: 0.1, absoluteOfi5: 0.08, efficiency60: 0.28 },
    dataValid: true, invalidReasons: [],
  };
}

test("regime ordering distinguishes whipsaw, reversal, strong and grind", () => {
  const strong = feature();
  assert.equal(classifyRegime(strong, defaultConfig.regimes).regime, "STRONG_UP");
  const whipsaw = { ...strong, signChanges60: 5, efficiency60: 0.1 };
  assert.equal(classifyRegime(whipsaw, defaultConfig.regimes).regime, "HIGH_VOL_WHIPSAW");
  const reversal = { ...strong,
    slow: { ...strong.slow, normalizedSlope: -0.2 },
    medium: { ...strong.medium, normalizedSlope: 0.3 },
    fast: { ...strong.fast, normalizedAcceleration: 0.2 },
  };
  assert.equal(classifyRegime(reversal, defaultConfig.regimes).regime, "REVERSAL_UP");
  const grind = { ...strong,
    medium: { ...strong.medium, normalizedSlope: 0.3 }, slow: { ...strong.slow, normalizedSlope: 0.15 },
  };
  assert.equal(classifyRegime(grind, defaultConfig.regimes).regime, "GRIND_UP");
});

test("phase interpretation does not require positive acceleration in a mature trend", () => {
  assert.equal(classifyTrendPhase(1, 0), "UP_GRIND");
  assert.equal(classifyTrendPhase(1, -1), "UP_DECELERATING");
  assert.equal(classifyTrendPhase(-1, 0), "DOWN_GRIND");
});

test("bounded projection caps acceleration by velocity and RV", () => {
  const result = boundedProjectionBps(1, 10, 5, 4, 0.5);
  assert.equal(result.velocityContributionBps, 5);
  assert.equal(result.accelerationCapBps, 2);
  assert.equal(result.boundedAccelerationContributionBps, 2);
  assert.equal(result.projectedMoveBps, 7);
});

test("clean bullish/bearish opening-range impulses mirror direction", () => {
  for (const direction of [1, -1] as const) {
    const f = feature(direction);
    const regime = classifyRegime(f, defaultConfig.regimes);
    const signal = new SignalEngine(defaultConfig).evaluate(f, regime);
    assert.equal(signal?.kind, "IMPULSE");
    assert.equal(signal?.direction, direction > 0 ? "BULLISH" : "BEARISH");
    assert.equal(signal?.votes.filter((vote) => vote.passed).length, 4);
    assert.ok(signal!.projectedMoveBps > 0);
  }
});

test("steady grind passes with acceleration near zero, but excessive adverse acceleration blocks", () => {
  const base = feature();
  const grindFeature: FeatureSnapshot = {
    ...base,
    fast: { ...base.fast, normalizedSlope: 0.1, normalizedAcceleration: 0,
      regression: { ...base.fast.regression, slopeBpsPerSec: 0.4, accelerationBpsPerSec2: 0 } },
    medium: { ...base.medium, normalizedSlope: 0.30 },
    slow: { ...base.slow, normalizedSlope: 0.15 },
    micropriceDisplacementBps: -0.1,
    ofi5: 0,
  };
  const regime = classifyRegime(grindFeature, defaultConfig.regimes);
  assert.equal(new SignalEngine(defaultConfig).evaluate(grindFeature, regime)?.kind, "GRIND");
  const adverse = { ...grindFeature, fast: { ...grindFeature.fast, normalizedAcceleration: -0.46 } };
  assert.equal(new SignalEngine(defaultConfig).evaluate(adverse, regime), undefined);
});

test("global gates block stale data, whipsaw, time violations, and cooldown only after entry", () => {
  const base = feature();
  const engine = new SignalEngine(defaultConfig);
  assert.equal(engine.evaluate({ ...base, dataValid: false }, classifyRegime(base, defaultConfig.regimes)), undefined);
  assert.equal(engine.evaluate(base, { regime: "HIGH_VOL_WHIPSAW", confidence: 1, reasons: [] }), undefined);
  const outside = { ...base, timestamp: zonedDateTimeToEpoch("2026-07-22", "15:31:00") };
  assert.equal(new SignalEngine(defaultConfig).evaluate(outside, classifyRegime(outside, defaultConfig.regimes)), undefined);
  const first = new SignalEngine(defaultConfig);
  assert.ok(first.evaluate(base, classifyRegime(base, defaultConfig.regimes)));
  // A candidate alone does not start the 600-second entry cooldown; a new engine timestamp after signal interval can emit.
  const later = { ...base, timestamp: base.timestamp + 6_000 };
  assert.ok(first.evaluate(later, classifyRegime(later, defaultConfig.regimes)));
  first.recordEntry("BULLISH", later.timestamp);
  assert.equal(first.evaluate({ ...later, timestamp: later.timestamp + 6_000 }, classifyRegime(later, defaultConfig.regimes)), undefined);
});

test("option selector rejects wide cost and ranks an eligible liquid contract", () => {
  const f = feature();
  const signal = new SignalEngine(defaultConfig).evaluate(f, classifyRegime(f, defaultConfig.regimes))!;
  const expirationDate = "2026-07-22";
  const good: OptionContract = { symbol: "SPY260722C00501000", underlying: "SPY", expirationDate, strike: 501, type: "call", active: true, tradable: true };
  const bad: OptionContract = { ...good, symbol: "SPY260722C00502000", strike: 502 };
  const book = new OptionBook();
  for (const contract of [good, bad]) book.upsertContract(contract);
  book.updateQuote({ symbol: good.symbol, timestamp: signal.timestamp, bidPrice: 1.99, askPrice: 2.01, bidSize: 100, askSize: 100 });
  book.updateSnapshot({ symbol: good.symbol, timestamp: signal.timestamp, impliedVolatility: 0.22, greeks: { delta: 0.52, gamma: 0.02 }, dailyVolume: 1000, openInterest: 5000 });
  book.updateQuote({ symbol: bad.symbol, timestamp: signal.timestamp, bidPrice: 1.60, askPrice: 2.20, bidSize: 100, askSize: 100 });
  book.updateSnapshot({ symbol: bad.symbol, timestamp: signal.timestamp, impliedVolatility: 0.22, greeks: { delta: 0.52, gamma: 0.02 }, dailyVolume: 1000, openInterest: 5000 });
  const selection = new OptionSelector(defaultConfig).select(signal, [bad, good], book);
  assert.equal(selection.selected?.symbol, good.symbol);
  assert.ok(selection.evaluations.find((item) => item.symbol === bad.symbol)!.rejectionReasons.includes("QUOTE_SPREAD_TOO_WIDE"));
  const laterDated = { ...good, symbol: "SPY260724C00501000", expirationDate: "2026-07-24" };
  assert.ok(new OptionSelector(defaultConfig).evaluate(laterDated, undefined, signal).rejectionReasons.includes("NOT_SAME_DAY_EXPIRATION"));
});

test("feature engine produces causal valid 10/30/120-second state after coverage", () => {
  const engine = new FeatureEngine(defaultConfig);
  const open = zonedDateTimeToEpoch("2026-07-22", "09:30:00");
  engine.onBar(bar(open + 1000, 500));
  const start = zonedDateTimeToEpoch("2026-07-22", "10:13:00");
  let result: FeatureSnapshot | undefined;
  for (let index = 0; index <= 130; index += 1) result = engine.onBar(bar(start + index * 1000, 500 + index * 0.003));
  assert.ok(result);
  assert.equal(result!.fast.regression.valid, true);
  assert.equal(result!.medium.regression.valid, true);
  assert.equal(result!.slow.regression.valid, true);
  assert.equal(result!.openingRange.complete, true);
  assert.ok(result!.fast.normalizedSlope > 0);
});

function bar(timestamp: number, price: number): SecondBar {
  return {
    timestamp, microprice: price, mid: price, quoteImbalance: 0.2, micropriceDisplacementBps: 0.01,
    bidPrice: price - 0.005, askPrice: price + 0.005, bidSize: 200, askSize: 100,
    quoteCount: 1, quoteAgeMs: 100, ofiRaw: 10, depthSum: 300, depthEventCount: 1,
    tradeVolume: 100, tradeVwap: price,
  };
}
