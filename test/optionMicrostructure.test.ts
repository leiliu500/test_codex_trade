import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import { OptionBook } from "../src/options/optionBook.js";
import {
  OptionMicrostructureEngine, optionTradeFlowDisposition,
} from "../src/options/optionMicrostructure.js";
import { OptionSelector } from "../src/options/optionSelector.js";
import type { FeatureSnapshot, OptionContract, TradeSignal } from "../src/types.js";
import { zonedDateTimeToEpoch } from "../src/utils/time.js";

const symbol = "SPY260811C00640000";

test("Massive Q/T/A events form a causal bullish option-flow snapshot", () => {
  const engine = new OptionMicrostructureEngine(5_000);
  assert.equal(engine.observeQuote({
    symbol, timestamp: 1_000, bidPrice: 1, askPrice: 1.10, bidSize: 20, askSize: 20,
    sequenceNumber: 1,
  }), true);
  assert.equal(engine.observeQuote({
    symbol, timestamp: 1_100, bidPrice: 1.03, askPrice: 1.10, bidSize: 40, askSize: 10,
    sequenceNumber: 2,
  }), true);
  assert.equal(engine.observeTrade({
    symbol, timestamp: 1_150, price: 1.10, size: 12, exchange: "312", sequenceNumber: 3,
  }), true);
  assert.equal(engine.observeAggregate({
    symbol, startTimestamp: 1_000, endTimestamp: 1_999,
    open: 1.02, high: 1.10, low: 1.02, close: 1.10, volume: 12, vwap: 1.09,
  }), true);

  const snapshot = engine.snapshot(symbol, 2_000)!;
  assert.equal(snapshot.quoteEvents, 2);
  assert.equal(snapshot.tradeEvents, 1);
  assert.equal(snapshot.qualifiedTradeEvents, 1);
  assert.equal(snapshot.directionalTradeEvents, 1);
  assert.equal(snapshot.excludedTradeEvents, 0);
  assert.equal(snapshot.buyVolume, 12);
  assert.equal(snapshot.sellVolume, 0);
  assert.equal(snapshot.excludedTradeVolume, 0);
  assert.equal(snapshot.tradeImbalance, 1);
  assert.ok(snapshot.quoteOfi > 0);
  assert.ok(snapshot.premiumMomentumBps > 0);
  assert.ok(snapshot.microprice! > snapshot.mid!);
  assert.equal(snapshot.aggregateVwap, 1.09);
  assert.ok(snapshot.confirmationScore > 0);
  assert.equal(snapshot.dataFresh, true);
});

test("Massive OPRA conditions keep stale and package prints out of directional flow", () => {
  const engine = new OptionMicrostructureEngine(5_000);
  engine.observeQuote({
    symbol, timestamp: 1_000, bidPrice: 1, askPrice: 1.10, bidSize: 20, askSize: 20,
    sequenceNumber: 1,
  });
  assert.equal(optionTradeFlowDisposition({ conditions: [209] }), "directional");
  assert.equal(optionTradeFlowDisposition({ conditions: [233] }), "neutral");
  assert.equal(optionTradeFlowDisposition({ conditions: [202] }), "excluded");
  assert.equal(optionTradeFlowDisposition({ correction: 1 }), "excluded");
  assert.equal(engine.observeTrade({
    symbol, timestamp: 1_100, price: 1.10, size: 10, conditions: [209], sequenceNumber: 10,
  }), true);
  assert.equal(engine.observeTrade({
    symbol, timestamp: 1_110, price: 1.10, size: 30, conditions: [233], sequenceNumber: 11,
  }), true);
  assert.equal(engine.observeTrade({
    symbol, timestamp: 1_120, price: 1.10, size: 50, conditions: [202], sequenceNumber: 12,
  }), true);
  assert.equal(engine.observeTrade({
    symbol, timestamp: 1_130, price: 1.10, size: 5, conditions: [209], sequenceNumber: 11,
  }), false);

  const snapshot = engine.snapshot(symbol, 1_200)!;
  assert.equal(snapshot.tradeEvents, 3);
  assert.equal(snapshot.qualifiedTradeEvents, 2);
  assert.equal(snapshot.directionalTradeEvents, 1);
  assert.equal(snapshot.excludedTradeEvents, 1);
  assert.equal(snapshot.buyVolume, 10);
  assert.equal(snapshot.neutralVolume, 30);
  assert.equal(snapshot.excludedTradeVolume, 50);
  assert.equal(snapshot.tradeVolume, 40);
  assert.equal(snapshot.tradeImbalance, 0.25);
});

test("option flow ignores duplicates and never uses future events in an earlier snapshot", () => {
  const engine = new OptionMicrostructureEngine(5_000);
  const quote = {
    symbol, timestamp: 2_000, bidPrice: 1, askPrice: 1.02, bidSize: 10, askSize: 10,
    sequenceNumber: 10,
  } as const;
  assert.equal(engine.observeQuote(quote), true);
  assert.equal(engine.observeQuote(quote), false);
  assert.equal(engine.observeQuote({ ...quote, timestamp: 2_001, sequenceNumber: 9 }), false);
  engine.observeQuote({
    symbol, timestamp: 3_000, bidPrice: 1.10, askPrice: 1.12, bidSize: 30, askSize: 5,
    sequenceNumber: 11,
  });

  const earlier = engine.snapshot(symbol, 2_500)!;
  assert.equal(earlier.quoteTimestamp, 2_000);
  assert.equal(earlier.mid, 1.01);
  assert.equal(earlier.quoteEvents, 1);
  assert.equal(engine.snapshot(symbol, 8_001)?.dataFresh, false);
});

test("production option selection rejects adverse contract and chain microstructure", () => {
  const timestamp = zonedDateTimeToEpoch("2026-08-11", "10:20:00");
  const contract: OptionContract = {
    symbol, underlying: "SPY", expirationDate: "2026-08-11", strike: 640,
    type: "call", active: true, tradable: true,
  };
  const book = new OptionBook(defaultConfig.options.microstructure.windowSec * 1_000);
  book.upsertContract(contract);
  book.updateSnapshot({
    symbol, timestamp: timestamp - 1_000, impliedVolatility: 0.22,
    greeks: { delta: 0.52, gamma: 0.02, theta: -1, vega: 0.04 },
    dailyVolume: 2_000, openInterest: 5_000,
  });
  book.updateQuote({
    symbol, timestamp: timestamp - 100, bidPrice: 2, askPrice: 2.02,
    bidSize: 10, askSize: 40, sequenceNumber: 1,
  });
  book.updateQuote({
    symbol, timestamp, bidPrice: 1.90, askPrice: 1.92,
    bidSize: 5, askSize: 50, sequenceNumber: 2,
  });
  book.updateTrade({
    symbol, timestamp, price: 1.90, size: 20, sequenceNumber: 3,
  });
  const signal: TradeSignal = {
    id: "adverse-option-flow", timestamp, direction: "BULLISH", kind: "IMPULSE",
    regime: "STRONG_UP", projectedMoveBps: 12, votes: [], reasons: [],
    featureSnapshot: { symbol: "SPY", timestamp, price: 640 } as FeatureSnapshot,
  };

  const result = new OptionSelector(defaultConfig).select(signal, [contract], book, timestamp);
  assert.equal(result.selected, undefined);
  assert.ok(result.evaluations[0]?.rejectionReasons.includes("OPTION_MICROSTRUCTURE_ADVERSE"));
  assert.ok(result.evaluations[0]?.rejectionReasons.includes("CHAIN_MICROSTRUCTURE_ADVERSE"));
});
