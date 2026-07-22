import type { CalibrationProfile, FeatureSnapshot, SecondBar, WindowMetrics } from "../types.js";
import type { EngineConfig } from "../config.js";
import { robustEndpointQuadratic } from "../math/robustQuadratic.js";
import { directionalSignChanges, efficiencyRatio, ewma, realizedMovementBps } from "../math/rollingIndicators.js";
import { marketDate, secondsSinceMidnight, parseClock } from "../utils/time.js";
import { CalibrationResolver } from "./calibration.js";
import { OpeningRangeTracker } from "./openingRange.js";
import { VwapTracker } from "./vwap.js";
import { EPSILON } from "../utils/statistics.js";

export class FeatureEngine {
  readonly #config: EngineConfig;
  readonly #calibration: CalibrationResolver;
  readonly #openingRange: OpeningRangeTracker;
  readonly #vwap: VwapTracker;
  readonly #bars: SecondBar[] = [];
  #priorClose: number | undefined;
  #sessionOpen: number | undefined;
  #sessionDate: string | undefined;

  constructor(config: EngineConfig, calibration?: CalibrationProfile) {
    this.#config = config;
    this.#calibration = new CalibrationResolver(config, calibration);
    this.#openingRange = new OpeningRangeTracker(config, calibration?.openingRangeWidthsBps);
    this.#vwap = new VwapTracker(config);
  }

  restoreCheckpoint(feature: FeatureSnapshot): void {
    this.#sessionDate = feature.marketDate;
    this.#openingRange.restore(feature.marketDate, feature.openingRange);
  }

