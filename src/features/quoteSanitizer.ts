import type { EngineConfig } from "../config.js";
import type { OptionQuote, StockQuote } from "../types.js";
import { quantileNearestRank, stableStringify } from "../utils/statistics.js";
import { spreadBps } from "./quoteMath.js";

export interface SanitizationResult<T> {
  usable: boolean;
  value?: T;
  reasons: string[];
}

class RollingSizes {
  readonly #window: number;
  readonly #values: number[] = [];
  constructor(window: number) { this.#window = window; }
  cap(value: number, p: number, fixed: number): number {
    this.#values.push(value);
    if (this.#values.length > this.#window) this.#values.shift();
    return Math.min(value, quantileNearestRank(this.#values, p), fixed);
  }
}

export class StockQuoteSanitizer {
  readonly #config: EngineConfig["dataQuality"];
  readonly #bidSizes: RollingSizes;
  readonly #askSizes: RollingSizes;
  #lastTimestamp = -Infinity;
  #lastSerialized?: string;

  constructor(config: EngineConfig["dataQuality"]) {
    this.#config = config;
    this.#bidSizes = new RollingSizes(config.sizeWinsorWindow);
    this.#askSizes = new RollingSizes(config.sizeWinsorWindow);
  }

  sanitize(quote: StockQuote): SanitizationResult<StockQuote> {
    const serialized = stableStringify(quote);
    if (serialized === this.#lastSerialized) return { usable: false, reasons: ["DUPLICATE"] };
    if (quote.timestamp < this.#lastTimestamp) return { usable: false, reasons: ["OUT_OF_ORDER"] };
    this.#lastTimestamp = quote.timestamp;
    this.#lastSerialized = serialized;
    const reasons: string[] = [];
    if (!(quote.bidPrice > 0)) reasons.push("NONPOSITIVE_BID");
    if (!(quote.askPrice > quote.bidPrice)) reasons.push("LOCKED_OR_CROSSED");
    if (!(quote.bidSize > 0) || !(quote.askSize > 0)) reasons.push("NONPOSITIVE_SIZE");
    if (reasons.length === 0 && spreadBps(quote.bidPrice, quote.askPrice) > this.#config.maxStockSpreadBps) {
      reasons.push("SPREAD_TOO_WIDE");
    }
    if (reasons.length > 0) return { usable: false, reasons };
    const value: StockQuote = {
      ...quote,
      bidSize: this.#bidSizes.cap(quote.bidSize, this.#config.sizeWinsorQuantile, this.#config.fixedMaxSizeLots),
      askSize: this.#askSizes.cap(quote.askSize, this.#config.sizeWinsorQuantile, this.#config.fixedMaxSizeLots),
    };
    return { usable: true, value, reasons: [] };
  }
}

export function validateOptionQuote(quote: OptionQuote, now: number, config: EngineConfig["dataQuality"]): SanitizationResult<OptionQuote> {
  const reasons: string[] = [];
  if (!(quote.bidPrice > 0)) reasons.push("NONPOSITIVE_BID");
  if (!(quote.askPrice > quote.bidPrice)) reasons.push("LOCKED_OR_CROSSED");
  if (!(quote.bidSize > 0) || !(quote.askSize > 0)) reasons.push("NONPOSITIVE_SIZE");
  if (now - quote.timestamp < 0) reasons.push("FUTURE_QUOTE");
  if (now - quote.timestamp > config.maxOptionQuoteAgeMs) reasons.push("STALE_QUOTE");
  if (reasons.length === 0) {
    const mid = (quote.bidPrice + quote.askPrice) / 2;
    if ((quote.askPrice - quote.bidPrice) / mid > config.maxOptionSpreadPct) reasons.push("SPREAD_TOO_WIDE");
  }
  return reasons.length > 0 ? { usable: false, reasons } : { usable: true, value: quote, reasons: [] };
}
