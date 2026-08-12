import type { UnderlyingSymbol } from "../types.js";
import type { HistoricalMarketEvent } from "./types.js";

export interface SessionStockFallback {
  streamStockEvents(
    symbol: UnderlyingSymbol,
    startTimestamp: number,
    endTimestamp: number,
    quoteSampleIntervalMs: number,
  ): AsyncIterable<readonly HistoricalMarketEvent[]>;
}

export interface SessionStockRecoveryOptions {
  primary: AsyncIterable<readonly HistoricalMarketEvent[]>;
  fallback: SessionStockFallback;
  symbol: UnderlyingSymbol;
  startTimestamp: number;
  endTimestamp: number;
  quoteSampleIntervalMs: number;
  openingCoverageToleranceMs?: number;
  emptyPrimaryLiveOverlapMs?: number;
  onFallback?: (detail: { symbol: UnderlyingSymbol; startTimestamp: number; endTimestamp: number }) => void;
}

/** Prepends only the missing opening-session SIP prefix before replaying durable history. */
export async function* streamSessionStockRecovery(
  options: SessionStockRecoveryOptions,
): AsyncIterable<readonly HistoricalMarketEvent[]> {
  const iterator = options.primary[Symbol.asyncIterator]();
  const buffered: Array<readonly HistoricalMarketEvent[]> = [];
  let firstQuoteTimestamp: number | undefined;

  while (firstQuoteTimestamp === undefined) {
    const next = await iterator.next();
    if (next.done) break;
    buffered.push(next.value);
    for (const event of next.value) {
      if (event.symbol !== options.symbol || event.type !== "stock_quote") continue;
      firstQuoteTimestamp = Math.min(firstQuoteTimestamp ?? Number.POSITIVE_INFINITY, event.providerTimestamp);
    }
  }

  const tolerance = options.openingCoverageToleranceMs ?? 60_000;
  if (firstQuoteTimestamp === undefined || firstQuoteTimestamp > options.startTimestamp + tolerance) {
    const fallbackEnd = firstQuoteTimestamp ?? Math.max(
      options.startTimestamp,
      options.endTimestamp - (options.emptyPrimaryLiveOverlapMs ?? 2_000),
    );
    if (fallbackEnd > options.startTimestamp) {
      options.onFallback?.({
        symbol: options.symbol,
        startTimestamp: options.startTimestamp,
        endTimestamp: fallbackEnd,
      });
      yield* options.fallback.streamStockEvents(
        options.symbol,
        options.startTimestamp,
        fallbackEnd,
        options.quoteSampleIntervalMs,
      );
    }
  }

  for (const batch of buffered) yield batch;
  while (true) {
    const next = await iterator.next();
    if (next.done) return;
    yield next.value;
  }
}
