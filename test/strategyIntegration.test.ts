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
import { OpeningRangeTracker } from "../src/features/openingRange.js";
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

const immediateSignalConfig = structuredClone(defaultConfig);
immediateSignalConfig.signals.followThroughMinSec = 0;
immediateSignalConfig.signals.followThroughMaxSec = 0;
const enforcedSignalConfig = structuredClone(defaultConfig);
enforcedSignalConfig.signals.entryQualityMode = "ENFORCE";
const enforcedImmediateSignalConfig = structuredClone(enforcedSignalConfig);
enforcedImmediateSignalConfig.signals.followThroughMinSec = 0;
enforcedImmediateSignalConfig.signals.followThroughMaxSec = 0;

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
    const signal = new SignalEngine(immediateSignalConfig).evaluate(f, regime);
    assert.equal(signal?.kind, "IMPULSE");
    assert.equal(signal?.direction, direction > 0 ? "BULLISH" : "BEARISH");
    assert.equal(signal?.votes.filter((vote) => vote.passed).length, 4);
    assert.ok(signal!.projectedMoveBps > 0);
  }
});

test("late bullish impulses require an established up regime without blocking bearish impulses", () => {
  const lateBullish = {
    ...feature(1),
    timestamp: zonedDateTimeToEpoch("2026-07-22", "12:49:00"),
    vwap: { ...feature(1).vwap, rollingVwapSlopeBpsPerSec: -0.01 },
  };
  const unclassified: RegimeDecision = { regime: "UNCLASSIFIED", confidence: 0, reasons: [] };
  const blocked = new SignalEngine(immediateSignalConfig).evaluateDetailed(lateBullish, unclassified);
  assert.equal(blocked.signal, undefined);
  assert.ok(blocked.directions.find((item) => item.direction === "BULLISH")?.reasons
    .includes("LATE_BULLISH_IMPULSE_REQUIRES_UP_REGIME"));

  const confirmed: RegimeDecision = { regime: "STRONG_UP", confidence: 1, reasons: [] };
  assert.equal(new SignalEngine(immediateSignalConfig).evaluate(lateBullish, confirmed)?.kind, "IMPULSE");

  const lateBearish = {
    ...feature(-1),
    timestamp: zonedDateTimeToEpoch("2026-07-22", "12:49:00"),
  };
  assert.equal(new SignalEngine(immediateSignalConfig).evaluate(lateBearish, unclassified)?.direction, "BEARISH");
});

test("bullish impulses stop after 13:00 and all executable signals stop after 14:30 ET", () => {
  const unclassified: RegimeDecision = { regime: "STRONG_UP", confidence: 1, reasons: [] };
  const afterBullishCutoff = {
    ...feature(1),
    timestamp: zonedDateTimeToEpoch("2026-07-22", "13:00:01"),
  };
  assert.equal(new SignalEngine(immediateSignalConfig).evaluate(afterBullishCutoff, unclassified)?.direction, "BULLISH");
  const bullish = new SignalEngine(enforcedImmediateSignalConfig).evaluateDetailed(afterBullishCutoff, unclassified);
  assert.equal(bullish.signal, undefined);
  assert.ok(bullish.directions.find((item) => item.direction === "BULLISH")?.reasons
    .includes("BULLISH_IMPULSE_CUTOFF_PASSED"));

  const bearishFeature = {
    ...feature(-1),
    timestamp: afterBullishCutoff.timestamp,
  };
  assert.equal(new SignalEngine(enforcedImmediateSignalConfig).evaluate(
    bearishFeature, { regime: "STRONG_DOWN", confidence: 1, reasons: [] },
  )?.direction, "BEARISH");

  const afterEntryCutoff = { ...feature(1), timestamp: zonedDateTimeToEpoch("2026-07-22", "14:30:01") };
  const cutoff = new SignalEngine(enforcedImmediateSignalConfig).evaluateDetailed(afterEntryCutoff, unclassified);
  assert.equal(cutoff.signal, undefined);
  assert.ok(cutoff.reasons.includes("ZERO_DTE_ENTRY_CUTOFF_PASSED"));
});

