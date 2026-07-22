import type { EngineConfig } from "../config.js";
import type { SecondBar, VwapState } from "../types.js";
import { robustEndpointQuadratic, type TimedValue } from "../math/robustQuadratic.js";
import { isAtOrAfter, marketDate } from "../utils/time.js";

interface TradeBucket { timestamp: number; notional: number; volume: number }

export class VwapTracker {
  readonly #config: EngineConfig;
  #date?: string;
  #sessionNotional = 0;
  #sessionVolume = 0;
  readonly #trades: TradeBucket[] = [];
  readonly #rollingSeries: TimedValue[] = [];
  readonly #anchors = new Map<string, { timestamp: number; notional: number; volume: number }>();

  constructor(config: EngineConfig) { this.#config = config; }

  addAnchor(name: string, timestamp: number, initialBar?: SecondBar): void {
    if (this.#anchors.has(name)) return;
    const include = initialBar?.tradeVwap !== undefined && initialBar.tradeVolume > 0 && initialBar.timestamp >= timestamp;
    this.#anchors.set(name, {
      timestamp,
      notional: include ? initialBar.tradeVwap! * initialBar.tradeVolume : 0,
      volume: include ? initialBar.tradeVolume : 0,
    });
  }

  update(bar: SecondBar): VwapState {
    const date = marketDate(bar.timestamp, this.#config.timeZone);
    if (date !== this.#date) this.#reset(date, bar.timestamp);
    if (isAtOrAfter(bar.timestamp, this.#config.session.entryStart, this.#config.timeZone)) {
      this.addAnchor("entry_start", bar.timestamp);
    }
    if (bar.tradeVolume > 0 && bar.tradeVwap !== undefined) {
      const notional = bar.tradeVwap * bar.tradeVolume;
      this.#sessionNotional += notional;
      this.#sessionVolume += bar.tradeVolume;
      this.#trades.push({ timestamp: bar.timestamp, notional, volume: bar.tradeVolume });
      for (const anchor of this.#anchors.values()) {
        if (bar.timestamp >= anchor.timestamp) {
          anchor.notional += notional;
          anchor.volume += bar.tradeVolume;
        }
      }
    }
    const rollingStart = bar.timestamp - 60_000;
    while (this.#trades[0] && this.#trades[0].timestamp < rollingStart) this.#trades.shift();
    const rollingNotional = this.#trades.reduce((total, item) => total + item.notional, 0);
    const rollingVolume = this.#trades.reduce((total, item) => total + item.volume, 0);
    const rollingVwap = rollingVolume > 0 ? rollingNotional / rollingVolume : undefined;
    if (rollingVwap !== undefined) this.#rollingSeries.push({ timestamp: bar.timestamp, value: Math.log(rollingVwap) });
    const historyStart = bar.timestamp - this.#config.regression.rollingVwapSlopeWindowSec * 1000;
    while (this.#rollingSeries[0] && this.#rollingSeries[0].timestamp < historyStart) this.#rollingSeries.shift();
    const slope = robustEndpointQuadratic(
      this.#rollingSeries, bar.timestamp, this.#config.regression.rollingVwapSlopeWindowSec, this.#config.regression,
    );
    const sessionVwap = this.#sessionVolume > 0 ? this.#sessionNotional / this.#sessionVolume : undefined;
    const anchoredVwaps: Record<string, number> = {};
    for (const [name, anchor] of this.#anchors) if (anchor.volume > 0) anchoredVwaps[name] = anchor.notional / anchor.volume;
    return {
      ...(sessionVwap !== undefined ? { sessionVwap } : {}),
      ...(rollingVwap !== undefined ? { rollingVwap } : {}),
      ...(slope.valid ? { rollingVwapSlopeBpsPerSec: slope.slopeBpsPerSec! } : {}),
      anchoredVwaps,
      ...(sessionVwap !== undefined && bar.microprice !== undefined
        ? { sessionDistanceBps: 10_000 * Math.log(bar.microprice / sessionVwap) } : {}),
    };
  }

  #reset(date: string, timestamp: number): void {
    this.#date = date;
    this.#sessionNotional = 0;
    this.#sessionVolume = 0;
    this.#trades.length = 0;
    this.#rollingSeries.length = 0;
    this.#anchors.clear();
    this.addAnchor("market_open", timestamp);
  }
}
