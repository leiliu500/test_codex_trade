import type { EngineConfig } from "../config.js";
import type { StockStream, StockStreamEvent, StockStreamHandlers } from "../alpaca/stockStream.js";
import type { FeatureSnapshot, SecondBar, StockQuote, StockTrade } from "../types.js";
import type { HealthState } from "../ops/healthServer.js";
import type { HistoricalMarketEvent } from "../history/types.js";
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
  onStockTrade?: (trade: StockTrade) => void | Promise<void>;
  onStockEvents?: (events: readonly StockStreamEvent[]) => void | Promise<void>;
  onFeature?: (feature: FeatureSnapshot) => void | Promise<void>;
  onError?: (error: unknown) => void;
  featureCheckpoint?: FeatureSnapshot;
}

export interface SpySipRestorationSummary {
  events: number;
  quotes: number;
  trades: number;
  bars: number;
  rejectedEvents: number;
  firstProviderTimestamp?: number;
  lastProviderTimestamp?: number;
  latestFeature?: FeatureSnapshot;
}

/**
 * Serialized single-underlying SIP ingestion boundary. It authenticates/subscribes through the
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
  readonly #onStockTrade: ((trade: StockTrade) => void | Promise<void>) | undefined;
  readonly #onStockEvents: ((events: readonly StockStreamEvent[]) => void | Promise<void>) | undefined;
  readonly #onFeature: ((feature: FeatureSnapshot) => void | Promise<void>) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  #aggregator: SecondAggregator;
  #features: FeatureEngine;
  #queue = new SerializedDecisionQueue();
  #flushTimer: ReturnType<typeof setInterval> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #started = false;
  #buffering = false;
  readonly #bufferedEvents: StockStreamEvent[] = [];
  #stopping = false;
  #connected = false;
  #lastQuoteTimestamp: number | undefined;
  #lastTradeTimestamp: number | undefined;
  #lastProviderTimestamp: number | undefined;
  #lastFeatureTimestamp: number | undefined;
  #lastFeature: FeatureSnapshot | undefined;
  #restoredEventCount = 0;
  #restoredBarCount = 0;
  #restorationRejectedCount = 0;
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
    this.#onStockTrade = options.onStockTrade;
    this.#onStockEvents = options.onStockEvents;
    this.#onFeature = options.onFeature;
    this.#onError = options.onError;
    this.#aggregator = new SecondAggregator(options.config.dataQuality);
    this.#features = new FeatureEngine(options.config);
    if (options.featureCheckpoint) this.#features.restoreCheckpoint(options.featureCheckpoint);
  }

  async start(): Promise<void> {
    await this.#start(false);
  }

  /** Connects immediately but holds live SIP events until restored history is applied. */
  async startBuffered(): Promise<void> {
    await this.#start(true);
  }

  async activate(): Promise<SpySipRestorationSummary> {
    if (!this.#started || !this.#buffering) {
      throw new Error(`${this.#config.symbol} SIP receiver is not buffering live events`);
    }
    const firstProviderTimestamp = this.#bufferedEvents[0]?.value.timestamp;
    let quotes = 0;
    let trades = 0;
    let bars = 0;
    let rejectedEvents = 0;
    let lastProviderTimestamp: number | undefined;
    while (this.#bufferedEvents.length > 0) {
      const events = this.#bufferedEvents.splice(0, 10_000);
      for (const event of events) {
        lastProviderTimestamp = Math.max(lastProviderTimestamp ?? -Infinity, event.value.timestamp);
      }
      const result = await this.#ingestEvents(events, false);
      quotes += result.quotes;
      trades += result.trades;
      bars += result.bars;
      rejectedEvents += result.rejectedEvents;
    }
    this.#buffering = false;
    return {
      events: quotes + trades,
      quotes,
      trades,
      bars,
      rejectedEvents,
      ...(firstProviderTimestamp !== undefined ? { firstProviderTimestamp } : {}),
      ...(lastProviderTimestamp !== undefined ? { lastProviderTimestamp } : {}),
      ...(this.#lastFeature ? { latestFeature: this.#lastFeature } : {}),
    };
  }

  async #start(buffering: boolean): Promise<void> {
    if (this.#started) throw new Error(`${this.#config.symbol} SIP receiver is already started`);
    this.#stopping = false;
    this.#buffering = buffering;
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

  async restore(
    source: AsyncIterable<HistoricalMarketEvent | readonly HistoricalMarketEvent[]> |
      Iterable<HistoricalMarketEvent | readonly HistoricalMarketEvent[]>,
  ): Promise<SpySipRestorationSummary> {
    if (this.#started && !this.#buffering) {
      throw new Error(`Cannot restore ${this.#config.symbol} SIP state after live ingestion has started`);
    }
    let quotes = 0;
    let trades = 0;
    let bars = 0;
    let rejectedEvents = 0;
    let firstProviderTimestamp: number | undefined;
    let lastProviderTimestamp: number | undefined;
    const processItem = (item: HistoricalMarketEvent | readonly HistoricalMarketEvent[]): void => {
      for (const event of Array.isArray(item) ? item : [item]) {
        if (event.symbol !== this.#config.symbol ||
            (event.type !== "stock_quote" && event.type !== "stock_trade")) continue;
        const providerTimestamp = finiteNumber(event.data.timestamp) ?? event.providerTimestamp;
        firstProviderTimestamp = Math.min(firstProviderTimestamp ?? Number.POSITIVE_INFINITY, providerTimestamp);
        lastProviderTimestamp = Math.max(lastProviderTimestamp ?? -Infinity, providerTimestamp);
        let result;
        if (event.type === "stock_quote") {
          const quote = stockQuoteFromHistory(event, this.#config.symbol);
          if (!quote) { rejectedEvents += 1; continue; }
          quotes += 1;
          result = this.#aggregator.ingestQuote(quote);
        } else {
          const trade = stockTradeFromHistory(event, this.#config.symbol);
          if (!trade) { rejectedEvents += 1; continue; }
          trades += 1;
          result = this.#aggregator.ingestTrade(trade);
        }
        if (result.rejected) rejectedEvents += 1;
        bars += this.#restoreBars(result.bars);
      }
    };
    if (Symbol.asyncIterator in source) {
      for await (const item of source) {
        processItem(item);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } else {
      let nextYield = 2_000;
      for (const item of source) {
        processItem(item);
        if (quotes + trades >= nextYield) {
          nextYield = quotes + trades + 2_000;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }
    if (lastProviderTimestamp !== undefined) {
      bars += this.#restoreBars(this.#aggregator.flushThrough(lastProviderTimestamp));
      this.#lastProviderTimestamp = lastProviderTimestamp;
    }
    const restoredEvents = quotes + trades;
    this.#restoredEventCount += restoredEvents;
    this.#restoredBarCount += bars;
    this.#restorationRejectedCount += rejectedEvents;
    return {
      events: restoredEvents,
      quotes,
      trades,
      bars,
      rejectedEvents,
      ...(firstProviderTimestamp !== undefined ? { firstProviderTimestamp } : {}),
      ...(lastProviderTimestamp !== undefined ? { lastProviderTimestamp } : {}),
      ...(this.#lastFeature ? { latestFeature: this.#lastFeature } : {}),
    };
  }

  async close(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    this.#buffering = false;
    this.#bufferedEvents.length = 0;
    this.#connected = false;
    if (this.#flushTimer) clearInterval(this.#flushTimer);
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#flushTimer = undefined;
    this.#reconnectTimer = undefined;
    await this.#stream.close();
    await this.#queue.drained();
  }

  /**
   * Discards provider-time and feature state before reconnecting for a new market session.
   * Reusing the prior session's open second would otherwise expand the overnight gap into
   * tens of thousands of empty one-second bars when the first new quote arrives.
   */
  resetSessionState(featureCheckpoint?: FeatureSnapshot): void {
    if (this.#started) {
      throw new Error(`Cannot reset ${this.#config.symbol} SIP state while the receiver is started`);
    }
    this.#aggregator = new SecondAggregator(this.#config.dataQuality);
    this.#features = new FeatureEngine(this.#config);
    if (featureCheckpoint) this.#features.restoreCheckpoint(featureCheckpoint);
    this.#queue = new SerializedDecisionQueue();
    this.#bufferedEvents.length = 0;
    this.#lastQuoteTimestamp = undefined;
    this.#lastTradeTimestamp = undefined;
    this.#lastProviderTimestamp = undefined;
    this.#lastFeatureTimestamp = undefined;
    this.#lastFeature = undefined;
    this.#lastStreamError = undefined;
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
      restoredStockEvents: this.#restoredEventCount,
      restoredBars: this.#restoredBarCount,
      restorationRejectedEvents: this.#restorationRejectedCount,
      rejectedMarketEvents: this.#rejectedCount,
      ...(this.#lastFeatureTimestamp !== undefined ? { lastFeatureTimestamp: this.#lastFeatureTimestamp } : {}),
      reconnectAttempt: this.#reconnectAttempt,
      ...(this.#lastStreamError ? { lastStreamError: this.#lastStreamError } : {}),
      subscribedOptionContracts: 0,
      websocketConnected: this.#connected,
      brokerAvailable: false,
      marketClockState: this.#connected
        ? `${this.#config.symbol.toLowerCase()}-sip-subscribed`
        : `${this.#config.symbol.toLowerCase()}-sip-disconnected`,
      openOrderCount: 0,
      positionsReconciled: true,
      recorderHealthy: true,
      killSwitch,
    };
  }

  async #connect(): Promise<void> {
    await this.#stream.connect(this.#handlers());
    if (!this.#connected) throw new Error(`${this.#config.symbol} SIP stream did not confirm its subscription`);
  }

  #handlers(): StockStreamHandlers {
    return {
      onQuote: async (quote) => {
        if (this.#buffering) { this.#bufferedEvents.push({ type: "quote", value: quote }); return; }
        await this.#ingestQuote(quote);
      },
      onTrade: async (trade) => {
        if (this.#buffering) { this.#bufferedEvents.push({ type: "trade", value: trade }); return; }
        await this.#ingestTrade(trade);
      },
      onEvents: async (events) => {
        if (this.#buffering) { this.#bufferedEvents.push(...events); return; }
        await this.#ingestEvents(events);
      },
      onState: (connected) => {
        this.#connected = connected;
        if (connected) {
          this.#reconnectAttempt = 0;
          this.#lastStreamError = undefined;
        } else if (this.#started && !this.#stopping) {
          this.#lastStreamError = `${this.#config.symbol} SIP stream disconnected`;
          this.#scheduleReconnect();
        }
      },
      onError: (error) => this.#recordError(error),
    };
  }

  async #ingestQuote(quote: StockQuote, emitFeatures = true): Promise<{ bars: number; rejectedEvents: number }> {
    const result = await this.#ingestEvents([{ type: "quote", value: quote }], emitFeatures);
    return { bars: result.bars, rejectedEvents: result.rejectedEvents };
  }

  async #ingestTrade(trade: StockTrade, emitFeatures = true): Promise<{ bars: number; rejectedEvents: number }> {
    const result = await this.#ingestEvents([{ type: "trade", value: trade }], emitFeatures);
    return { bars: result.bars, rejectedEvents: result.rejectedEvents };
  }

  async #ingestEvents(
    events: readonly StockStreamEvent[],
    emitFeatures = true,
  ): Promise<{ quotes: number; trades: number; bars: number; rejectedEvents: number }> {
    try {
      let quotes = 0;
      let trades = 0;
      let bars = 0;
      let rejectedEvents = 0;
      await this.#queue.enqueue(async () => {
        let pendingCallbacks: StockStreamEvent[] = [];
        const flushCallbacks = async (): Promise<void> => {
          if (!emitFeatures || pendingCallbacks.length === 0) return;
          const batch = pendingCallbacks;
          pendingCallbacks = [];
          if (this.#onStockEvents) {
            await this.#onStockEvents(batch);
            return;
          }
          for (const event of batch) {
            if (event.type === "quote") await this.#onStockQuote?.(event.value);
            else await this.#onStockTrade?.(event.value);
          }
        };
        for (const event of events) {
          if (event.value.symbol !== this.#config.symbol) {
            this.#rejectedCount += 1;
            rejectedEvents += 1;
            continue;
          }
          let result;
          if (event.type === "quote") {
            quotes += 1;
            this.#quoteCount += 1;
            this.#lastQuoteTimestamp = event.value.timestamp;
            result = this.#aggregator.ingestQuote(event.value);
          } else {
            trades += 1;
            this.#tradeCount += 1;
            this.#lastTradeTimestamp = event.value.timestamp;
            result = this.#aggregator.ingestTrade(event.value);
          }
          this.#lastProviderTimestamp = Math.max(this.#lastProviderTimestamp ?? -Infinity, event.value.timestamp);
          if (result.rejected) { this.#rejectedCount += 1; rejectedEvents += 1; }
          bars += result.bars.length;
          if (emitFeatures) {
            if (result.bars.length > 0) {
              await flushCallbacks();
              await this.#handleBars(result.bars);
            }
            pendingCallbacks.push(event);
          } else {
            this.#barCount += result.bars.length;
            this.#restoreBars(result.bars);
          }
        }
        await flushCallbacks();
      });
      return { quotes, trades, bars, rejectedEvents };
    } catch (error) {
      this.#recordError(error);
      throw error;
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
      this.#lastFeature = feature;
      await this.#onFeature?.(feature);
    }
  }

  #restoreBars(bars: readonly SecondBar[]): number {
    for (const bar of bars) {
      const feature = this.#features.onBar(bar);
      if (!feature) continue;
      this.#lastFeatureTimestamp = feature.timestamp;
      this.#lastFeature = feature;
    }
    return bars.length;
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

function stockQuoteFromHistory(
  event: HistoricalMarketEvent, symbol: StockQuote["symbol"],
): StockQuote | undefined {
  const timestamp = finiteNumber(event.data.timestamp) ?? event.providerTimestamp;
  const bidPrice = finiteNumber(event.data.bidPrice);
  const askPrice = finiteNumber(event.data.askPrice);
  const bidSize = finiteNumber(event.data.bidSize);
  const askSize = finiteNumber(event.data.askSize);
  if (bidPrice === undefined || askPrice === undefined || bidSize === undefined || askSize === undefined) return undefined;
  return { symbol, timestamp, bidPrice, askPrice, bidSize, askSize };
}

function stockTradeFromHistory(
  event: HistoricalMarketEvent, symbol: StockTrade["symbol"],
): StockTrade | undefined {
  const timestamp = finiteNumber(event.data.timestamp) ?? event.providerTimestamp;
  const price = finiteNumber(event.data.price);
  const size = finiteNumber(event.data.size);
  if (price === undefined || size === undefined) return undefined;
  return { symbol, timestamp, price, size };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