test("causal follow-through confirms only aligned movement observed 5-15 seconds later", () => {
  const winnerEngine = new SignalEngine(enforcedSignalConfig);
  const first = feature(1);
  const regime: RegimeDecision = { regime: "STRONG_UP", confidence: 1, reasons: [] };
  const armed = winnerEngine.evaluateDetailed(first, regime);
  assert.equal(armed.signal, undefined);
  assert.deepEqual(armed.reasons, ["FOLLOW_THROUGH_PENDING"]);
  assert.equal(winnerEngine.evaluate({ ...first, timestamp: first.timestamp + 4_000, price: 501.01 }, regime), undefined);
  const confirmed = winnerEngine.evaluateDetailed(
    { ...first, timestamp: first.timestamp + 5_000, price: 501.02 }, regime,
  );
  assert.equal(confirmed.signal?.timestamp, first.timestamp + 5_000);
  assert.ok(confirmed.signal?.reasons.some((reason) => reason.includes("causal follow-through confirmed")));

  const loserEngine = new SignalEngine(enforcedSignalConfig);
  assert.equal(loserEngine.evaluate(first, regime), undefined);
  assert.equal(loserEngine.evaluate(
    { ...first, timestamp: first.timestamp + 5_000, price: 500.99 }, regime,
  ), undefined);
  const failed = loserEngine.evaluateDetailed(
    { ...first, timestamp: first.timestamp + 15_000, price: 500.98 }, regime,
  );
  assert.equal(failed.signal, undefined);
  assert.deepEqual(failed.reasons, ["FOLLOW_THROUGH_FAILED"]);
});

test("default execution is immediate while enforced A/B profiles confirm selected scopes", () => {
  const bearish = feature(-1);
  const down: RegimeDecision = { regime: "STRONG_DOWN", confidence: 1, reasons: [] };
  assert.equal(new SignalEngine(defaultConfig).evaluate(bearish, down)?.direction, "BEARISH");
  const bullish = feature(1);
  const up: RegimeDecision = { regime: "STRONG_UP", confidence: 1, reasons: [] };
  assert.equal(new SignalEngine(defaultConfig).evaluate(bullish, up)?.direction, "BULLISH");

  const bullishOnly = new SignalEngine(enforcedSignalConfig).evaluateDetailed(bullish, up);
  assert.equal(bullishOnly.signal, undefined);
  assert.deepEqual(bullishOnly.reasons, ["FOLLOW_THROUGH_PENDING"]);
  assert.equal(new SignalEngine(enforcedSignalConfig).evaluate(bearish, down)?.direction, "BEARISH");

  const allEntryConfig = structuredClone(defaultConfig);
  allEntryConfig.signals.entryQualityMode = "ENFORCE";
  allEntryConfig.signals.followThroughScope = "ALL";
  const shadow = new SignalEngine(allEntryConfig).evaluateDetailed(bearish, down);
  assert.equal(shadow.signal, undefined);
  assert.deepEqual(shadow.reasons, ["FOLLOW_THROUGH_PENDING"]);
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
  assert.equal(new SignalEngine(immediateSignalConfig).evaluate(grindFeature, regime)?.kind, "GRIND");
  const adverse = { ...grindFeature, fast: { ...grindFeature.fast, normalizedAcceleration: -0.46 } };
  assert.equal(new SignalEngine(immediateSignalConfig).evaluate(adverse, regime), undefined);
});

test("global gates block stale data, whipsaw, time violations, and cooldown only after entry", () => {
  const base = feature();
  const engine = new SignalEngine(immediateSignalConfig);
  assert.equal(engine.evaluate({ ...base, dataValid: false }, classifyRegime(base, defaultConfig.regimes)), undefined);
  assert.equal(engine.evaluate(base, { regime: "HIGH_VOL_WHIPSAW", confidence: 1, reasons: [] }), undefined);
  const outside = { ...base, timestamp: zonedDateTimeToEpoch("2026-07-22", "15:31:00") };
  assert.equal(new SignalEngine(immediateSignalConfig).evaluate(outside, classifyRegime(outside, defaultConfig.regimes)), undefined);
  const first = new SignalEngine(immediateSignalConfig);
  assert.ok(first.evaluate(base, classifyRegime(base, defaultConfig.regimes)));
  // A candidate alone does not start the 600-second entry cooldown; a new engine timestamp after signal interval can emit.
  const later = { ...base, timestamp: base.timestamp + 6_000 };
  assert.ok(first.evaluate(later, classifyRegime(later, defaultConfig.regimes)));
  first.recordEntry("BULLISH", later.timestamp);
  assert.equal(first.evaluate({ ...later, timestamp: later.timestamp + 6_000 }, classifyRegime(later, defaultConfig.regimes)), undefined);
});

test("opening range cannot become complete from a late-started partial session", () => {
  const tracker = new OpeningRangeTracker(defaultConfig);
  tracker.update(zonedDateTimeToEpoch("2026-07-22", "10:06:53"), 501);
  tracker.update(zonedDateTimeToEpoch("2026-07-22", "10:14:59"), 502);
  const state = tracker.update(zonedDateTimeToEpoch("2026-07-22", "10:15:00"), 501.5);
  assert.equal(state.complete, false);
});