  setPriorClose(close: number): void { this.#priorClose = close > 0 ? close : undefined; }

  onBar(bar: SecondBar): FeatureSnapshot | undefined {
    this.#bars.push(bar);
    const keepAfter = bar.timestamp - Math.max(180, this.#config.regression.slowWindowSec + 5) * 1000;
    while (this.#bars[0] && this.#bars[0].timestamp < keepAfter) this.#bars.shift();
    const date = marketDate(bar.timestamp, this.#config.timeZone);
    if (date !== this.#sessionDate) {
      this.#sessionDate = date;
      this.#sessionOpen = undefined;
    }
    const seconds = secondsSinceMidnight(bar.timestamp, this.#config.timeZone);
    if (this.#sessionOpen === undefined && bar.microprice !== undefined &&
        seconds >= parseClock(this.#config.session.marketOpen)) this.#sessionOpen = bar.microprice;
    const vwap = this.#vwap.update(bar);
    if (bar.microprice === undefined || bar.mid === undefined) return undefined;

    const spread = bar.bidPrice !== undefined && bar.askPrice !== undefined
      ? 10_000 * (bar.askPrice - bar.bidPrice) / bar.mid : Number.POSITIVE_INFINITY;
    const fast = this.#window(bar.timestamp, this.#config.regression.fastWindowSec, spread);
    const medium = this.#window(bar.timestamp, this.#config.regression.mediumWindowSec, spread);
    const slow = this.#window(bar.timestamp, this.#config.regression.slowWindowSec, spread);
    const sixty = this.#validBars(bar.timestamp, 60);
    const logs60 = sixty.map((value) => Math.log(value.microprice!));
    const efficiency60 = efficiencyRatio(logs60);
    const signChanges60 = directionalSignChanges(logs60);
    const ofi1 = this.#ofi(bar.timestamp, 1);
    const ofi5 = this.#ofi(bar.timestamp, 5);
    const ofi15 = this.#ofi(bar.timestamp, 15);
    const volume60 = this.#bars
      .filter((value) => value.timestamp >= bar.timestamp - 60_000 && value.timestamp <= bar.timestamp)
      .reduce((total, value) => total + value.tradeVolume, 0);
    const thresholds = this.#calibration.thresholds(bar.timestamp, date);
    const rvPercentile = this.#calibration.rvPercentile(bar.timestamp, date, medium.realizedVolatilityBps);
    const openingRange = this.#openingRange.update(bar.timestamp, bar.microprice);
    if (openingRange.bullishBreakoutTimestamp === bar.timestamp) this.#vwap.addAnchor("or_breakout_up", bar.timestamp, bar);
    if (openingRange.bearishBreakoutTimestamp === bar.timestamp) this.#vwap.addAnchor("or_breakout_down", bar.timestamp, bar);
    const qiValues5 = this.#bars.filter((value) => value.timestamp >= bar.timestamp - 5_000 && value.quoteImbalance !== undefined)
      .map((value) => value.quoteImbalance!);
    const qiValues15 = this.#bars.filter((value) => value.timestamp >= bar.timestamp - 15_000 && value.quoteImbalance !== undefined)
      .map((value) => value.quoteImbalance!);
    const invalidReasons: string[] = [];
    if (bar.quoteAgeMs > this.#config.dataQuality.maxStockQuoteAgeMs) invalidReasons.push("STALE_STOCK_QUOTE");
    if (spread > this.#config.dataQuality.maxStockSpreadBps) invalidReasons.push("STOCK_SPREAD_TOO_WIDE");
    if (bar.quoteCount < this.#config.dataQuality.minQuotesPerSecond) invalidReasons.push("NO_CURRENT_SECOND_QUOTE");
    for (const [name, metric] of [["FAST", fast], ["MEDIUM", medium], ["SLOW", slow]] as const) {
      if (!metric.regression.valid) invalidReasons.push(`${name}_${metric.regression.reason ?? "INVALID"}`);
    }
    const openingGapBps = this.#priorClose && this.#sessionOpen
      ? 10_000 * Math.log(this.#sessionOpen / this.#priorClose) : undefined;
    return {
      symbol: "SPY",
      timestamp: bar.timestamp,
      marketDate: date,
      price: bar.microprice,
      mid: bar.mid,
      spreadBps: spread,
      quoteAgeMs: bar.quoteAgeMs,
      quoteImbalance: bar.quoteImbalance ?? 0,
      quoteImbalanceEwma5: ewma(qiValues5, 2.5),
      quoteImbalanceEwma15: ewma(qiValues15, 7.5),
      micropriceDisplacementBps: bar.micropriceDisplacementBps ?? 0,
      ofi1,
      ofi5,
      ofi15,
      volume60,
      ...(thresholds.volume60Median !== undefined ? { relativeVolume60: volume60 / (thresholds.volume60Median + EPSILON) } : {}),
      fast,
      medium,
      slow,
      efficiency60,
      signChanges60,
      vwap,
      openingRange,
      ...(openingGapBps !== undefined ? { openingGapBps } : {}),
      ...(rvPercentile !== undefined ? { rvPercentile } : {}),
      thresholds,
      dataValid: invalidReasons.length === 0,
      invalidReasons,
    };
  }

  #validBars(now: number, windowSec: number): SecondBar[] {
    return this.#bars.filter((bar) =>
      bar.timestamp >= now - windowSec * 1000 && bar.timestamp <= now &&
      bar.microprice !== undefined && bar.quoteAgeMs <= this.#config.dataQuality.maxStockQuoteAgeMs);
  }

  #window(now: number, windowSec: number, spreadBps: number): WindowMetrics {
    const bars = this.#validBars(now, windowSec);
    const logs = bars.map((bar) => Math.log(bar.microprice!));
    const regression = robustEndpointQuadratic(
      bars.map((bar, index) => ({ timestamp: bar.timestamp, value: logs[index]! })),
      now, windowSec, this.#config.regression,
    );
    const rv = realizedMovementBps(logs);
    const noise = Math.max(rv, spreadBps, this.#config.regression.noiseFloorBps);
    return {
      windowSec,
      regression,
      realizedVolatilityBps: rv,
      efficiencyRatio: efficiencyRatio(logs),
      noiseFloorBps: noise,
      normalizedSlope: regression.valid ? regression.slopeBpsPerSec! * windowSec / noise : 0,
      normalizedAcceleration: regression.valid ? 0.5 * regression.accelerationBpsPerSec2! * windowSec ** 2 / noise : 0,
      signChanges: directionalSignChanges(logs),
    };
  }

  #ofi(now: number, windowSec: number): number {
    const bars = this.#bars.filter((bar) => bar.timestamp >= now - windowSec * 1000 && bar.timestamp <= now);
    const raw = bars.reduce((total, bar) => total + bar.ofiRaw, 0);
    const depth = bars.reduce((total, bar) => total + bar.depthSum, 0);
    const count = bars.reduce((total, bar) => total + bar.depthEventCount, 0);
    return raw / (depth / Math.max(1, count) + EPSILON);
  }
}
