import type { EngineConfig } from "../config.js";
import type { OptionStream } from "../alpaca/optionStream.js";
import type { StockStream } from "../alpaca/stockStream.js";
import type { TradingRestClient } from "../alpaca/restClient.js";
import type {
  AccountState, FeatureSnapshot, OptionContract, OptionQuote, RegimeDecision, StockQuote,
} from "../types.js";
import type { HealthState } from "../ops/healthServer.js";
import type { AuditEvent, AuditRecorder } from "../ops/recorder.js";
import type { HistoricalMarketEvent, MarketHistorySink, HistoricalMarketEventType } from "../history/types.js";
import { MemoryRecorder } from "../ops/recorder.js";
import { SerializedDecisionQueue } from "../execution/tradingEngine.js";
import { LiveOrderManager, type LiveExecutionSnapshot } from "../execution/liveOrderManager.js";
import { OptionBook } from "../options/optionBook.js";
import { OptionSelector } from "../options/optionSelector.js";
import { OptionUniverseManager } from "../options/optionUniverse.js";
import {
  SignalEngine, type RestoredSignalState, type SignalEvaluation,
} from "../strategy/signalEngine.js";
import { classifyRegime } from "../strategy/regimeClassifier.js";
import { SpySipReceiver } from "./spySipReceiver.js";
import { isAtOrAfter, marketDate, parseClock, secondsSinceMidnight, zonedDateTimeToEpoch } from "../utils/time.js";
import type { DailyRiskState } from "../risk/riskManager.js";

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
  requireStrategyRecovery?: boolean;
  restoredAuditEvents?: readonly AuditEvent[];
  loadStockHistory?: (
    marketDate: string, startReceivedTimestamp: number, endReceivedTimestamp: number,
    quoteStartReceivedTimestamp?: number,
  ) => AsyncIterable<readonly HistoricalMarketEvent[]>;
  restoredFeatureCheckpoint?: FeatureSnapshot;
}

