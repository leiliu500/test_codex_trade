import type { EngineConfig } from "../config.js";
import type { SecondBar, StockQuote, StockTrade } from "../types.js";
import { median, stableStringify } from "../utils/statistics.js";
import { epochSecond } from "../utils/time.js";
import { microprice, micropriceDisplacementBps, midprice, orderFlowImbalanceEvent, quoteImbalance } from "./quoteMath.js";
import { StockQuoteSanitizer } from "./quoteSanitizer.js";

interface BucketAccumulator {
  start: number;
  micros: number[];
  mids: number[];
  imbalances: number[];
  displacements: number[];
  finalQuote?: StockQuote;
  quoteCount: number;
  ofiRaw: number;
  depthSum: number;
  depthEventCount: number;
  tradeNotional: number;
  tradeVolume: number;
}

function bucket(start: number): BucketAccumulator {
  return {
    start, micros: [], mids: [], imbalances: [], displacements: [], quoteCount: 0,
    ofiRaw: 0, depthSum: 0, depthEventCount: 0, tradeNotional: 0, tradeVolume: 0,
  };
}

export interface AggregationResult {
  bars: SecondBar[];
  rejected?: { event: "quote" | "trade"; reasons: string[] };
}

export class SecondAggregator {
  readonly #sanitizer: StockQuoteSanitizer;
  #current?: BucketAccumulator;
  #previousQuote?: StockQuote;
  #lastQuoteTimestamp?: number;
  #lastValues?: Pick<SecondBar, "microprice" | "mid" | "quoteImbalance" | "micropriceDisplacementBps" | "bidPrice" | "askPrice" | "bidSize" | "askSize">;
  #lastTradeTimestamp = -Infinity;
  #lastTradeSerialized?: string;

  constructor(config: EngineConfig["dataQuality"]) {
    this.#sanitizer = new StockQuoteSanitizer(config);
  }

  ingestQuote(quote: StockQuote): AggregationResult {
    const bars = this.#advanceTo(epochSecond(quote.timestamp));
    const result = this.#sanitizer.sanitize(quote);
    if (!result.usable || !result.value) return { bars, rejected: { event: "quote", reasons: result.reasons } };
    this.#ensureBucket(epochSecond(quote.timestamp));
    const q = result.value;
    const micro = microprice(q.bidPrice, q.askPrice, q.bidSize, q.askSize);
    const mid = midprice(q.bidPrice, q.askPrice);
    const imbalance = quoteImbalance(q.bidSize, q.askSize);
    const displacement = micropriceDisplacementBps(q.bidPrice, q.askPrice, q.bidSize, q.askSize);
    this.#current!.micros.push(micro);
    this.#current!.mids.push(mid);
    this.#current!.imbalances.push(imbalance);
    this.#current!.displacements.push(displacement);
    this.#current!.quoteCount += 1;
    this.#current!.depthSum += q.bidSize + q.askSize;
    this.#current!.depthEventCount += 1;
    if (this.#previousQuote) this.#current!.ofiRaw += orderFlowImbalanceEvent(this.#previousQuote, q);
    this.#current!.finalQuote = q;
    this.#previousQuote = q;
    this.#lastQuoteTimestamp = q.timestamp;
    return { bars };
  }

  ingestTrade(trade: StockTrade): AggregationResult {
    const bars = this.#advanceTo(epochSecond(trade.timestamp));
    const serialized = stableStringify(trade);
    const reasons: string[] = [];
    if (serialized === this.#lastTradeSerialized) reasons.push("DUPLICATE");
    if (trade.timestamp < this.#lastTradeTimestamp) reasons.push("OUT_OF_ORDER");
    if (!(trade.price > 0) || !(trade.size > 0)) reasons.push("INVALID_TRADE");
    if (reasons.length > 0) return { bars, rejected: { event: "trade", reasons } };
    this.#lastTradeSerialized = serialized;
    this.#lastTradeTimestamp = trade.timestamp;
    this.#ensureBucket(epochSecond(trade.timestamp));
    this.#current!.tradeNotional += trade.price * trade.size;
    this.#current!.tradeVolume += trade.size;
    return { bars };
  }

  /** Finalize every completed bucket whose end is <= timestamp. */
  flushThrough(timestamp: number): SecondBar[] {
    return this.#advanceTo(epochSecond(timestamp));
  }

  #ensureBucket(start: number): void {
    if (!this.#current) this.#current = bucket(start);
  }

  #advanceTo(targetStart: number): SecondBar[] {
    if (!this.#current) {
      this.#current = bucket(targetStart);
      return [];
    }
    const bars: SecondBar[] = [];
    while (this.#current.start < targetStart) {
      bars.push(this.#finalize(this.#current));
      this.#current = bucket(this.#current.start + 1000);
    }
    return bars;
  }

  #finalize(current: BucketAccumulator): SecondBar {
    const end = current.start + 1000;
    const final = current.finalQuote;
    const values = current.quoteCount > 0 ? {
      microprice: median(current.micros),
      mid: median(current.mids),
      quoteImbalance: median(current.imbalances),
      micropriceDisplacementBps: median(current.displacements),
      bidPrice: final!.bidPrice,
      askPrice: final!.askPrice,
      bidSize: final!.bidSize,
      askSize: final!.askSize,
    } : this.#lastValues;
    if (current.quoteCount > 0 && values) this.#lastValues = values;
    return {
      timestamp: end,
      ...values,
      quoteCount: current.quoteCount,
      quoteAgeMs: this.#lastQuoteTimestamp === undefined ? Number.POSITIVE_INFINITY : Math.max(0, end - this.#lastQuoteTimestamp),
      ofiRaw: current.ofiRaw,
      depthSum: current.depthSum,
      depthEventCount: current.depthEventCount,
      tradeVolume: current.tradeVolume,
      ...(current.tradeVolume > 0 ? { tradeVwap: current.tradeNotional / current.tradeVolume } : {}),
    };
  }
}
