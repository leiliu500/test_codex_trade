import type { EngineConfig } from "../config.js";
import type { OptionStream } from "../alpaca/optionStream.js";
import type { StockStream } from "../alpaca/stockStream.js";
import type { TradingRestClient } from "../alpaca/restClient.js";
import type {
  AccountState, FeatureSnapshot, OptionContract, OptionQuote, RegimeDecision, StockQuote,
} from "../types.js";
import type { HealthState } from "../ops/healthServer.js";
import type { AuditRecorder } from "../ops/recorder.js";
import type { MarketHistorySink, HistoricalMarketEventType } from "../history/types.js";
import { MemoryRecorder } from "../ops/recorder.js";
import { SerializedDecisionQueue } from "../execution/tradingEngine.js";
import { LiveOrderManager, type LiveExecutionSnapshot } from "../execution/liveOrderManager.js";
import { OptionBook } from "../options/optionBook.js";
import { OptionSelector } from "../options/optionSelector.js";
import { OptionUniverseManager } from "../options/optionUniverse.js";
import { SignalEngine } from "../strategy/signalEngine.js";
import { classifyRegime } from "../strategy/regimeClassifier.js";
import { SpySipReceiver } from "./spySipReceiver.js";
import { marketDate } from "../utils/time.js";

export interface SpyOptionsRuntimeClient extends TradingRestClient {
  getLatestSpySipQuote(): Promise<StockQuote>;
}

export interface SpyOptionsTradingRuntimeOptions {
  config: EngineConfig;
  client: SpyOptionsRuntimeClient;
  stockStream: StockStream;
  optionStream: OptionStream;
  executionEnabled: boolean;
  executionMode?: "paper" | "live";
  killSwitch?: boolean;
  recorder?: AuditRecorder;
  history?: MarketHistorySink;
  now?: () => number;
  executionTickMs?: number;
  onEvent?: (type: string, data: Record<string, unknown>) => void;
  onError?: (error: unknown) => void;
}

/** End-to-end, serialized SPY 0DTE option execution runtime. */
export class SpyOptionsTradingRuntime {
  readonly #config: EngineConfig;
  readonly #client: SpyOptionsRuntimeClient;
  readonly #optionStream: OptionStream;
  readonly #recorder: AuditRecorder;
  readonly #history: MarketHistorySink | undefined;
  readonly #executionEnabled: boolean;
  readonly #executionMode: "paper" | "live";
  readonly #killSwitch: boolean;
  readonly #now: () => number;
  readonly #executionTickMs: number;
  readonly #onEvent: ((type: string, data: Record<string, unknown>) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #queue = new SerializedDecisionQueue();
  readonly #book = new OptionBook();
  readonly #selector: OptionSelector;
  readonly #universe: OptionUniverseManager;
  readonly #signals: SignalEngine;
  readonly #orders: LiveOrderManager;
  readonly #stockReceiver: SpySipReceiver;
  #contracts: OptionContract[] = [];
  #subscribedSymbols = new Set<string>();
  #optionConnected = false;
  #brokerAvailable = false;
  #positionsReconciled = false;
  #account: AccountState | undefined;
  #marketOpen = false;
  #lastSpot: number | undefined;
  #lastFeature: FeatureSnapshot | undefined;
  #lastRegime: RegimeDecision | undefined;
  #lastOptionQuoteTimestamp: number | undefined;
  #optionQuoteCount = 0;
  #rejectedOptionQuotes = 0;
  #execution: LiveExecutionSnapshot = { halted: false };
  #retainedPositionSymbol: string | undefined;
  #lastError: string | undefined;
  #lastClockCheck = -Infinity;
  #started = false;
  #stopping = false;
  #tickTimer: ReturnType<typeof setInterval> | undefined;
  #optionReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #optionReconnectAttempt = 0;

