import type { EngineConfig } from "../config.js";
import type { OpeningRangeState } from "../types.js";
import { quantileNearestRank } from "../utils/statistics.js";
import { isAtOrAfter, isBefore, marketDate } from "../utils/time.js";

export class OpeningRangeTracker {
  readonly #config: EngineConfig;
  readonly #priorWidths: readonly number[];
  #date: string | undefined;
  #high: number | undefined;
  #low: number | undefined;
  #bullishBreakout: number | undefined;
  #bearishBreakout: number | undefined;

  constructor(config: EngineConfig, priorWidthsBps: readonly number[] = []) {
    this.#config = config;
    this.#priorWidths = priorWidthsBps;
  }

  update(timestamp: number, price: number): OpeningRangeState {
    const date = marketDate(timestamp, this.#config.timeZone);
    if (date !== this.#date) {
      this.#date = date;
      this.#high = undefined;
      this.#low = undefined;
      this.#bullishBreakout = undefined;
      this.#bearishBreakout = undefined;
    }
    const inRange = isAtOrAfter(timestamp, this.#config.session.marketOpen, this.#config.timeZone)
      && isBefore(timestamp, this.#config.session.openingRangeEnd, this.#config.timeZone);
    if (inRange) {
      this.#high = this.#high === undefined ? price : Math.max(this.#high, price);
      this.#low = this.#low === undefined ? price : Math.min(this.#low, price);
    }
    const complete = isAtOrAfter(timestamp, this.#config.session.openingRangeEnd, this.#config.timeZone)
      && this.#high !== undefined && this.#low !== undefined;
    let midpoint: number | undefined;
    let widthBps: number | undefined;
    let percentile: number | undefined;
    let nearHigh = false;
    let nearLow = false;
    let bullishRetest = false;
    let bearishRetest = false;
    if (complete) {
      midpoint = (this.#high! + this.#low!) / 2;
      widthBps = 10_000 * (this.#high! - this.#low!) / midpoint;
      if (this.#priorWidths.length > 0) {
        percentile = this.#priorWidths.filter((value) => value <= widthBps!).length / this.#priorWidths.length;
      }
      const highDistance = 10_000 * Math.abs(price - this.#high!) / this.#high!;
      const lowDistance = 10_000 * Math.abs(price - this.#low!) / this.#low!;
      nearHigh = highDistance <= this.#config.signals.openingRangeNearBps;
      nearLow = lowDistance <= this.#config.signals.openingRangeNearBps;
      if (price > this.#high! && this.#bullishBreakout === undefined) this.#bullishBreakout = timestamp;
      if (price < this.#low! && this.#bearishBreakout === undefined) this.#bearishBreakout = timestamp;
      const memoryMs = this.#config.signals.breakoutMemorySec * 1000;
      if (this.#bullishBreakout !== undefined && timestamp - this.#bullishBreakout <= memoryMs) {
        const tolerance = this.#high! * this.#config.signals.openingRangeRetestBps / 10_000;
        bullishRetest = price >= this.#high! - tolerance && price <= this.#high! + tolerance;
      }
      if (this.#bearishBreakout !== undefined && timestamp - this.#bearishBreakout <= memoryMs) {
        const tolerance = this.#low! * this.#config.signals.openingRangeRetestBps / 10_000;
        bearishRetest = price >= this.#low! - tolerance && price <= this.#low! + tolerance;
      }
    }
    return {
      complete,
      ...(this.#high !== undefined ? { high: this.#high } : {}),
      ...(this.#low !== undefined ? { low: this.#low } : {}),
      ...(midpoint !== undefined ? { midpoint } : {}),
      ...(widthBps !== undefined ? { widthBps } : {}),
      ...(percentile !== undefined ? { percentile } : {}),
      ...(this.#bullishBreakout !== undefined ? { bullishBreakoutTimestamp: this.#bullishBreakout } : {}),
      ...(this.#bearishBreakout !== undefined ? { bearishBreakoutTimestamp: this.#bearishBreakout } : {}),
      nearHigh,
      nearLow,
      bullishRetest,
      bearishRetest,
    };
  }
}

export function openingRangePercentile(widthBps: number, priorWidths: readonly number[]): number | undefined {
  if (priorWidths.length === 0) return undefined;
  // Kept explicit to document that current-session width is not added to this sample.
  void quantileNearestRank;
  return priorWidths.filter((width) => width <= widthBps).length / priorWidths.length;
}
