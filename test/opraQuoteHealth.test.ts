import test from "node:test";
import assert from "node:assert/strict";
import {
  assessRestQuote,
  OpraQuoteHealthMonitor,
  parseRfc3339ToMs,
  StaleQuoteCircuitBreaker,
} from "../src/marketData/opraQuoteHealth.js";
import type { OptionQuote } from "../src/types.js";

function quote(symbol: string, timestamp: number, bidPrice = 1): OptionQuote {
  return {
    symbol, timestamp, bidPrice, askPrice: bidPrice + 0.01, bidSize: 10, askSize: 12,
    bidExchange: "C", askExchange: "H", conditions: ["B"],
  };
}

test("RFC-3339 option timestamps retain millisecond meaning when Alpaca supplies nanoseconds", () => {
  assert.equal(
    parseRfc3339ToMs("2026-08-10T13:41:11.791539496Z"),
    Date.parse("2026-08-10T13:41:11.791Z"),
  );
  assert.throws(() => parseRfc3339ToMs("not-a-timestamp"), /Invalid RFC-3339/);
});

test("OPRA health separates no data, fresh data, exact-contract inactivity, and transport silence", () => {
  const monitor = new OpraQuoteHealthMonitor({
    executionMaxQuoteAgeMs: 2_000,
    transportTimeoutMs: 10_000,
  });
  monitor.reset(0);
  assert.equal(monitor.diagnose("SPY1", 1_000_000, 100).diagnosis, "NO_DATA");

  monitor.onWebSocketQuote({
    quote: quote("SPY1", 1_000_000), receiveWallTimestamp: 1_000_050, receiveMonotonicTimestamp: 200,
  });
  const healthy = monitor.diagnose("SPY1", 1_000_100, 250);
  assert.equal(healthy.diagnosis, "HEALTHY");
  assert.equal(healthy.entryEligible, true);
  assert.equal(healthy.latestProviderAgeMs, 100);

  monitor.onAnyFrame(2_500);
  const idle = monitor.diagnose("SPY1", 1_002_500, 2_500);
  assert.equal(idle.diagnosis, "CONTRACT_IDLE");
  assert.equal(idle.transportAgeMs, 0);
  assert.equal(idle.symbolReceiveAgeMs, 2_300);

  assert.equal(monitor.diagnose("SPY1", 1_013_000, 13_000).diagnosis, "TRANSPORT_DISCONNECTED");
});

test("newly arriving advancing old events diagnose provider delay only after sufficient samples", () => {
  const monitor = new OpraQuoteHealthMonitor({ executionMaxQuoteAgeMs: 2_000, minimumDelaySamples: 4 });
  monitor.reset(0);
  for (let index = 0; index < 3; index += 1) {
    const receiveWallTimestamp = 1_000_000 + index * 100;
    monitor.onWebSocketQuote({
      quote: quote("SPY1", receiveWallTimestamp - 20_000),
      receiveWallTimestamp,
      receiveMonotonicTimestamp: index * 100,
    });
  }
  assert.equal(monitor.diagnose("SPY1", 1_000_200, 200).diagnosis, "OLD_EVENT_ARRIVED");

  monitor.onWebSocketQuote({
    quote: quote("SPY1", 980_300), receiveWallTimestamp: 1_000_300, receiveMonotonicTimestamp: 300,
  });
  const delayed = monitor.diagnose("SPY1", 1_000_300, 300);
  assert.equal(delayed.diagnosis, "PROVIDER_DELAYED");
  assert.equal(delayed.providerAdvanceRatio, 1);
  assert.equal(delayed.medianArrivalLagMs, 20_000);
  assert.equal(delayed.medianAbsoluteDeviationMs, 0);
  assert.equal(delayed.providerTimeVelocity, 1);
  assert.equal(delayed.lagSlope, 0);
  assert.equal(delayed.entryEligible, false);
});

test("chain diagnosis requires broad delayed evidence rather than one inactive contract", () => {
  const monitor = new OpraQuoteHealthMonitor({
    executionMaxQuoteAgeMs: 2_000,
    minimumDelaySamples: 4,
    minimumDelayedSymbols: 5,
    delayedSymbolFraction: 0.60,
  });
  monitor.reset(0);
  const symbols = new Set(Array.from({ length: 6 }, (_, index) => `SPY${index}`));
  for (const symbol of symbols) {
    for (let index = 0; index < 4; index += 1) {
      const receiveWallTimestamp = 1_000_000 + index * 100;
      monitor.onWebSocketQuote({
        quote: quote(symbol, receiveWallTimestamp - 15_000),
        receiveWallTimestamp,
        receiveMonotonicTimestamp: index * 100,
      });
    }
  }
  const health = monitor.summarize(symbols, 1_000_300, 300);
  assert.equal(health.diagnosis, "PROVIDER_DELAYED");
  assert.equal(health.delayedSymbolCount, 6);
  assert.equal(health.delayedSymbolFraction, 1);
  assert.equal(health.freshSymbolCount, 0);
  assert.equal(health.entryEligible, false);
});

test("same-provider REST assessment and circuit breaker stop repeated stale probes", () => {
  const stale = quote("SPY1", 1_000);
  const first = assessRestQuote(stale, 5_000, 2_000);
  const repeated = assessRestQuote({ ...stale }, 6_000, 2_000);
  assert.equal(first.fresh, false);
  assert.equal(first.providerAgeMs, 4_000);
  assert.equal(repeated.fingerprint, first.fingerprint);

  const circuit = new StaleQuoteCircuitBreaker({
    failureThreshold: 3, initialCooldownMs: 15_000, maximumCooldownMs: 30_000,
  });
  circuit.recordStaleOrRepeated(0);
  circuit.recordStaleOrRepeated(1);
  assert.equal(circuit.snapshot(2).state, "CLOSED");
  circuit.recordStaleOrRepeated(2);
  assert.equal(circuit.snapshot(2).state, "OPEN");
  assert.equal(circuit.canRequest(14_999), false);
  assert.equal(circuit.canRequest(15_002), true);
  assert.equal(circuit.snapshot(15_002).state, "HALF_OPEN");
  circuit.recordStaleOrRepeated(15_002);
  assert.equal(circuit.snapshot(15_002).cooldownMs, 30_000);
  circuit.recordSuccess();
  assert.equal(circuit.snapshot(15_003).state, "CLOSED");
});
