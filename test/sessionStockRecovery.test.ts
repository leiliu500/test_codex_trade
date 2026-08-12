import assert from "node:assert/strict";
import test from "node:test";
import {
  streamSessionStockRecovery,
  type SessionStockFallback,
} from "../src/history/sessionStockRecovery.js";
import type { HistoricalMarketEvent } from "../src/history/types.js";

function quote(timestamp: number): HistoricalMarketEvent {
  return {
    type: "stock_quote",
    providerTimestamp: timestamp,
    receivedTimestamp: timestamp,
    marketDate: "2026-08-12",
    symbol: "QQQ",
    data: { symbol: "QQQ", timestamp, bidPrice: 500, askPrice: 500.02, bidSize: 10, askSize: 10 },
  };
}

async function* source(batches: readonly (readonly HistoricalMarketEvent[])[]) {
  for (const batch of batches) yield batch;
}

test("session recovery prepends the missing opening prefix before late database events", async () => {
  const open = Date.parse("2026-08-12T13:30:00.000Z");
  const late = Date.parse("2026-08-12T16:41:29.000Z");
  const calls: Array<{ start: number; end: number; sample: number }> = [];
  const fallback: SessionStockFallback = {
    async *streamStockEvents(_symbol, start, end, sample) {
      calls.push({ start, end, sample });
      yield [quote(open + 100)];
    },
  };
  const output: HistoricalMarketEvent[] = [];
  for await (const batch of streamSessionStockRecovery({
    primary: source([[quote(late)]]),
    fallback,
    symbol: "QQQ",
    startTimestamp: open,
    endTimestamp: late + 60_000,
    quoteSampleIntervalMs: 250,
  })) output.push(...batch);

  assert.deepEqual(calls, [{ start: open, end: late, sample: 250 }]);
  assert.deepEqual(output.map((event) => event.providerTimestamp), [open + 100, late]);
});

test("session recovery leaves complete opening history untouched", async () => {
  const open = Date.parse("2026-08-12T13:30:00.000Z");
  let fallbackCalls = 0;
  const fallback: SessionStockFallback = {
    async *streamStockEvents() {
      fallbackCalls += 1;
      yield [quote(open)];
    },
  };
  const expected = [quote(open + 500), quote(open + 2_000)];
  const output: HistoricalMarketEvent[] = [];
  for await (const batch of streamSessionStockRecovery({
    primary: source([expected]),
    fallback,
    symbol: "QQQ",
    startTimestamp: open,
    endTimestamp: open + 60_000,
    quoteSampleIntervalMs: 250,
  })) output.push(...batch);

  assert.equal(fallbackCalls, 0);
  assert.deepEqual(output, expected);
});
