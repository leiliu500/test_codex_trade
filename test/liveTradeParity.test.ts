import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import { replayLiveTradeManagement, type LiveManagementEvent } from "../src/backtest/liveTradeParity.js";
import type { OptionQuote, PositionState } from "../src/types.js";
import { zonedDateTimeToEpoch } from "../src/utils/time.js";

const entryTimestamp = zonedDateTimeToEpoch("2026-08-05", "10:00:00");
const symbol = "SPY260805C00774000";

test("live trade parity collapses an OPRA callback to its last accepted active quote", () => {
  const receivedTimestamp = entryTimestamp + 1_000;
  const events: LiveManagementEvent[] = [
    quoteEvent(1, receivedTimestamp, quote(receivedTimestamp - 3, 2.10, 2.12)),
    quoteEvent(2, receivedTimestamp, quote(receivedTimestamp - 2, 2.02, 2.04)),
    // Runtime rejects this later row because its provider timestamp goes backward.
    quoteEvent(3, receivedTimestamp, quote(receivedTimestamp - 4, 1.50, 1.52)),
    // A post-fill quote must not be used as the quote-at-fill P&L proxy.
    quoteEvent(4, entryTimestamp + 2_000, quote(entryTimestamp + 1_999, 1.90, 1.92)),
  ];

  const result = replayLiveTradeManagement({
    config: defaultConfig,
    sourceConfigVersion: defaultConfig.version,
    position: protectedWinner(),
    events,
    timerIntervalMs: 0,
    observedExit: {
      decisionTimestamp: receivedTimestamp + 1,
      fillTimestamp: receivedTimestamp + 350,
      fillPrice: 2.03,
      realizedPnl: 3,
      reason: "PROFIT_FLOOR_EXIT",
      submittedLimitPrice: 2.02,
      decisionExecutablePnl: 1.5,
      fillLatencyMs: 349,
    },
  });

  assert.equal(result.modeledExit?.timestamp, receivedTimestamp);
  assert.equal(result.modeledExit?.source, "OPTION_QUOTE");
  assert.equal(result.modeledExit?.reason, "PROFIT_FLOOR_EXIT");
  assert.equal(result.modeledExit?.quote.bidPrice, 2.02);
  assert.deepEqual(result.modeledExit?.triggers, ["PROFIT_FLOOR_BREACH"]);
  assert.equal(result.counts.optionQuoteRows, 4);
  assert.equal(result.counts.optionQuoteBatches, 2);
  assert.equal(result.counts.rejectedOptionQuotes, 1);
  assert.equal(result.counts.controllerEvaluations, 1);
  assert.equal(result.parity.reasonMatches, true);
  assert.equal(result.parity.decisionTimestampDeltaMs, -1);
  assert.ok(Math.abs(result.parity.decisionExecutablePnlDelta ?? Infinity) < 1e-9);
  assert.ok(Math.abs(result.parity.submittedLimitPriceDelta ?? Infinity) < 1e-9);
  assert.equal(result.pnl.observedBroker, 3);
  assert.ok(Math.abs((result.pnl.decisionExecutable ?? Infinity) - 1.5) < 1e-9);
  assert.ok(Math.abs((result.pnl.submittedLimit ?? Infinity) - 2) < 1e-9);
  assert.ok(Math.abs((result.pnl.quoteBidAtObservedFill ?? Infinity) - 2) < 1e-9);
});

test("live trade parity orders asynchronously flushed rows by receiver time", () => {
  const earlier = entryTimestamp + 1_000;
  const later = entryTimestamp + 2_000;
  const events: LiveManagementEvent[] = [
    quoteEvent(1, later, quote(later - 1, 2.20, 2.22)),
    quoteEvent(2, earlier, quote(earlier - 1, 2.02, 2.04)),
  ];

  const result = replayLiveTradeManagement({
    config: defaultConfig,
    position: protectedWinner(),
    events,
    timerIntervalMs: 0,
  });

  assert.equal(result.modeledExit?.timestamp, earlier);
  assert.equal(result.modeledExit?.quote.bidPrice, 2.02);
});

function protectedWinner(): PositionState {
  return {
    symbol,
    direction: "BULLISH",
    quantity: 1,
    averageEntryPrice: 2,
    entryTimestamp,
    stopPrice: 1.5,
    tradeState: "PROTECTED_WINNER",
    executablePnl: 10,
    highWaterPnl: 10,
    lowWaterPnl: 0,
    protectedFloorPnl: 2,
    lastPnlTimestamp: entryTimestamp,
    lastHighTimestamp: entryTimestamp,
    previousExecutablePnl: 10,
    pnlEwmaDriftPerSec: 0,
    pnlEwmaVariancePerSec: 0,
    reversalCusum: 0,
    zeroCrossings: 0,
    previousPnlSign: 1,
    pnlObservationCount: 2,
  };
}

function quote(timestamp: number, bidPrice: number, askPrice: number): OptionQuote {
  return { symbol, timestamp, bidPrice, askPrice, bidSize: 20, askSize: 20 };
}

function quoteEvent(
  sequence: number,
  receivedTimestamp: number,
  data: OptionQuote,
): LiveManagementEvent {
  return {
    sequence,
    type: "option_quote",
    receivedTimestamp,
    providerTimestamp: data.timestamp,
    data,
  };
}