export function optionUniverseRequired(
  now: number, marketOpen: boolean, hasOptionExposure: boolean, config: EngineConfig,
): boolean {
  return marketOpen && (
    hasOptionExposure ||
    secondsSinceMidnight(now, config.timeZone) <= parseClock(config.options.zeroDteEntryCutoff)
  );
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
  readonly #requireStrategyRecovery: boolean;
  readonly #loadStockHistory: SpyOptionsTradingRuntimeOptions["loadStockHistory"];
  readonly #queue = new SerializedDecisionQueue();
  readonly #book = new OptionBook();
  readonly #selector: OptionSelector;
  readonly #universe: OptionUniverseManager;
  readonly #signals: SignalEngine;
  readonly #shadowSignals: SignalEngine | undefined;
  readonly #orders: LiveOrderManager;
  readonly #stockReceiver: SpySipReceiver;
  readonly #restoredRuntimeState: RestoredRuntimeState;
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
  #strategyStateReady = false;
  #strategyStateStatus = "NOT_RESTORED";
  #strategyStateMarketDate: string | undefined;
  #strategyCoverageStartedAtOpen = false;
  #restoredStockEvents = 0;
  #restoredFeatureBars = 0;
  #strategyRecoveryError: string | undefined;
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
    this.#requireStrategyRecovery = options.requireStrategyRecovery === true;
    this.#loadStockHistory = options.loadStockHistory;
    this.#selector = new OptionSelector(options.config);
    this.#universe = new OptionUniverseManager(options.config);
    this.#signals = new SignalEngine(options.config);
    if (options.config.signals.shadowFollowThroughScope !== "DISABLED") {
      const shadowConfig = structuredClone(options.config);
      shadowConfig.signals.followThroughScope = options.config.signals.shadowFollowThroughScope;
      this.#shadowSignals = new SignalEngine(shadowConfig);
    } else this.#shadowSignals = undefined;
    if (options.restoredFeatureCheckpoint) {
      this.#lastFeature = options.restoredFeatureCheckpoint;
      this.#lastSpot = options.restoredFeatureCheckpoint.price;
      this.#lastRegime = classifyRegime(options.restoredFeatureCheckpoint, options.config.regimes);
    }
    const restored = restoreRuntimeState(options.restoredAuditEvents ?? [], this.#now(), options.config.timeZone);
    this.#restoredRuntimeState = restored;
    this.#signals.restoreState(restored.signal);
    this.#shadowSignals?.restoreState(restored.signal);
    this.#recorder = options.recorder ?? new MemoryRecorder();
    this.#history = options.history;
    this.#orders = new LiveOrderManager({
      config: options.config,
      client: options.client,
      recorder: this.#recorder,
      restoredRiskState: restored.risk,
      knownClientOrderIds: restored.knownClientOrderIds,
    });
    this.#stockReceiver = new SpySipReceiver({
      config: options.config,
      stream: options.stockStream,
      now: this.#now,
      onStockQuote: (quote) => this.#onStockQuote(quote),
      onStockTrade: (trade) => this.#recordHistory("stock_trade", trade.timestamp, trade.symbol, { ...trade }),
      onFeature: (feature) => this.ingestFeature(feature),
      onError: (error) => this.#recordError(error),
      ...(options.restoredFeatureCheckpoint ? { featureCheckpoint: options.restoredFeatureCheckpoint } : {}),
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
      await this.#stockReceiver.startBuffered();
      await this.#restoreStrategyState(Math.max(clock.timestamp, this.#now()));
      this.#execution = await this.#orders.initialize(clock.timestamp);
      await this.#auditRuntime(clock.timestamp, "daily_risk_state_recovery", {
        marketDate: this.#restoredRuntimeState.risk.marketDate,
        restoredEntries: this.#restoredRuntimeState.risk.entries,
        restoredRealizedPnl: this.#restoredRuntimeState.risk.realizedPnl,
        maxTradesPerDay: this.#config.risk.maxTradesPerDay,
        maxDailyLossDollars: this.#config.risk.maxDailyLossDollars,
        entryCapReached: this.#restoredRuntimeState.risk.entries >= this.#config.risk.maxTradesPerDay,
        knownClientOrderIds: this.#restoredRuntimeState.knownClientOrderIds.size,
      });
      this.#synchronizeHistoryPriorities();
      this.#positionsReconciled = true;
      this.#brokerAvailable = true;
      this.#lastSpot = (latestQuote.bidPrice + latestQuote.askPrice) / 2;

      await this.#refreshUniverse(this.#lastSpot, clock.timestamp, true);
      const streamStarts = await Promise.allSettled([this.#connectOptionStream()]);
      for (const result of streamStarts) {
        if (result.status === "rejected") this.#recordError(result.reason);
      }
      if (streamStarts[0]?.status === "rejected") this.#scheduleOptionReconnect();
      const catchup = await this.#stockReceiver.activate();
      if (catchup.latestFeature) {
        this.#lastFeature = catchup.latestFeature;
        this.#lastSpot = catchup.latestFeature.price;
        this.#lastRegime = classifyRegime(catchup.latestFeature, this.#config.regimes);
        this.#updateStrategyState(catchup.latestFeature);
      }
      this.#emit("strategy_live_catchup", {
        events: catchup.events,
        bars: catchup.bars,
        rejectedEvents: catchup.rejectedEvents,
        latestFeatureTimestamp: catchup.latestFeature?.timestamp ?? null,
        strategyStateReady: this.#strategyStateReady,
        strategyStateStatus: this.#strategyStateStatus,
      });
      this.#tickTimer = setInterval(() => this.#scheduleExecutionTick(), this.#executionTickMs);
      this.#emit("trading_runtime_started", {
        executionMode: this.#executionMode,
        executionEnabled: this.#executionEnabled,
        stockFeed: "sip",
        optionFeed: "opra",
        subscribedOptionContracts: this.#subscribedSymbols.size,
        marketOpen: this.#marketOpen,
        strategyStateReady: this.#strategyStateReady,
        strategyStateStatus: this.#strategyStateStatus,
        restoredStockEvents: this.#restoredStockEvents,
        restoredFeatureBars: this.#restoredFeatureBars,
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
    this.#history?.setPrioritySymbols?.(new Set());
  }

  async ingestFeature(feature: FeatureSnapshot): Promise<void> {
    try {
      await this.#queue.enqueue(async () => {
        this.#recordHistory("feature_snapshot", feature.timestamp, feature.symbol, { ...feature });
        this.#lastFeature = feature;
        this.#lastSpot = feature.price;
        this.#lastRegime = classifyRegime(feature, this.#config.regimes);
        this.#updateStrategyState(feature);
        await this.#refreshUniverse(feature.price, this.#now());
        await this.#tickExecution(this.#now());
        const shadowEvaluation = this.#shadowSignals?.evaluateDetailed(feature, this.#lastRegime);
        const shadowAudit = shadowEvaluation ? {
          scope: this.#config.signals.shadowFollowThroughScope,
          ...signalEvaluationSummary(shadowEvaluation),
        } : null;
        const runtimeBlocks: string[] = [];
        if (!this.#executionEnabled) runtimeBlocks.push("EXECUTION_DISABLED");
        if (this.#killSwitch) runtimeBlocks.push("KILL_SWITCH");
        if (this.#execution.halted) runtimeBlocks.push("EXECUTION_HALTED");
        if (this.#executionEnabled && !this.#strategyStateReady) runtimeBlocks.push("STRATEGY_STATE_NOT_READY");
        if (this.#execution.position) runtimeBlocks.push("POSITION_ALREADY_OPEN");
        if (this.#execution.pending) runtimeBlocks.push("ORDER_ALREADY_PENDING");
        if (runtimeBlocks.length > 0) {
          await this.#auditRuntime(feature.timestamp, "live_entry_evaluation", {
            timestamp: feature.timestamp,
            decision: "SKIPPED",
            reasons: runtimeBlocks,
            regime: this.#lastRegime.regime,
            regimeConfidence: this.#lastRegime.confidence,
            regimeReasons: this.#lastRegime.reasons,
            directions: [],
            shadowEvaluation: shadowAudit,
            feature: entryFeatureSummary(feature),
          });
          return;
        }

        const evaluation = this.#signals.evaluateDetailed(feature, this.#lastRegime);
        const signal = evaluation.signal;
        await this.#auditRuntime(feature.timestamp, "live_entry_evaluation", {
          timestamp: feature.timestamp,
          decision: signal ? "SIGNAL" : "NO_SIGNAL",
          reasons: evaluation.reasons,
          regime: this.#lastRegime.regime,
          regimeConfidence: this.#lastRegime.confidence,
          regimeReasons: this.#lastRegime.reasons,
          directions: evaluation.directions,
          shadowEvaluation: shadowAudit,
          ...(signal ? {
            signalId: signal.id,
            direction: signal.direction,
            kind: signal.kind,
            projectedMoveBps: signal.projectedMoveBps,
          } : {}),
          feature: entryFeatureSummary(feature),
        });
        if (!signal) return;
        const subscribedContracts = this.#contracts.filter((contract) => this.#subscribedSymbols.has(contract.symbol));
        const decisionTimestamp = this.#now();
        const selection = this.#selector.select(signal, subscribedContracts, this.#book, decisionTimestamp);
        const candidate = selection.selected;
        const quote = candidate ? this.#book.get(candidate.symbol)?.quote : undefined;
        const signalEvent = {
          signalId: signal.id,
          timestamp: signal.timestamp,
          decisionTimestamp,
          direction: signal.direction,
          kind: signal.kind,
          regime: signal.regime,
          projectedMoveBps: signal.projectedMoveBps,
          candidate: candidate?.symbol ?? null,
          candidateMetrics: candidate ? {
            score: candidate.score,
            delta: candidate.delta,
            gamma: candidate.gamma,
            impliedVolatility: candidate.impliedVolatility,
            mid: candidate.mid,
            spreadPct: candidate.spreadPct,
            equivalentUnderlyingCostBps: candidate.equivalentUnderlyingCostBps,
            requiredMoveBps: candidate.requiredMoveBps,
            costMarginBps: candidate.costMarginBps,
          } : null,
          candidateQuote: quote ? {
            timestamp: quote.timestamp,
            bidPrice: quote.bidPrice,
            askPrice: quote.askPrice,
          } : null,
          evaluatedContracts: selection.evaluations.length,
          rejectionCounts: selection.rejectionCounts,
          topCandidates: [...selection.evaluations]
            .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
            .slice(0, 8)
            .map((evaluation) => ({
              symbol: evaluation.symbol,
              eligible: evaluation.eligible,
              ...(evaluation.score !== undefined ? { score: evaluation.score } : {}),
              ...(evaluation.delta !== undefined ? { delta: evaluation.delta } : {}),
              ...(evaluation.spreadPct !== undefined ? { spreadPct: evaluation.spreadPct } : {}),
              ...(evaluation.costMarginBps !== undefined ? { costMarginBps: evaluation.costMarginBps } : {}),
              rejectionReasons: evaluation.rejectionReasons,
            })),
        };
        await this.#auditRuntime(signal.timestamp, "live_signal_selection", signalEvent);
        this.#emit("live_signal_selection", signalEvent);
        if (!candidate) return;
        if (!quote) return;
        this.#history?.setPrioritySymbols?.(new Set([candidate.symbol]));
        let result;
        try {
          result = await this.#orders.submitEntry({
            timestamp: this.#now(), signal, candidate, quote, killSwitch: this.#killSwitch,
          });
        } finally {
          this.#execution = this.#orders.snapshot();
          this.#synchronizeHistoryPriorities();
        }
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
    const hasOptionExposure = this.#execution.position !== undefined || this.#execution.pending !== undefined;
    const universeReady = this.#subscribedSymbols.size > 0 ||
      !optionUniverseRequired(this.#now(), this.#marketOpen, hasOptionExposure, this.#config);
    const strategyReady = !this.#executionEnabled || !this.#marketOpen || this.#strategyStateReady;
    return {
      ...stock,
      ready: streamsReady && brokerReady && universeReady && strategyReady && !this.#execution.halted && !this.#queue.halted,
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
      strategyStateReady: this.#strategyStateReady,
      strategyStateStatus: this.#strategyStateStatus,
      ...(this.#strategyStateMarketDate ? { strategyStateMarketDate: this.#strategyStateMarketDate } : {}),
      restoredStockEvents: this.#restoredStockEvents,
      restoredFeatureBars: this.#restoredFeatureBars,
      ...(this.#strategyRecoveryError ? { strategyRecoveryError: this.#strategyRecoveryError } : {}),
    };
  }

  async #restoreStrategyState(timestamp: number): Promise<void> {
    const date = marketDate(timestamp, this.#config.timeZone);
    this.#strategyStateMarketDate = date;
    if (!this.#requireStrategyRecovery) {
      this.#strategyStateReady = true;
      this.#strategyStateStatus = "RECOVERY_NOT_REQUIRED";
      return;
    }
    if (!isAtOrAfter(timestamp, this.#config.session.marketOpen, this.#config.timeZone)) {
      this.#strategyStateReady = true;
      this.#strategyStateStatus = "WAITING_FOR_MARKET_OPEN";
      return;
    }
    if (!this.#loadStockHistory) {
      this.#strategyStateStatus = "HISTORY_UNAVAILABLE";
      this.#strategyRecoveryError = "Current-session SIP history loader is unavailable";
      return;
    }
    const start = zonedDateTimeToEpoch(date, this.#config.session.marketOpen, this.#config.timeZone);
    const checkpoint = this.#lastFeature;
    const quoteWarmupStart = checkpoint?.openingRange.complete ? Math.max(start, timestamp - 190_000) : undefined;
    try {
      const summary = await this.#stockReceiver.restore(
        this.#loadStockHistory(date, start, timestamp, quoteWarmupStart),
      );
      this.#restoredStockEvents = summary.events;
      this.#restoredFeatureBars = summary.bars;
      const firstSecond = summary.firstProviderTimestamp === undefined
        ? Number.POSITIVE_INFINITY : secondsSinceMidnight(summary.firstProviderTimestamp, this.#config.timeZone);
      this.#strategyCoverageStartedAtOpen = firstSecond <= parseClock(this.#config.session.marketOpen) + 60;
      if (summary.latestFeature) {
        this.#lastFeature = summary.latestFeature;
        this.#lastSpot = summary.latestFeature.price;
        this.#lastRegime = classifyRegime(summary.latestFeature, this.#config.regimes);
        this.#updateStrategyState(summary.latestFeature);
      }
      if (!this.#strategyStateReady) this.#strategyStateStatus = "RESTORED_STATE_INCOMPLETE";
      await this.#auditRuntime(timestamp, "strategy_state_recovery", {
        marketDate: date,
        ready: this.#strategyStateReady,
        status: this.#strategyStateStatus,
        events: summary.events,
        quotes: summary.quotes,
        trades: summary.trades,
        bars: summary.bars,
        rejectedEvents: summary.rejectedEvents,
        coverageStartedAtOpen: this.#strategyCoverageStartedAtOpen,
        latestFeatureTimestamp: summary.latestFeature?.timestamp ?? null,
        openingRangeComplete: summary.latestFeature?.openingRange.complete ?? false,
        sessionVwapAvailable: summary.latestFeature?.vwap.sessionVwap !== undefined,
        checkpointUsed: quoteWarmupStart !== undefined,
      });
    } catch (error) {
      this.#strategyStateReady = false;
      this.#strategyStateStatus = "RECOVERY_FAILED";
      this.#strategyRecoveryError = error instanceof Error ? error.message : String(error);
      await this.#auditRuntime(timestamp, "strategy_state_recovery", {
        marketDate: date, ready: false, status: this.#strategyStateStatus, error: this.#strategyRecoveryError,
      });
      this.#onError?.(error);
    }
  }

  #updateStrategyState(feature: FeatureSnapshot): void {
    if (!this.#requireStrategyRecovery) {
      this.#strategyStateReady = true;
      this.#strategyStateStatus = "RECOVERY_NOT_REQUIRED";
      return;
    }
    if (feature.marketDate !== this.#strategyStateMarketDate) {
      this.#strategyStateMarketDate = feature.marketDate;
      this.#strategyStateReady = false;
      this.#strategyCoverageStartedAtOpen = false;
    }
    const second = secondsSinceMidnight(feature.timestamp, this.#config.timeZone);
    if (second <= parseClock(this.#config.session.marketOpen) + 60) this.#strategyCoverageStartedAtOpen = true;
    if (second < parseClock(this.#config.session.entryStart)) {
      this.#strategyStateReady = this.#strategyCoverageStartedAtOpen;
      this.#strategyStateStatus = this.#strategyStateReady ? "BUILDING_OPENING_RANGE" : "MISSING_MARKET_OPEN_COVERAGE";
      return;
    }
    const featureFresh = this.#now() - feature.timestamp <= 5_000 && feature.timestamp - this.#now() <= 1_000;
    this.#strategyStateReady = this.#strategyCoverageStartedAtOpen && feature.openingRange.complete &&
      feature.vwap.sessionVwap !== undefined && feature.dataValid && featureFresh;
    this.#strategyStateStatus = this.#strategyStateReady ? "READY"
      : !featureFresh ? "STALE_RECOVERED_FEATURE"
      : !feature.dataValid ? "FEATURE_WARMUP"
      : "INCOMPLETE_SESSION_STATE";
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
    this.#synchronizeHistoryPriorities();
  }

  #synchronizeHistoryPriorities(): void {
    const symbol = this.#execution.position?.symbol ?? this.#execution.pending?.order.symbol;
    this.#history?.setPrioritySymbols?.(symbol ? new Set([symbol]) : new Set());
  }

  #synchronizePositionLifecycle(): void {
    const symbol = this.#execution.position?.symbol;
    if (symbol && symbol !== this.#retainedPositionSymbol) {
      this.#universe.retainOpenPosition(symbol, this.#now());
      this.#retainedPositionSymbol = symbol;
      this.#signals.recordEntry(this.#execution.position!.direction, this.#execution.position!.entryTimestamp);
      this.#shadowSignals?.recordEntry(this.#execution.position!.direction, this.#execution.position!.entryTimestamp);
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

function entryFeatureSummary(feature: FeatureSnapshot): Record<string, unknown> {
  return {
    price: feature.price,
    dataValid: feature.dataValid,
    invalidReasons: feature.invalidReasons,
    spreadBps: feature.spreadBps,
    quoteAgeMs: feature.quoteAgeMs,
    fastSlope: feature.fast.normalizedSlope,
    fastAcceleration: feature.fast.normalizedAcceleration,
    mediumSlope: feature.medium.normalizedSlope,
    slowSlope: feature.slow.normalizedSlope,
    ofi5: feature.ofi5,
    ofi15: feature.ofi15,
    efficiency60: feature.efficiency60,
    sessionVwap: feature.vwap.sessionVwap ?? null,
    openingRangeComplete: feature.openingRange.complete,
    nearOpeningHigh: feature.openingRange.nearHigh,
    nearOpeningLow: feature.openingRange.nearLow,
    thresholds: feature.thresholds,
  };
}

function signalEvaluationSummary(evaluation: SignalEvaluation): Record<string, unknown> {
  const signal = evaluation.signal;
  return {
    decision: signal ? "SIGNAL" : "NO_SIGNAL",
    reasons: evaluation.reasons,
    directions: evaluation.directions,
    ...(signal ? {
      signalId: signal.id,
      direction: signal.direction,
      kind: signal.kind,
      regime: signal.regime,
      projectedMoveBps: signal.projectedMoveBps,
    } : {}),
  };
}

export interface RestoredRuntimeState {
  signal: RestoredSignalState;
  risk: DailyRiskState;
  knownClientOrderIds: Set<string>;
}

export function restoreRuntimeState(
  events: readonly AuditEvent[], timestamp: number, timeZone: string,
): RestoredRuntimeState {
  const date = marketDate(timestamp, timeZone);
  const knownClientOrderIds = new Set<string>();
  const filledEntries = new Set<string>();
  const lastEntries: RestoredSignalState["lastEntries"] = {};
  let lastSignalTimestamp: number | undefined;
  let realizedPnl = 0;

  for (const event of events) {
    if (event.type === "broker_order_request") {
      const order = objectValue(event.data.order);
      const clientOrderId = stringValue(order.clientOrderId);
      if (clientOrderId) knownClientOrderIds.add(clientOrderId);
    }
    const eventDate = event.marketDate ?? marketDate(event.timestamp, timeZone);
    if (eventDate !== date) continue;
    if (event.type === "live_entry_evaluation" && event.data.decision === "SIGNAL") {
      lastSignalTimestamp = Math.max(lastSignalTimestamp ?? -Infinity, event.timestamp);
    } else if (event.type === "entry_fill") {
      const position = objectValue(event.data.position);
      const direction = directionValue(position.direction);
      const entryTimestamp = finiteNumber(position.entryTimestamp) ?? event.timestamp;
      const symbol = stringValue(position.symbol) ?? "UNKNOWN";
      const identity = stringValue(event.data.signalId) ?? `${symbol}-${entryTimestamp}`;
      filledEntries.add(identity);
      if (direction) lastEntries[direction] = Math.max(lastEntries[direction] ?? -Infinity, entryTimestamp);
    } else if (event.type === "exit_fill") {
      realizedPnl += finiteNumber(event.data.realizedPnl) ?? 0;
    }
  }

  return {
    signal: {
      ...(lastSignalTimestamp !== undefined ? { lastSignalTimestamp } : {}),
      lastEntries,
    },
    risk: { marketDate: date, entries: filledEntries.size, realizedPnl },
    knownClientOrderIds,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function directionValue(value: unknown): "BULLISH" | "BEARISH" | undefined {
  return value === "BULLISH" || value === "BEARISH" ? value : undefined;
}
