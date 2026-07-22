import type { EngineConfig } from "../config.js";
import type { StockStream, StockStreamHandlers } from "../alpaca/stockStream.js";
import type { FeatureSnapshot, SecondBar, StockQuote, StockTrade } from "../types.js";
import type { HealthState } from "../ops/healthServer.js";
import { SecondAggregator } from "../features/secondAggregator.js";
import { FeatureEngine } from "../features/featureEngine.js";
import { SerializedDecisionQueue } from "../execution/tradingEngine.js";

export interface SpySipReceiverOptions {
  config: EngineConfig;
  stream: StockStream;
  now?: () => number;
  flushIntervalMs?: number;
  reconnectBaseMs?: number;
  reconnectMaximumMs?: number;
  onStockQuote?: (quote: StockQuote) => void | Promise<void>;
  onFeature?: (feature: FeatureSnapshot) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

/**
 * Serialized SPY SIP ingestion boundary. It authenticates/subscribes through the
 * supplied stream, aggregates quotes/trades causally, and never submits orders.
 */
export class SpySipReceiver {
  readonly #config: EngineConfig;
  readonly #stream: StockStream;
  readonly #now: () => number;
  readonly #flushIntervalMs: number;
  readonly #reconnectBaseMs: number;
  readonly #reconnectMaximumMs: number;
  readonly #onStockQuote: ((quote: StockQuote) => void | Promise<void>) | undefined;
  readonly #onFeature: ((feature: FeatureSnapshot) => void | Promise<void>) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #aggregator: SecondAggregator;
  readonly #features: FeatureEngine;
  readonly #queue = new SerializedDecisionQueue();
  #flushTimer: ReturnType<typeof setInterval> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #started = false;
  #stopping = false;
  #connected = false;
  #lastQuoteTimestamp: number | undefined;
  #lastTradeTimestamp: number | undefined;
  #lastProviderTimestamp: number | undefined;
  #lastFeatureTimestamp: number | undefined;
  #quoteCount = 0;
  #tradeCount = 0;
  #barCount = 0;
  #rejectedCount = 0;
  #reconnectAttempt = 0;
  #lastStreamError: string | undefined;