test("restored entry and signal timestamps preserve restart cooldowns", () => {
  const base = feature();
  const engine = new SignalEngine(immediateSignalConfig);
  engine.restoreState({
    lastSignalTimestamp: base.timestamp - 1_000,
    lastEntries: { BULLISH: base.timestamp - 1_000 },
  });
  const evaluation = engine.evaluateDetailed(base, classifyRegime(base, defaultConfig.regimes));
  assert.ok(evaluation.reasons.includes("MINIMUM_SIGNAL_INTERVAL"));
});

test("feature checkpoint restores exact opening range while trade-only history rebuilds session VWAP", () => {
  const checkpoint = feature();
  const engine = new FeatureEngine(defaultConfig);
  engine.restoreCheckpoint(checkpoint);
  const tradeOnlyTimestamp = zonedDateTimeToEpoch("2026-07-22", "10:18:00");
  assert.equal(engine.onBar({
    timestamp: tradeOnlyTimestamp,
    quoteCount: 0,
    quoteAgeMs: Number.POSITIVE_INFINITY,
    ofiRaw: 0,
    depthSum: 0,
    depthEventCount: 0,
    tradeVolume: 100,
    tradeVwap: 500,
  }), undefined);
  const restored = engine.onBar({
    timestamp: tradeOnlyTimestamp + 1_000,
    microprice: 501,
    mid: 501,
    quoteImbalance: 0,
    micropriceDisplacementBps: 0,
    bidPrice: 500.99,
    askPrice: 501.01,
    bidSize: 100,
    askSize: 100,
    quoteCount: 1,
    quoteAgeMs: 0,
    ofiRaw: 0,
    depthSum: 200,
    depthEventCount: 1,
    tradeVolume: 100,
    tradeVwap: 502,
  });
  assert.equal(restored?.openingRange.complete, true);
  assert.equal(restored?.openingRange.high, checkpoint.openingRange.high);
  assert.equal(restored?.openingRange.low, checkpoint.openingRange.low);
  assert.equal(restored?.vwap.sessionVwap, 501);
});

test("detailed signal evaluation reports global and directional block decisions", () => {
  const base = feature();
  const invalid = new SignalEngine(immediateSignalConfig).evaluateDetailed(
    { ...base, dataValid: false, invalidReasons: ["STALE_QUOTE"] },
    classifyRegime(base, defaultConfig.regimes),
  );
  assert.equal(invalid.passed, false);
  assert.ok(invalid.reasons.includes("STALE_QUOTE"));
  assert.equal(invalid.directions.length, 0);

  const mixed = {
    ...base,
    medium: { ...base.medium, normalizedSlope: -0.2 },
  };
  const directional = new SignalEngine(immediateSignalConfig).evaluateDetailed(
    mixed,
    classifyRegime(mixed, defaultConfig.regimes),
  );
  assert.equal(directional.passed, false);
  assert.ok(directional.directions.some((item) => item.direction === "BULLISH" &&
    item.reasons.includes("MEDIUM_SLOPE_MISALIGNED")));
});

test("option selector rejects wide cost and ranks an eligible liquid contract", () => {
  const f = feature();
  const signal = new SignalEngine(immediateSignalConfig).evaluate(f, classifyRegime(f, defaultConfig.regimes))!;
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

test("option selection uses an explicit causal decision timestamp", () => {
  const f = feature();
  const signal = new SignalEngine(immediateSignalConfig).evaluate(f, classifyRegime(f, defaultConfig.regimes))!;
  const contract: OptionContract = {
    symbol: "SPY260722C00501000", underlying: "SPY", expirationDate: "2026-07-22",
    strike: 501, type: "call", active: true, tradable: true,
  };
  const book = new OptionBook();
  book.upsertContract(contract);
  book.updateQuote({
    symbol: contract.symbol, timestamp: signal.timestamp + 100,
    bidPrice: 1.99, askPrice: 2.01, bidSize: 100, askSize: 100,
  });
  book.updateSnapshot({
    symbol: contract.symbol, timestamp: signal.timestamp,
    impliedVolatility: 0.22, greeks: { delta: 0.52, gamma: 0.02 }, dailyVolume: 1000, openInterest: 5000,
  });
  const selector = new OptionSelector(defaultConfig);
  const replayPinned = selector.select(signal, [contract], book);
  assert.equal(replayPinned.selected, undefined);
  assert.ok(replayPinned.evaluations[0]?.rejectionReasons.includes("QUOTE_FUTURE_QUOTE"));

  const liveDecision = selector.select(signal, [contract], book, signal.timestamp + 200);
  assert.equal(liveDecision.selected?.symbol, contract.symbol);
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