  constructor(options: SpyOptionsTradingRuntimeOptions) {
    this.#config = options.config;
    this.#client = options.client;
    this.#optionStream = options.optionStream;
    this.#executionEnabled = options.executionEnabled;
    this.#executionMode = options.executionMode ?? "paper";
    this.#killSwitch = options.killSwitch === true;
    this.#now = options.now ?? Date.now;
    this.#executionTickMs = options.executionTickMs ?? 250;
    this.#onEvent = options.onEvent;
    this.#onError = options.onError;
    this.#selector = new OptionSelector(options.config);
    this.#universe = new OptionUniverseManager(options.config);
    this.#signals = new SignalEngine(options.config);
    this.#recorder = options.recorder ?? new MemoryRecorder();
    this.#history = options.history;
    this.#orders = new LiveOrderManager({
      config: options.config,
      client: options.client,
      recorder: this.#recorder,
    });
    this.#stockReceiver = new SpySipReceiver({
      config: options.config,
      stream: options.stockStream,
      now: this.#now,
      onStockQuote: (quote) => this.#onStockQuote(quote),
      onStockTrade: (trade) => this.#recordHistory("stock_trade", trade.timestamp, trade.symbol, { ...trade }),
      onFeature: (feature) => this.ingestFeature(feature),
      onError: (error) => this.#recordError(error),
    });
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("SPY options trading runtime is already started");
    this.#started = true;
    this.#stopping = false;
    try {
      const [account, clock, latestQuote] = await Promise.all([
        this.#client.getAccount(),
        this.#client.getMarketClock(),
        this.#client.getLatestSpySipQuote(),
      ]);
      this.#account = account;
      this.#marketOpen = clock.isOpen;
      this.#lastClockCheck = this.#now();
      if (!account.active) throw new Error("Paper broker account is inactive or blocked");
      if (!account.optionsApproved) throw new Error("Paper broker account is not approved for options");
      this.#execution = await this.#orders.initialize(clock.timestamp);
      this.#positionsReconciled = true;
      this.#brokerAvailable = true;
      this.#lastSpot = (latestQuote.bidPrice + latestQuote.askPrice) / 2;

      await this.#refreshUniverse(this.#lastSpot, clock.timestamp, true);
      const streamStarts = await Promise.allSettled([
        this.#connectOptionStream(),
        this.#stockReceiver.start(),
      ]);
      for (const result of streamStarts) {
        if (result.status === "rejected") this.#recordError(result.reason);
      }
      if (streamStarts[0]?.status === "rejected") this.#scheduleOptionReconnect();
      this.#tickTimer = setInterval(() => this.#scheduleExecutionTick(), this.#executionTickMs);
      this.#emit("trading_runtime_started", {
        executionMode: this.#executionMode,
        executionEnabled: this.#executionEnabled,
        stockFeed: "sip",
        optionFeed: "opra",
        subscribedOptionContracts: this.#subscribedSymbols.size,
        marketOpen: this.#marketOpen,
      });
    } catch (error) {
      this.#recordError(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    if (this.#tickTimer) clearInterval(this.#tickTimer);
    if (this.#optionReconnectTimer) clearTimeout(this.#optionReconnectTimer);
    this.#tickTimer = undefined;
    this.#optionReconnectTimer = undefined;
    await Promise.allSettled([this.#stockReceiver.close(), this.#optionStream.close()]);
    await this.#queue.drained();
    this.#optionConnected = false;
  }

  async ingestFeature(feature: FeatureSnapshot): Promise<void> {
    try {
      await this.#queue.enqueue(async () => {
        this.#recordHistory("feature_snapshot", feature.timestamp, feature.symbol, { ...feature });
        this.#lastFeature = feature;
        this.#lastSpot = feature.price;
        this.#lastRegime = classifyRegime(feature, this.#config.regimes);
        await this.#refreshUniverse(feature.price, this.#now());
        await this.#tickExecution(this.#now());
        if (!this.#executionEnabled || this.#killSwitch || this.#execution.halted ||
            this.#execution.position || this.#execution.pending) return;

        const signal = this.#signals.evaluate(feature, this.#lastRegime);
        if (!signal) return;
        const subscribedContracts = this.#contracts.filter((contract) => this.#subscribedSymbols.has(contract.symbol));
        const selection = this.#selector.select(signal, subscribedContracts, this.#book);
        const candidate = selection.selected;
        const signalEvent = {
          signalId: signal.id,
          timestamp: signal.timestamp,
          direction: signal.direction,
          kind: signal.kind,
          regime: signal.regime,
          projectedMoveBps: signal.projectedMoveBps,
          candidate: candidate?.symbol ?? null,
          rejectionCounts: selection.rejectionCounts,
        };
        await this.#auditRuntime(signal.timestamp, "live_signal_selection", signalEvent);
        this.#emit("live_signal_selection", signalEvent);
        if (!candidate) return;
        const quote = this.#book.get(candidate.symbol)?.quote;
        if (!quote) return;
        const result = await this.#orders.submitEntry({
          timestamp: this.#now(), signal, candidate, quote, killSwitch: this.#killSwitch,
        });
        this.#execution = this.#orders.snapshot();
        const submissionEvent = {
          signalId: signal.id,
          timestamp: this.#now(),
          symbol: candidate.symbol,
          direction: signal.direction,
          submitted: result.submitted,
          reasons: result.reasons,
          brokerOrderId: result.brokerOrder?.id ?? null,
        };
        await this.#auditRuntime(this.#now(), "paper_order_submission_result", submissionEvent);
        this.#emit("paper_order_submission_result", submissionEvent);
      });
    } catch (error) {
      this.#recordError(error);
    }
  }

  healthState(): HealthState {
    const stock = this.#stockReceiver.healthState(this.#killSwitch);
    const brokerReady = !this.#executionEnabled || (this.#brokerAvailable && this.#positionsReconciled && this.#account?.optionsApproved === true);
    const streamsReady = stock.websocketConnected && this.#optionConnected;
    const universeReady = this.#subscribedSymbols.size > 0 || !this.#marketOpen;
    return {
      ...stock,
      ready: streamsReady && brokerReady && universeReady && !this.#execution.halted && !this.#queue.halted,
      brokerRequired: this.#executionEnabled,
      optionDataFeed: "opra",
      receivedOptionQuotes: this.#optionQuoteCount,
      ...(this.#lastOptionQuoteTimestamp !== undefined
        ? { lastOptionQuoteAgeMs: Math.max(0, this.#now() - this.#lastOptionQuoteTimestamp) }
        : {}),
      rejectedMarketEvents: (stock.rejectedMarketEvents ?? 0) + this.#rejectedOptionQuotes,
      reconnectAttempt: Math.max(stock.reconnectAttempt ?? 0, this.#optionReconnectAttempt),
      ...(this.#lastError ? { lastStreamError: this.#lastError } : {}),
      optionWebsocketConnected: this.#optionConnected,
      websocketConnected: streamsReady,
      executionEnabled: this.#executionEnabled,
      executionMode: this.#executionMode,
      accountOptionsApproved: this.#account?.optionsApproved === true,
      positionOpen: this.#execution.position !== undefined,
      pendingOrder: this.#execution.pending !== undefined,
      subscribedOptionContracts: this.#subscribedSymbols.size,
      brokerAvailable: this.#brokerAvailable,
      marketClockState: this.#marketOpen ? "market-open" : "market-closed",
      openOrderCount: this.#execution.pending ? 1 : 0,
      positionsReconciled: this.#positionsReconciled,
      recorderHealthy: this.#recorder.healthy(),
    };
  }

  async #onStockQuote(quote: StockQuote): Promise<void> {
    try {
      await this.#queue.enqueue(async () => {
        this.#recordHistory("stock_quote", quote.timestamp, quote.symbol, { ...quote });
        this.#lastSpot = (quote.bidPrice + quote.askPrice) / 2;
        await this.#refreshUniverse(this.#lastSpot, this.#now());
      });
    } catch (error) {
      this.#recordError(error);
    }
  }

  async #onOptionQuote(quote: OptionQuote): Promise<void> {
    try {
      await this.#queue.enqueue(async () => {
        this.#recordHistory("option_quote", quote.timestamp, quote.symbol, { ...quote });
        this.#optionQuoteCount += 1;
        this.#lastOptionQuoteTimestamp = quote.timestamp;
        if (!this.#book.updateQuote(quote)) this.#rejectedOptionQuotes += 1;
        await this.#tickExecution(this.#now(), quote);
      });
    } catch (error) {
      this.#recordError(error);
    }
  }

  async #refreshUniverse(spot: number, timestamp: number, force = false): Promise<void> {
    if (!force && !this.#universe.shouldRefresh(timestamp)) return;
    const contracts = await this.#client.listOptionContracts();
    this.#contracts = contracts;
    for (const contract of contracts) {
      this.#book.upsertContract(contract);
      this.#recordHistory("option_contract", timestamp, contract.symbol, { ...contract });
    }
    const nextSymbols = new Set(this.#universe.refresh(contracts, spot, timestamp));
    const remove = [...this.#subscribedSymbols].filter((symbol) => !nextSymbols.has(symbol));
    const add = [...nextSymbols].filter((symbol) => !this.#subscribedSymbols.has(symbol));
    if (remove.length > 0) await this.#optionStream.unsubscribe(remove);
    if (add.length > 0) await this.#optionStream.subscribe(add);
    this.#subscribedSymbols = nextSymbols;
    if (nextSymbols.size > 0) {
      const snapshots = await this.#client.getOptionSnapshots([...nextSymbols]);
      for (const snapshot of snapshots) {
        this.#book.updateSnapshot(snapshot);
        this.#recordHistory("option_snapshot", snapshot.timestamp ?? timestamp, snapshot.symbol, { ...snapshot });
      }
    }
    this.#emit("option_universe_refreshed", {
      contractCount: contracts.length,
      subscribedOptionContracts: nextSymbols.size,
      added: add.length,
      removed: remove.length,
    });
  }

  #scheduleExecutionTick(): void {
    if (this.#stopping) return;
    void this.#queue.enqueue(() => this.#tickExecution(this.#now()))
      .catch((error: unknown) => this.#recordError(error));
  }

  async #connectOptionStream(): Promise<void> {
    await this.#optionStream.connect({
      onQuote: (quote) => this.#onOptionQuote(quote),
      onState: (connected) => {
        this.#optionConnected = connected;
        if (connected) {
          this.#optionReconnectAttempt = 0;
          this.#lastError = undefined;
        } else if (this.#started && !this.#stopping) {
          this.#scheduleOptionReconnect();
        }
      },
      onError: (error) => this.#recordError(error),
    });
  }

  #scheduleOptionReconnect(): void {
    if (this.#stopping || this.#optionReconnectTimer) return;
    this.#optionReconnectAttempt += 1;
    const delay = Math.min(30_000, 1_000 * (2 ** Math.max(0, this.#optionReconnectAttempt - 1)));
    this.#optionReconnectTimer = setTimeout(() => {
      this.#optionReconnectTimer = undefined;
      void (async () => {
        try {
          await this.#optionStream.close();
          await this.#connectOptionStream();
        } catch (error) {
          this.#recordError(error);
          this.#scheduleOptionReconnect();
        }
      })();
    }, delay);
  }

  async #tickExecution(timestamp: number, optionQuote?: OptionQuote): Promise<void> {
    if (!this.#executionEnabled || this.#execution.halted) return;
    if (timestamp - this.#lastClockCheck >= 30_000) {
      const clock = await this.#client.getMarketClock();
      this.#marketOpen = clock.isOpen;
      this.#lastClockCheck = timestamp;
    }
    this.#execution = await this.#orders.tick({
      timestamp,
      ...(optionQuote ? { optionQuote } : {}),
      ...(this.#lastFeature ? { feature: this.#lastFeature } : {}),
      ...(this.#lastRegime ? { regime: this.#lastRegime } : {}),
      killSwitch: this.#killSwitch,
    });
    this.#synchronizePositionLifecycle();
  }

  #synchronizePositionLifecycle(): void {
    const symbol = this.#execution.position?.symbol;
    if (symbol && symbol !== this.#retainedPositionSymbol) {
      this.#universe.retainOpenPosition(symbol, this.#now());
      this.#retainedPositionSymbol = symbol;
      this.#signals.recordEntry(this.#execution.position!.direction, this.#execution.position!.entryTimestamp);
    } else if (!symbol && this.#retainedPositionSymbol) {
      this.#universe.releaseClosedPosition(this.#retainedPositionSymbol);
      this.#retainedPositionSymbol = undefined;
    }
  }

  #recordError(error: unknown): void {
    this.#lastError = error instanceof Error ? error.message : String(error);
    this.#onError?.(error);
  }

  async #auditRuntime(timestamp: number, type: string, data: Record<string, unknown>): Promise<void> {
    await this.#recorder.record({
      timestamp,
      marketDate: marketDate(timestamp, this.#config.timeZone),
      type,
      configVersion: this.#config.version,
      data,
    });
    if (!this.#recorder.healthy()) throw new Error("Runtime audit recorder is unhealthy");
  }

  #recordHistory(type: HistoricalMarketEventType, providerTimestamp: number, symbol: string, data: Record<string, unknown>): void {
    if (!this.#history) return;
    const receivedTimestamp = this.#now();
    this.#history.recordMarketEvent({
      type,
      providerTimestamp,
      receivedTimestamp,
      marketDate: marketDate(receivedTimestamp, this.#config.timeZone),
      symbol,
      data,
    });
  }

  #emit(type: string, data: Record<string, unknown>): void { this.#onEvent?.(type, data); }
}