  constructor(options: SpySipReceiverOptions) {
    this.#config = options.config;
    this.#stream = options.stream;
    this.#now = options.now ?? Date.now;
    this.#flushIntervalMs = options.flushIntervalMs ?? 250;
    this.#reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
    this.#reconnectMaximumMs = options.reconnectMaximumMs ?? 30_000;
    this.#onStockQuote = options.onStockQuote;
    this.#onFeature = options.onFeature;
    this.#onError = options.onError;
    this.#aggregator = new SecondAggregator(options.config.dataQuality);
    this.#features = new FeatureEngine(options.config);
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("SPY SIP receiver is already started");
    this.#stopping = false;
    this.#started = true;
    this.#flushTimer = setInterval(() => this.#flushCompletedProviderSecond(), this.#flushIntervalMs);
    try {
      await this.#connect();
    } catch (error) {
      this.#recordError(error);
      await this.#stream.close();
      this.#scheduleReconnect();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    this.#connected = false;
    if (this.#flushTimer) clearInterval(this.#flushTimer);
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#flushTimer = undefined;
    this.#reconnectTimer = undefined;
    await this.#stream.close();
    await this.#queue.drained();
  }

  healthState(killSwitch = false): HealthState {
    const now = this.#now();
    return {
      ready: this.#connected && !this.#queue.halted,
      brokerRequired: false,
      marketDataFeed: "sip",
      ...(this.#lastQuoteTimestamp !== undefined ? { lastStockQuoteAgeMs: Math.max(0, now - this.#lastQuoteTimestamp) } : {}),
      ...(this.#lastTradeTimestamp !== undefined ? { lastStockTradeAgeMs: Math.max(0, now - this.#lastTradeTimestamp) } : {}),
      receivedStockQuotes: this.#quoteCount,
      receivedStockTrades: this.#tradeCount,
      completedBars: this.#barCount,
      rejectedMarketEvents: this.#rejectedCount,
      ...(this.#lastFeatureTimestamp !== undefined ? { lastFeatureTimestamp: this.#lastFeatureTimestamp } : {}),
      reconnectAttempt: this.#reconnectAttempt,
      ...(this.#lastStreamError ? { lastStreamError: this.#lastStreamError } : {}),
      subscribedOptionContracts: 0,
      websocketConnected: this.#connected,
      brokerAvailable: false,
      marketClockState: this.#connected ? "spy-sip-subscribed" : "spy-sip-disconnected",
      openOrderCount: 0,
      positionsReconciled: true,
      recorderHealthy: true,
      killSwitch,
    };
  }

  async #connect(): Promise<void> {
    await this.#stream.connect(this.#handlers());
    if (!this.#connected) throw new Error("SPY SIP stream did not confirm its subscription");
  }

  #handlers(): StockStreamHandlers {
    return {
      onQuote: (quote) => this.#ingestQuote(quote),
      onTrade: (trade) => this.#ingestTrade(trade),
      onState: (connected) => {
        this.#connected = connected;
        if (connected) {
          this.#reconnectAttempt = 0;
          this.#lastStreamError = undefined;
        } else if (this.#started && !this.#stopping) {
          this.#lastStreamError = "SPY SIP stream disconnected";
          this.#scheduleReconnect();
        }
      },
      onError: (error) => this.#recordError(error),
    };
  }

  async #ingestQuote(quote: StockQuote): Promise<void> {
    try {
      await this.#queue.enqueue(async () => {
        this.#quoteCount += 1;
        this.#lastQuoteTimestamp = quote.timestamp;
        this.#lastProviderTimestamp = Math.max(this.#lastProviderTimestamp ?? -Infinity, quote.timestamp);
        const result = this.#aggregator.ingestQuote(quote);
        if (result.rejected) this.#rejectedCount += 1;
        await this.#handleBars(result.bars);
        await this.#onStockQuote?.(quote);
      });
    } catch (error) {
      this.#recordError(error);
    }
  }

  async #ingestTrade(trade: StockTrade): Promise<void> {
    try {
      await this.#queue.enqueue(async () => {
        this.#tradeCount += 1;
        this.#lastTradeTimestamp = trade.timestamp;
        this.#lastProviderTimestamp = Math.max(this.#lastProviderTimestamp ?? -Infinity, trade.timestamp);
        const result = this.#aggregator.ingestTrade(trade);
        if (result.rejected) this.#rejectedCount += 1;
        await this.#handleBars(result.bars);
      });
    } catch (error) {
      this.#recordError(error);
    }
  }

  #flushCompletedProviderSecond(): void {
    const providerTimestamp = this.#lastProviderTimestamp;
    if (providerTimestamp === undefined || this.#now() < providerTimestamp + 1_000) return;
    void this.#queue.enqueue(() => this.#handleBars(this.#aggregator.flushThrough(providerTimestamp + 1_000)))
      .catch((error: unknown) => this.#recordError(error));
  }

  async #handleBars(bars: readonly SecondBar[]): Promise<void> {
    for (const bar of bars) {
      this.#barCount += 1;
      const feature = this.#features.onBar(bar);
      if (!feature) continue;
      this.#lastFeatureTimestamp = feature.timestamp;
      await this.#onFeature?.(feature);
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopping || this.#reconnectTimer) return;
    this.#reconnectAttempt += 1;
    const delay = Math.min(
      this.#reconnectMaximumMs,
      this.#reconnectBaseMs * (2 ** Math.max(0, this.#reconnectAttempt - 1)),
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void (async () => {
        try {
          await this.#stream.close();
          await this.#connect();
        } catch (error) {
          this.#recordError(error);
          this.#scheduleReconnect();
        }
      })();
    }, delay);
  }

  #recordError(error: unknown): void {
    this.#lastStreamError = error instanceof Error ? error.message : String(error);
    this.#onError?.(error);
  }
}
