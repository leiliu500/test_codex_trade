import type { EngineConfig, FollowThroughScope } from "../config.js";
import type { OptionStream } from "../alpaca/optionStream.js";
import { AlpacaOptionFeatureEngine } from "../alpaca/optionFeatures.js";
import type { StockStream } from "../alpaca/stockStream.js";
import type { StockStreamEvent } from "../alpaca/stockStream.js";
import type { TradingRestClient } from "../alpaca/restClient.js";
import type { AlpacaTradeUpdate } from "../alpaca/tradingStream.js";
import type { MarketStreamTelemetry } from "../marketData/streamTelemetry.js";
import {
  isUnderlyingSymbol, type AccountState, type FeatureSnapshot, type OptionCandidateEvaluation,
  type OptionContract, type OptionQuote, type RegimeDecision, type StockQuote, type TradeSignal,
  type UnderlyingSymbol,
} from "../types.js";
import type { HealthState } from "../ops/healthServer.js";
import type { AuditEvent, AuditRecorder } from "../ops/recorder.js";
import type { HistoricalMarketEvent, MarketHistorySink, HistoricalMarketEventType } from "../history/types.js";
import { MemoryRecorder } from "../ops/recorder.js";
import { SerializedDecisionQueue } from "../execution/tradingEngine.js";
import { LiveOrderManager, type LiveExecutionSnapshot } from "../execution/liveOrderManager.js";
import { OptionBook } from "../options/optionBook.js";
import {
  OptionSelector, relevantOptionEvaluations, retryableOptionEvaluations, type SelectionResult,
} from "../options/optionSelector.js";
import { OptionUniverseManager } from "../options/optionUniverse.js";
import {
  isProtectedProfitExit, SignalEngine, type RestoredSignalState, type SignalEvaluation,
} from "../strategy/signalEngine.js";
import { classifyRegime } from "../strategy/regimeClassifier.js";
import { SpySipReceiver } from "./spySipReceiver.js";
import { isAtOrAfter, marketDate, parseClock, secondsSinceMidnight, zonedDateTimeToEpoch } from "../utils/time.js";
import type { DailyRiskState } from "../risk/riskManager.js";
import type { PortfolioRiskCoordinator } from "../risk/portfolioRiskCoordinator.js";
import { lateEntryGuardAudit, morningEntryGuardAudit } from "../strategy/lateEntryGuard.js";
import { validateOptionQuote } from "../features/quoteSanitizer.js";
import { parseOccSymbol } from "../options/occSymbol.js";
import {
  currentBullishProjectionBps, evaluateLateBullishGrindOptionConfirmation,
  requiresLateBullishGrindOptionConfirmation,
} from "../strategy/lateBullishGrindConfirmation.js";
import { performance } from "node:perf_hooks";
import {
  assessRestQuote,
  OpraQuoteHealthMonitor,
  optionQuoteFingerprint,
  StaleQuoteCircuitBreaker,
  type OpraChainHealth,
  type OpraQuoteDiagnosis,
  type OpraQuoteObservation,
} from "../marketData/opraQuoteHealth.js";

export interface SpyOptionsRuntimeClient extends TradingRestClient {
  getLatestUnderlyingSipQuote?(underlying: UnderlyingSymbol): Promise<StockQuote>;
  /** Legacy SPY-only adapter compatibility. */
  getLatestSpySipQuote?(): Promise<StockQuote>;
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
  monotonicNow?: () => number;
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
  portfolioRisk?: PortfolioRiskCoordinator;
  tradeUpdatesRequired?: boolean;
  tradeUpdateTelemetry?: () => MarketStreamTelemetry | undefined;
}

export function optionUniverseRequired(
  now: number, marketOpen: boolean, hasOptionExposure: boolean, config: EngineConfig,
): boolean {
  return marketOpen && (
    hasOptionExposure ||
    secondsSinceMidnight(now, config.timeZone) <= parseClock(config.options.zeroDteEntryCutoff)
  );
}

const OPEN_MARKET_CLOCK_POLL_MS = 5_000;
const CLOSED_MARKET_CLOCK_POLL_MS = 30_000;
export const OPTION_QUOTE_STALL_TIMEOUT_MS = 10_000;
const OPTION_REST_RECOVERY_INTERVAL_MS = 1_000;

interface PendingLateBullishGrindConfirmation {
  signal: TradeSignal;
  candidate: OptionCandidateEvaluation;
  armedAt: number;
  referenceBidPrice: number;
}

interface PendingOptionSelection {
  signal: TradeSignal;
  armedAt: number;
  expiresAt: number;
  attempts: number;
  lastSelection: SelectionResult;
}

/** End-to-end, serialized single-underlying 0DTE option execution runtime. */
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
  readonly #monotonicNow: () => number;
  readonly #executionTickMs: number;
  readonly #onEvent: ((type: string, data: Record<string, unknown>) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #requireStrategyRecovery: boolean;
  readonly #loadStockHistory: SpyOptionsTradingRuntimeOptions["loadStockHistory"];
  readonly #tradeUpdatesRequired: boolean;
  readonly #tradeUpdateTelemetry: (() => MarketStreamTelemetry | undefined) | undefined;
  readonly #queue = new SerializedDecisionQueue();
  readonly #book = new OptionBook();
  readonly #selector: OptionSelector;
  readonly #universe: OptionUniverseManager;
  readonly #signals: SignalEngine;
  readonly #lateEntryBaselineSignals: SignalEngine | undefined;
  readonly #shadowSignals = new Map<FollowThroughScope, SignalEngine>();
  readonly #orders: LiveOrderManager;
  readonly #stockReceiver: SpySipReceiver;
  readonly #restoredRuntimeState: RestoredRuntimeState;
  readonly #optionHealth: OpraQuoteHealthMonitor;
  readonly #alpacaOptionFeatures: AlpacaOptionFeatureEngine;
  readonly #optionRestCircuit = new StaleQuoteCircuitBreaker();
  readonly #rawObservedQuotes = new WeakMap<OptionQuote, OpraQuoteObservation>();
  readonly #lastOptionRestFingerprints = new Map<string, string>();
  #contracts: OptionContract[] = [];
  #optionUniverseInitialized = false;
  #subscribedSymbols = new Set<string>();
  #optionConnected = false;
  #brokerAvailable = false;
  #positionsReconciled = false;
  #tradeUpdatesConnected = false;
  #account: AccountState | undefined;
  #marketOpen = false;
  #marketDataIdle = false;
  #marketDataTransition: Promise<void> = Promise.resolve();
  #universeRefreshInFlight: Promise<void> | undefined;
  #lastSpot: number | undefined;
  #lastFeature: FeatureSnapshot | undefined;
  #lastRegime: RegimeDecision | undefined;
  #optionQuoteCount = 0;
  #rejectedOptionQuotes = 0;
  #optionQuoteStalled = false;
  #optionRestRecoveryInFlight: Promise<void> | undefined;
  #lastOptionRestFallbackAt: number | undefined;
  #lastOptionRestFallbackMonotonicTimestamp = -Infinity;
  #lastOptionRestQuoteTimestamp: number | undefined;
  #optionRestFallbackRequests = 0;
  #optionRestFallbackFreshQuotes = 0;
  #optionRestRepeatedQuotes = 0;
  #lastOptionRestFallbackError: string | undefined;
  #lastOptionDiagnosis: OpraQuoteDiagnosis | undefined;
  #providerDelayDiagnosticReconnectAttempted = false;
  #execution: LiveExecutionSnapshot = { halted: false, lifecycle: "FLAT", safeMode: false };
  #pendingOptionSelection: PendingOptionSelection | undefined;
  #pendingLateBullishGrindConfirmation: PendingLateBullishGrindConfirmation | undefined;
  #retainedPositionSymbol: string | undefined;
  #lastError: string | undefined;
  #lastClockCheck = -Infinity;
  #marketClockAvailable = false;
  #lastMarketClockError: string | undefined;
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
  #optionReconnectInProgress = false;

  constructor(options: SpyOptionsTradingRuntimeOptions) {
    this.#config = options.config;
    this.#client = options.client;
    this.#optionStream = options.optionStream;
    this.#executionEnabled = options.executionEnabled;
    this.#executionMode = options.executionMode ?? "paper";
    this.#killSwitch = options.killSwitch === true;
    this.#now = options.now ?? Date.now;
    this.#monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
    this.#optionHealth = new OpraQuoteHealthMonitor({
      executionMaxQuoteAgeMs: options.config.dataQuality.maxOptionQuoteAgeMs,
      transportTimeoutMs: OPTION_QUOTE_STALL_TIMEOUT_MS,
    });
    this.#alpacaOptionFeatures = new AlpacaOptionFeatureEngine({
      windowMs: options.config.risk.alpacaOptionFeatures.windowMs,
      maximumQuoteAgeMs: options.config.dataQuality.maxOptionQuoteAgeMs,
    });
    this.#executionTickMs = options.executionTickMs ?? 250;
    this.#onEvent = options.onEvent;
    this.#onError = options.onError;
    this.#requireStrategyRecovery = options.requireStrategyRecovery === true;
    this.#loadStockHistory = options.loadStockHistory;
    this.#tradeUpdatesRequired = options.tradeUpdatesRequired === true;
    this.#tradeUpdateTelemetry = options.tradeUpdateTelemetry;
    this.#selector = new OptionSelector(options.config);
    this.#universe = new OptionUniverseManager(options.config);
    this.#signals = new SignalEngine(options.config);
    if (options.config.signals.lateEntryGuard.mode === "ENFORCE" ||
        options.config.signals.morningEntryGuard.mode === "ENFORCE") {
      const lateEntryBaselineConfig = structuredClone(options.config);
      lateEntryBaselineConfig.signals.lateEntryGuard.mode = "DISABLED";
      lateEntryBaselineConfig.signals.morningEntryGuard.mode = "DISABLED";
      lateEntryBaselineConfig.signals.entryConfirmationMode = "SHADOW";
      this.#lateEntryBaselineSignals = new SignalEngine(lateEntryBaselineConfig);
    }
    if (options.config.signals.shadowFollowThroughScope !== "DISABLED") {
      for (const scope of ["BULLISH_IMPULSE", "IMPULSE", "ALL"] as const) {
        const shadowConfig = structuredClone(options.config);
        shadowConfig.signals.entryConfirmationMode = "ENFORCE";
        shadowConfig.signals.followThroughScope = scope;
        this.#shadowSignals.set(scope, new SignalEngine(shadowConfig));
      }
    }
    if (options.restoredFeatureCheckpoint) {
      if (options.restoredFeatureCheckpoint.symbol !== options.config.symbol) {
        throw new Error(
          `${options.config.symbol} runtime received a ${options.restoredFeatureCheckpoint.symbol} feature checkpoint`,
        );
      }
      this.#lastFeature = options.restoredFeatureCheckpoint;
      this.#lastSpot = options.restoredFeatureCheckpoint.price;
      this.#lastRegime = classifyRegime(options.restoredFeatureCheckpoint, options.config.regimes);
    }
    const restored = restoreRuntimeState(
      options.restoredAuditEvents ?? [], this.#now(), options.config.timeZone, options.config.symbol,
    );
    this.#restoredRuntimeState = restored;
    this.#signals.restoreState(restored.signal);
    this.#lateEntryBaselineSignals?.restoreState(restored.signal);
    for (const engine of this.#shadowSignals.values()) engine.restoreState(restored.signal);
    this.#recorder = options.recorder ?? new MemoryRecorder();
    this.#history = options.history;
    this.#orders = new LiveOrderManager({
      config: options.config,
      client: options.client,
      recorder: this.#recorder,
      onCompletedExit: (exit) => {
        this.#signals.recordCompletedExit(
          exit.direction, exit.timestamp, exit.reason, exit.realizedPnl,
        );
        this.#lateEntryBaselineSignals?.recordCompletedExit(
          exit.direction, exit.timestamp, exit.reason, exit.realizedPnl,
        );
        for (const engine of this.#shadowSignals.values()) {
          engine.recordCompletedExit(exit.direction, exit.timestamp, exit.reason, exit.realizedPnl);
        }
      },
      restoredRiskState: restored.risk,
      knownClientOrderIds: restored.knownClientOrderIds,
      ...(options.portfolioRisk ? { portfolioRisk: options.portfolioRisk } : {}),
    });
    this.#stockReceiver = new SpySipReceiver({
      config: options.config,
      stream: options.stockStream,
      now: this.#now,
      onStockEvents: (events) => this.#onStockEvents(events),
      onFeature: (feature) => this.ingestFeature(feature),
      onError: (error) => this.#recordError(error),
      ...(options.restoredFeatureCheckpoint ? { featureCheckpoint: options.restoredFeatureCheckpoint } : {}),
    });
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error(`${this.#config.symbol} options trading runtime is already started`);
    this.#started = true;
    this.#stopping = false;
    try {
      const [account, clock] = await Promise.all([
        this.#client.getAccount(),
        this.#client.getMarketClock(),
      ]);
      this.#account = account;
      this.#marketOpen = clock.isOpen;
      this.#lastClockCheck = this.#now();
      this.#marketClockAvailable = true;
      this.#lastMarketClockError = undefined;
      if (!account.active) throw new Error("Paper broker account is inactive or blocked");
      if (!account.optionsApproved) throw new Error("Paper broker account is not approved for options");
      if (clock.isOpen) {
        await this.#stockReceiver.startBuffered();
        await this.#restoreStrategyState(Math.max(clock.timestamp, this.#now()));
      } else {
        this.#strategyStateReady = false;
        this.#strategyStateStatus = "MARKET_CLOSED_IDLE";
        this.#strategyStateMarketDate = marketDate(clock.timestamp, this.#config.timeZone);
      }
      this.#execution = await this.#orders.initialize(clock.timestamp);
      await this.#auditRuntime(clock.timestamp, "runtime_config_snapshot", {
        config: this.#config,
        executionMode: this.#executionMode,
        executionEnabled: this.#executionEnabled,
        executionTickMs: this.#executionTickMs,
      });
      await this.#auditRuntime(clock.timestamp, "daily_risk_state_recovery", {
        marketDate: this.#restoredRuntimeState.risk.marketDate,
        restoredEntries: this.#restoredRuntimeState.risk.entries,
        restoredRealizedPnl: this.#restoredRuntimeState.risk.realizedPnl,
        entryConfirmationMode: this.#config.signals.entryConfirmationMode,
        activeMaxTradesPerDay: this.#config.risk.maxTradesPerDay,
        maxTradesPerDay: this.#config.risk.maxTradesPerDay,
        lateMaxDailyEntries: this.#config.signals.lateEntryGuard.maxDailyEntries,
        maxDailyLossDollars: this.#config.risk.maxDailyLossDollars,
        activeEntryCapReached: this.#restoredRuntimeState.risk.entries >= this.#config.risk.maxTradesPerDay,
        entryCapReached: this.#restoredRuntimeState.risk.entries >= this.#config.risk.maxTradesPerDay,
        lateEntryCapReached: this.#restoredRuntimeState.risk.entries >=
          this.#config.signals.lateEntryGuard.maxDailyEntries,
        knownClientOrderIds: this.#restoredRuntimeState.knownClientOrderIds.size,
      });
      this.#synchronizeHistoryPriorities();
      this.#positionsReconciled = !this.#tradeUpdatesRequired || this.#tradeUpdatesConnected;
      this.#brokerAvailable = true;
      if (clock.isOpen) {
        const latestQuote = await this.#getLatestSipQuote();
        this.#lastSpot = (latestQuote.bidPrice + latestQuote.askPrice) / 2;
        await this.#startUniverseRefresh(this.#lastSpot, clock.timestamp, true);
        const streamStarts = await Promise.allSettled([this.#connectOptionStream()]);
        for (const result of streamStarts) {
          if (result.status === "rejected") this.#recordError(result.reason);
        }
        if (streamStarts[0]?.status === "rejected" && !this.#optionStream.reconnectManaged) {
          this.#scheduleOptionReconnect();
        }
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
      } else {
        this.#marketDataIdle = true;
        await this.#auditRuntime(clock.timestamp, "market_session_idle", {
          reason: "STARTUP_MARKET_CLOSED",
          marketOpen: false,
          controlPlanePollMs: CLOSED_MARKET_CLOCK_POLL_MS,
        });
        this.#emit("market_session_idle", {
          reason: "STARTUP_MARKET_CLOSED",
          controlPlanePollMs: CLOSED_MARKET_CLOCK_POLL_MS,
        });
      }
      this.#tickTimer = setInterval(() => this.#scheduleExecutionTick(), this.#executionTickMs);
      this.#emit("trading_runtime_started", {
        executionMode: this.#executionMode,
        executionEnabled: this.#executionEnabled,
        stockFeed: "sip",
        optionFeed: "opra",
        subscribedOptionContracts: this.#subscribedSymbols.size,
        marketOpen: this.#marketOpen,
        marketDataIdle: this.#marketDataIdle,
        strategyStateReady: this.#strategyStateReady,
        strategyStateStatus: this.#strategyStateStatus,
        restoredStockEvents: this.#restoredStockEvents,
        restoredFeatureBars: this.#restoredFeatureBars,
        entryConfirmationMode: this.#config.signals.entryConfirmationMode,
        activeFollowThroughScope: this.#config.signals.followThroughScope,
        shadowFollowThroughScope: this.#config.signals.shadowFollowThroughScope,
        shadowFollowThroughScopes: [...this.#shadowSignals.keys()],
        lateEntryBaselineEnabled: this.#lateEntryBaselineSignals !== undefined,
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
    await this.#marketDataTransition;
    await Promise.allSettled(this.#universeRefreshInFlight ? [this.#universeRefreshInFlight] : []);
    await Promise.allSettled([this.#stockReceiver.close(), this.#optionStream.close()]);
    await this.#queue.drained();
    this.#optionConnected = false;
    this.#history?.setPrioritySymbols?.(new Set());
  }

  setTradeUpdateConnectionState(connected: boolean): void {
    this.#tradeUpdatesConnected = connected;
    if (!connected && this.#tradeUpdatesRequired) this.#positionsReconciled = false;
  }

  async reconcileTradeUpdateState(timestamp: number): Promise<void> {
    this.#positionsReconciled = false;
    try {
      this.#execution = await this.#orders.reconcileExternalState(timestamp, "TRADE_UPDATE_STREAM_CONNECTED");
      this.#positionsReconciled = true;
      this.#brokerAvailable = true;
      this.#synchronizePositionLifecycle();
      this.#synchronizeHistoryPriorities();
    } catch (error) {
      this.#brokerAvailable = false;
      this.#recordError(error);
      throw error;
    }
  }

  async ingestTradeUpdate(update: AlpacaTradeUpdate): Promise<void> {
    try {
      this.#execution = await this.#orders.applyBrokerOrderUpdate(update.order, update.timestamp);
      this.#positionsReconciled = !this.#tradeUpdatesRequired || this.#tradeUpdatesConnected;
      this.#brokerAvailable = true;
      this.#synchronizePositionLifecycle();
      this.#synchronizeHistoryPriorities();
      this.#emit("broker_trade_update", {
        event: update.event,
        timestamp: update.timestamp,
        orderId: update.order.id,
        clientOrderId: update.order.clientOrderId,
        symbol: update.order.symbol,
        status: update.order.status,
        filledQuantity: update.order.filledQuantity,
      });
    } catch (error) {
      this.#positionsReconciled = false;
      this.#brokerAvailable = false;
      this.#recordError(error);
      throw error;
    }
  }

  async ingestFeature(feature: FeatureSnapshot): Promise<void> {
    try {
      await this.#queue.enqueue(async () => {
        if (feature.symbol !== this.#config.symbol) {
          throw new Error(`${this.#config.symbol} runtime rejected ${feature.symbol} feature state`);
        }
        if (this.#marketDataIdle || !this.#marketOpen) return;
        this.#recordHistory("feature_snapshot", feature.timestamp, feature.symbol, { ...feature });
        this.#lastFeature = feature;
        this.#lastSpot = feature.price;
        this.#lastRegime = classifyRegime(feature, this.#config.regimes);
        this.#updateStrategyState(feature);
        this.#scheduleUniverseRefresh(feature.price, this.#now());
        await this.#tickExecution(this.#now());
        const shadowEvaluations = Object.fromEntries([...this.#shadowSignals.entries()].map(([scope, engine]) => [
          scope,
          { scope, ...signalEvaluationSummary(engine.evaluateDetailed(feature, this.#lastRegime!)) },
        ]));
        const lateEntryBaseline = this.#lateEntryBaselineSignals
          ? {
              mode: "SHADOW",
              guardMode: "DISABLED",
              ...signalEvaluationSummary(this.#lateEntryBaselineSignals.evaluateDetailed(feature, this.#lastRegime)),
            }
          : null;
        const primaryShadowScope = this.#config.signals.shadowFollowThroughScope;
        const shadowAudit = primaryShadowScope === "DISABLED" ? null : shadowEvaluations[primaryShadowScope] ?? null;
        const runtimeBlocks = this.#entryRuntimeBlockReasons(this.#now());
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
            shadowEvaluations,
            morningEntryGuard: morningEntryGuardAudit(this.#config, feature.timestamp),
            morningEntryBaseline: lateEntryBaseline,
            lateEntryGuard: lateEntryGuardAudit(this.#config, feature.timestamp),
            lateEntryBaseline,
            feature: entryFeatureSummary(feature),
          });
          return;
        }

        if (this.#pendingOptionSelection &&
            await this.#advancePendingOptionSelection(this.#now(), feature)) return;

        if (this.#pendingLateBullishGrindConfirmation &&
            await this.#advanceLateBullishGrindConfirmation(feature)) return;

        const evaluation = this.#signals.evaluateDetailed(feature, this.#lastRegime);
        const signal = evaluation.signal;
        const researchOnlyAfterCutoff = signal !== undefined &&
          secondsSinceMidnight(feature.timestamp, this.#config.timeZone) >
            parseClock(this.#config.options.zeroDteEntryCutoff);
        await this.#auditRuntime(feature.timestamp, "live_entry_evaluation", {
          timestamp: feature.timestamp,
          decision: signal ? (researchOnlyAfterCutoff ? "RESEARCH_ONLY" : "SIGNAL") : "NO_SIGNAL",
          reasons: researchOnlyAfterCutoff
            ? [...evaluation.reasons, "ZERO_DTE_ENTRY_CUTOFF_PASSED"] : evaluation.reasons,
          actionability: researchOnlyAfterCutoff ? "RESEARCH_ONLY" : signal ? "ACTIONABLE" : "NONE",
          regime: this.#lastRegime.regime,
          regimeConfidence: this.#lastRegime.confidence,
          regimeReasons: this.#lastRegime.reasons,
          directions: evaluation.directions,
          shadowEvaluation: shadowAudit,
          shadowEvaluations,
          morningEntryGuard: morningEntryGuardAudit(this.#config, feature.timestamp),
          morningEntryBaseline: lateEntryBaseline,
          lateEntryGuard: lateEntryGuardAudit(this.#config, feature.timestamp),
          lateEntryBaseline,
          ...(signal ? {
            signalId: signal.id,
            direction: signal.direction,
            kind: signal.kind,
            projectedMoveBps: signal.projectedMoveBps,
          } : {}),
          feature: entryFeatureSummary(feature),
        });
        if (!signal || researchOnlyAfterCutoff) return;
        await this.#beginOptionSelection(signal);
      });
    } catch (error) {
      this.#recordError(error);
    }
  }

  async #beginOptionSelection(signal: TradeSignal): Promise<void> {
    const decisionTimestamp = this.#now();
    const selection = this.#selectOptions(signal, decisionTimestamp);
    const candidate = selection.selected;
    const quote = candidate ? this.#book.get(candidate.symbol)?.quote : undefined;
    if (candidate && quote) {
      await this.#recordOptionSelection(signal, signal, selection, decisionTimestamp, "SELECTED", {
        selectionAttempt: 1,
        retryWaitMs: 0,
      });
      await this.#handleSelectedCandidate(signal, candidate, quote, decisionTimestamp);
      return;
    }

    const retryable = retryableOptionEvaluations(signal, selection, this.#config);
    if (this.#config.execution.optionSelectionRetryMs > 0 && retryable.length > 0) {
      this.#pendingOptionSelection = {
        signal,
        armedAt: decisionTimestamp,
        expiresAt: Math.min(
          signal.timestamp + this.#config.execution.entrySignalTtlMs,
          decisionTimestamp + this.#config.execution.optionSelectionRetryMs,
        ),
        attempts: 1,
        lastSelection: selection,
      };
      await this.#recordOptionSelection(signal, signal, selection, decisionTimestamp, "RETRYING", {
        selectionAttempt: 1,
        retryWaitMs: 0,
        retryDeadline: this.#pendingOptionSelection.expiresAt,
        retryableCandidates: retryable.map((evaluation) => evaluation.symbol),
      });
      this.#synchronizeHistoryPriorities();
      return;
    }

    await this.#recordOptionSelection(signal, signal, selection, decisionTimestamp, "NO_ELIGIBLE_OPTION", {
      selectionAttempt: 1,
      retryWaitMs: 0,
      retryOutcome: retryable.length > 0 ? "RETRY_DISABLED" : "STRUCTURAL_REJECTION",
    });
  }

  async #advancePendingOptionSelection(
    decisionTimestamp: number,
    feature = this.#lastFeature,
  ): Promise<boolean> {
    const pending = this.#pendingOptionSelection;
    if (!pending) return false;
    if (decisionTimestamp >= pending.expiresAt) {
      this.#pendingOptionSelection = undefined;
      await this.#recordOptionSelection(
        pending.signal,
        pending.signal,
        pending.lastSelection,
        decisionTimestamp,
        "NO_ELIGIBLE_OPTION",
        {
          selectionAttempt: pending.attempts,
          retryWaitMs: Math.max(0, decisionTimestamp - pending.armedAt),
          retryOutcome: "EXPIRED",
        },
      );
      this.#synchronizeHistoryPriorities();
      return false;
    }

    const runtimeBlocks = this.#entryRuntimeBlockReasons(decisionTimestamp);
    if (runtimeBlocks.length > 0) {
      this.#pendingOptionSelection = undefined;
      await this.#recordOptionSelection(
        pending.signal,
        pending.signal,
        pending.lastSelection,
        decisionTimestamp,
        "NO_ELIGIBLE_OPTION",
        {
          selectionAttempt: pending.attempts,
          retryWaitMs: Math.max(0, decisionTimestamp - pending.armedAt),
          retryOutcome: "RUNTIME_BLOCKED",
          selectionReasons: runtimeBlocks,
        },
      );
      this.#synchronizeHistoryPriorities();
      return false;
    }

    if (!feature || !this.#lastRegime) return true;
    const revalidation = this.#signals.revalidateForEntry(pending.signal, feature, this.#lastRegime);
    if (!revalidation.valid || !revalidation.signal) {
      this.#pendingOptionSelection = undefined;
      await this.#recordOptionSelection(
        pending.signal,
        pending.signal,
        pending.lastSelection,
        decisionTimestamp,
        "NO_ELIGIBLE_OPTION",
        {
          selectionAttempt: pending.attempts,
          retryWaitMs: Math.max(0, decisionTimestamp - pending.armedAt),
          retryOutcome: "SIGNAL_INVALIDATED",
          selectionReasons: revalidation.reasons,
        },
      );
      this.#synchronizeHistoryPriorities();
      return false;
    }

    pending.attempts += 1;
    const selection = this.#selectOptions(revalidation.signal, decisionTimestamp);
    pending.lastSelection = selection;
    const candidate = selection.selected;
    const quote = candidate ? this.#book.get(candidate.symbol)?.quote : undefined;
    if (candidate && quote) {
      this.#pendingOptionSelection = undefined;
      await this.#recordOptionSelection(
        pending.signal,
        revalidation.signal,
        selection,
        decisionTimestamp,
        "SELECTED",
        {
          selectionAttempt: pending.attempts,
          retryWaitMs: Math.max(0, decisionTimestamp - pending.armedAt),
          retryOutcome: "SELECTED_AFTER_RETRY",
        },
      );
      await this.#handleSelectedCandidate(revalidation.signal, candidate, quote, decisionTimestamp);
      return true;
    }

    const retryable = retryableOptionEvaluations(revalidation.signal, selection, this.#config);
    if (retryable.length > 0) {
      this.#synchronizeHistoryPriorities();
      return true;
    }

    this.#pendingOptionSelection = undefined;
    await this.#recordOptionSelection(
      pending.signal,
      revalidation.signal,
      selection,
      decisionTimestamp,
      "NO_ELIGIBLE_OPTION",
      {
        selectionAttempt: pending.attempts,
        retryWaitMs: Math.max(0, decisionTimestamp - pending.armedAt),
        retryOutcome: "STRUCTURAL_REJECTION",
      },
    );
    this.#synchronizeHistoryPriorities();
    return false;
  }

  #selectOptions(signal: TradeSignal, decisionTimestamp: number): SelectionResult {
    const subscribedContracts = this.#contracts.filter((contract) =>
      this.#subscribedSymbols.has(contract.symbol));
    return this.#selector.select(signal, subscribedContracts, this.#book, decisionTimestamp);
  }

  async #recordOptionSelection(
    identitySignal: TradeSignal,
    evaluatedSignal: TradeSignal,
    selection: SelectionResult,
    decisionTimestamp: number,
    selectionStatus: "SELECTED" | "RETRYING" | "NO_ELIGIBLE_OPTION",
    retry: {
      selectionAttempt: number;
      retryWaitMs: number;
      retryDeadline?: number;
      retryOutcome?: string;
      retryableCandidates?: string[];
      selectionReasons?: string[];
    },
  ): Promise<void> {
    const candidate = selection.selected;
    const quote = candidate ? this.#book.get(candidate.symbol)?.quote : undefined;
    const relevant = relevantOptionEvaluations(evaluatedSignal, selection, this.#config);
    const closest = relevant[0];
    const selectionReasons = retry.selectionReasons ?? closest?.rejectionReasons ?? [];
    const signalEvent = {
      signalId: identitySignal.id,
      timestamp: identitySignal.timestamp,
      decisionTimestamp,
      direction: identitySignal.direction,
      kind: identitySignal.kind,
      regime: evaluatedSignal.regime,
      projectedMoveBps: evaluatedSignal.projectedMoveBps,
      selectionStatus,
      selectionAttempt: retry.selectionAttempt,
      retryWaitMs: retry.retryWaitMs,
      ...(retry.retryDeadline !== undefined ? { retryDeadline: retry.retryDeadline } : {}),
      ...(retry.retryOutcome ? { retryOutcome: retry.retryOutcome } : {}),
      ...(retry.retryableCandidates ? { retryableCandidates: retry.retryableCandidates } : {}),
      selectionReasons,
      morningEntryGuard: morningEntryGuardAudit(this.#config, identitySignal.timestamp),
      lateEntryGuard: lateEntryGuardAudit(this.#config, identitySignal.timestamp),
      candidate: candidate?.symbol ?? null,
      candidateMetrics: candidate ? optionCandidateMetrics(candidate) : null,
      candidateQuote: quote ? {
        timestamp: quote.timestamp,
        bidPrice: quote.bidPrice,
        askPrice: quote.askPrice,
      } : null,
      closestCandidate: closest ? {
        symbol: closest.symbol,
        ...optionCandidateMetrics(closest),
        rejectionReasons: closest.rejectionReasons,
      } : null,
      evaluatedContracts: selection.evaluations.length,
      relevantContracts: relevant.length,
      rejectionCounts: selection.rejectionCounts,
      topCandidates: relevant.slice(0, 8).map((evaluation) => ({
        symbol: evaluation.symbol,
        eligible: evaluation.eligible,
        ...optionCandidateMetrics(evaluation),
        rejectionReasons: evaluation.rejectionReasons,
      })),
    };
    await this.#auditRuntime(identitySignal.timestamp, "live_signal_selection", signalEvent);
    this.#emit("live_signal_selection", signalEvent);
  }

  async #handleSelectedCandidate(
    signal: TradeSignal,
    candidate: OptionCandidateEvaluation,
    quote: OptionQuote,
    selectedAt: number,
  ): Promise<void> {
    this.#history?.setPrioritySymbols?.(new Set([candidate.symbol]));
    if (requiresLateBullishGrindOptionConfirmation(this.#config, signal)) {
      this.#pendingLateBullishGrindConfirmation = {
        signal,
        candidate,
        armedAt: selectedAt,
        referenceBidPrice: quote.bidPrice,
      };
      const confirmationEvent = {
        signalId: signal.id,
        timestamp: signal.timestamp,
        armedAt: selectedAt,
        decision: "ARMED",
        symbol: candidate.symbol,
        referenceBidPrice: quote.bidPrice,
        minSec: this.#config.signals.lateEntryGuard.bullishGrindOptionConfirmation.minSec,
        maxSec: this.#config.signals.lateEntryGuard.bullishGrindOptionConfirmation.maxSec,
        minimumBidImprovement:
          this.#config.signals.lateEntryGuard.bullishGrindOptionConfirmation.minimumBidImprovement,
      };
      await this.#auditRuntime(signal.timestamp, "late_bullish_grind_confirmation", confirmationEvent);
      this.#emit("late_bullish_grind_confirmation", confirmationEvent);
      return;
    }
    await this.#submitSelectedEntry(signal, candidate, quote);
  }

  async #advanceLateBullishGrindConfirmation(feature: FeatureSnapshot): Promise<boolean> {
    const pending = this.#pendingLateBullishGrindConfirmation;
    if (!pending) return false;
    const decisionTimestamp = this.#now();
    const rawQuote = this.#book.get(pending.candidate.symbol)?.quote;
    const quoteValidation = rawQuote
      ? validateOptionQuote(rawQuote, decisionTimestamp, this.#config.dataQuality)
      : { usable: false as const, reasons: ["MISSING_QUOTE"] };
    const quote = quoteValidation.usable ? quoteValidation.value : undefined;
    const evaluation = evaluateLateBullishGrindOptionConfirmation(
      this.#config,
      { armedAt: pending.armedAt, referenceBidPrice: pending.referenceBidPrice },
      feature,
      quote,
    );
    const confirmationEvent = {
      signalId: pending.signal.id,
      timestamp: feature.timestamp,
      armedAt: pending.armedAt,
      decisionTimestamp,
      decision: evaluation.confirmed ? "CONFIRMED" : evaluation.expired ? "EXPIRED" : "PENDING",
      symbol: pending.candidate.symbol,
      referenceBidPrice: pending.referenceBidPrice,
      currentBidPrice: quote?.bidPrice ?? null,
      elapsedSec: evaluation.elapsedSec,
      bidImprovement: Number.isFinite(evaluation.bidImprovement) ? evaluation.bidImprovement : null,
      projectedMoveBps: evaluation.projectedMoveBps,
      reasons: evaluation.reasons,
      feature: entryFeatureSummary(feature),
    };
    await this.#auditRuntime(feature.timestamp, "late_bullish_grind_confirmation", confirmationEvent);
    this.#emit("late_bullish_grind_confirmation", confirmationEvent);
    if (evaluation.expired) {
      this.#pendingLateBullishGrindConfirmation = undefined;
      this.#synchronizeHistoryPriorities();
      return false;
    }
    if (!evaluation.confirmed || !quote) return true;
    const confirmedSignal: TradeSignal = {
      ...pending.signal,
      id: `${pending.signal.id}-option-confirmed-${feature.timestamp}`,
      timestamp: feature.timestamp,
      regime: this.#lastRegime?.regime ?? pending.signal.regime,
      projectedMoveBps: currentBullishProjectionBps(this.#config, feature),
      featureSnapshot: feature,
      reasons: [
        ...pending.signal.reasons,
        `late bullish grind option bid confirmed +${evaluation.bidImprovement.toFixed(3)} after ` +
          `${evaluation.elapsedSec.toFixed(1)}s`,
      ],
    };
    this.#pendingLateBullishGrindConfirmation = undefined;
    const {
      gammaAwareProjectedOptionMove: _staleProjectedOptionMove,
      ...confirmedCandidate
    } = pending.candidate;
    await this.#submitSelectedEntry(confirmedSignal, {
      ...confirmedCandidate,
      mid: (quote.bidPrice + quote.askPrice) / 2,
      spreadPct: (quote.askPrice - quote.bidPrice) / ((quote.bidPrice + quote.askPrice) / 2),
    }, quote);
    return true;
  }

  async #submitSelectedEntry(
    signal: TradeSignal,
    candidate: OptionCandidateEvaluation,
    quote: OptionQuote,
  ): Promise<void> {
    let result;
    try {
      result = await this.#orders.submitEntry({
        timestamp: this.#now(),
        signal,
        candidate,
        quote,
        ...(this.#book.get(candidate.symbol)?.snapshot
          ? { optionSnapshot: this.#book.get(candidate.symbol)!.snapshot! }
          : {}),
        killSwitch: this.#killSwitch,
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
      morningEntryGuard: morningEntryGuardAudit(this.#config, signal.timestamp),
      lateEntryGuard: lateEntryGuardAudit(this.#config, signal.timestamp),
      submitted: result.submitted,
      reasons: result.reasons,
      brokerOrderId: result.brokerOrder?.id ?? null,
      executionMode: this.#executionMode,
    };
    const submissionEventType = this.#executionMode === "live"
      ? "live_order_submission_result"
      : "paper_order_submission_result";
    await this.#auditRuntime(this.#now(), submissionEventType, submissionEvent);
    this.#emit(submissionEventType, submissionEvent);
  }

  healthState(): HealthState {
    const now = this.#now();
    const stock = this.#stockReceiver.healthState(this.#killSwitch);
    const optionTelemetry = this.#optionStream.telemetry?.();
    const tradeUpdateTelemetry = this.#tradeUpdateTelemetry?.();
    const recorderHealthy = this.#recorder.healthy();
    const brokerReady = !this.#executionEnabled || (
      this.#brokerAvailable && this.#positionsReconciled && this.#account?.optionsApproved === true &&
      (!this.#tradeUpdatesRequired || this.#tradeUpdatesConnected) &&
      tradeUpdateTelemetry?.overloaded !== true
    );
    const streamsConnected = stock.websocketConnected && this.#optionConnected;
    const marketDataBackpressure = stock.marketDataBackpressure === true || optionTelemetry?.overloaded === true;
    const streamsReady = this.#marketDataIdle || (streamsConnected && !marketDataBackpressure);
    const hasOptionExposure = this.#execution.position !== undefined || this.#execution.pending !== undefined;
    const noSameDayOptionContracts = this.#optionUniverseInitialized && this.#contracts.length === 0 &&
      !hasOptionExposure;
    const optionSubscriptionsRequired = !noSameDayOptionContracts && optionUniverseRequired(
      now, this.#marketOpen, hasOptionExposure, this.#config,
    );
    const universeReady = this.#subscribedSymbols.size > 0 || !optionSubscriptionsRequired;
    const strategyReady = !this.#executionEnabled || !this.#marketOpen || this.#strategyStateReady;
    const optionChainHealth = this.#optionChainHealth(now);
    const optionQuoteSilenceAgeMs = this.#subscribedSymbols.size > 0
      ? optionChainHealth.transportAgeMs : undefined;
    const optionQuoteProviderAgeMs = optionChainHealth.latestProviderAgeMs;
    const optionQuotePrimed = this.#marketDataIdle || this.#subscribedSymbols.size === 0 ||
      optionChainHealth.observedSymbolCount > 0;
    const optionQuoteProviderLagged = optionChainHealth.diagnosis === "PROVIDER_DELAYED";
    const optionQuoteStalled = this.#isOptionQuoteStalled(now);
    const activeSymbol = this.#execution.position?.symbol ?? this.#execution.pending?.order.symbol;
    const activeHealth = activeSymbol
      ? this.#optionHealth.diagnose(activeSymbol, now, this.#monotonicNow())
      : undefined;
    const optionDataReady = !optionSubscriptionsRequired || (
      optionQuotePrimed && optionChainHealth.entryEligible && !optionQuoteStalled &&
      (!activeHealth || activeHealth.entryEligible)
    );
    const restCircuit = this.#optionRestCircuit.snapshot(this.#monotonicNow());
    return {
      ...stock,
      ready: streamsReady && brokerReady && universeReady && strategyReady && recorderHealthy &&
        optionDataReady &&
        this.#marketClockAvailable && !this.#execution.halted && !this.#queue.halted,
      brokerRequired: this.#executionEnabled,
      optionDataFeed: "opra",
      receivedOptionQuotes: this.#optionQuoteCount,
      ...(optionQuoteSilenceAgeMs !== undefined
        ? { lastOptionQuoteAgeMs: optionQuoteSilenceAgeMs }
        : {}),
      ...(optionQuoteProviderAgeMs !== undefined
        ? { lastOptionQuoteProviderAgeMs: optionQuoteProviderAgeMs }
        : {}),
      optionQuotePrimed,
      optionQuoteProviderLagged,
      optionQuoteDiagnosis: optionChainHealth.diagnosis,
      optionTransportAgeMs: optionChainHealth.transportAgeMs,
      ...(optionChainHealth.exactSymbolReceiveAgeMs !== undefined
        ? { optionExactSymbolReceiveAgeMs: optionChainHealth.exactSymbolReceiveAgeMs } : {}),
      optionObservedContracts: optionChainHealth.observedSymbolCount,
      optionActiveContracts: optionChainHealth.activeSymbolCount,
      optionFreshContracts: optionChainHealth.freshSymbolCount,
      optionDiagnosableContracts: optionChainHealth.diagnosableSymbolCount,
      optionDelayedContracts: optionChainHealth.delayedSymbolCount,
      optionDelayedContractFraction: optionChainHealth.delayedSymbolFraction,
      optionFreshContractFraction: optionChainHealth.freshSymbolFraction,
      ...(optionChainHealth.medianArrivalLagMs !== undefined
        ? { optionMedianArrivalLagMs: optionChainHealth.medianArrivalLagMs } : {}),
      ...(optionChainHealth.medianAbsoluteDeviationMs !== undefined
        ? { optionMedianAbsoluteDeviationMs: optionChainHealth.medianAbsoluteDeviationMs } : {}),
      ...(optionChainHealth.providerAdvanceRatio !== undefined
        ? { optionProviderAdvanceRatio: optionChainHealth.providerAdvanceRatio } : {}),
      ...(optionChainHealth.providerTimeVelocity !== undefined
        ? { optionProviderTimeVelocity: optionChainHealth.providerTimeVelocity } : {}),
      optionQuoteFreshnessThresholdMs: this.#config.dataQuality.maxOptionQuoteAgeMs,
      optionQuoteStalled,
      optionQuoteStallThresholdMs: OPTION_QUOTE_STALL_TIMEOUT_MS,
      optionSubscriptionsRequired,
      sameDayOptionContractCount: this.#contracts.length,
      noSameDayOptionContracts,
      optionRestFallbackEnabled: this.#client.getLatestOptionQuotes !== undefined,
      optionRestFallbackInFlight: this.#optionRestRecoveryInFlight !== undefined,
      optionRestFallbackRequests: this.#optionRestFallbackRequests,
      optionRestFallbackFreshQuotes: this.#optionRestFallbackFreshQuotes,
      optionRestRepeatedQuotes: this.#optionRestRepeatedQuotes,
      optionRestCircuitState: restCircuit.state,
      optionRestCircuitFailures: restCircuit.consecutiveFailures,
      optionRestCircuitRetryAfterMs: restCircuit.retryAfterMs,
      ...(this.#lastOptionRestFallbackAt !== undefined
        ? { lastOptionRestFallbackAgeMs: Math.max(0, now - this.#lastOptionRestFallbackAt) }
        : {}),
      ...(this.#lastOptionRestQuoteTimestamp !== undefined
        ? { lastOptionRestQuoteProviderAgeMs: Math.max(0, now - this.#lastOptionRestQuoteTimestamp) }
        : {}),
      ...(this.#lastOptionRestFallbackError
        ? { lastOptionRestFallbackError: this.#lastOptionRestFallbackError }
        : {}),
      rejectedMarketEvents: (stock.rejectedMarketEvents ?? 0) + this.#rejectedOptionQuotes,
      reconnectAttempt: Math.max(
        stock.reconnectAttempt ?? 0,
        this.#optionReconnectAttempt,
        optionTelemetry?.reconnectAttempt ?? 0,
      ),
      marketDataPendingEvents: (stock.marketDataPendingEvents ?? 0) + (optionTelemetry?.pendingEvents ?? 0),
      marketDataMaximumPendingEvents: (stock.marketDataMaximumPendingEvents ?? 0) +
        (optionTelemetry?.maximumPendingEvents ?? 0),
      marketDataConsumerLagMs: Math.max(
        stock.marketDataConsumerLagMs ?? 0,
        optionTelemetry?.consumerLagMs ?? 0,
      ),
      marketDataMaximumConsumerLagMs: Math.min(
        stock.marketDataMaximumConsumerLagMs ?? Number.POSITIVE_INFINITY,
        optionTelemetry?.maximumConsumerLagMs ?? Number.POSITIVE_INFINITY,
      ),
      marketDataCoalescedEvents: (stock.marketDataCoalescedEvents ?? 0) +
        (optionTelemetry?.coalescedEvents ?? 0),
      marketDataBackpressure,
      tradeUpdatesConnected: !this.#tradeUpdatesRequired || this.#tradeUpdatesConnected,
      tradeUpdatePendingEvents: tradeUpdateTelemetry?.pendingEvents ?? 0,
      tradeUpdateMaximumPendingEvents: tradeUpdateTelemetry?.maximumPendingEvents ?? 0,
      tradeUpdateConsumerLagMs: tradeUpdateTelemetry?.consumerLagMs ?? 0,
      ...(tradeUpdateTelemetry?.maximumConsumerLagMs !== undefined
        ? { tradeUpdateMaximumConsumerLagMs: tradeUpdateTelemetry.maximumConsumerLagMs }
        : {}),
      tradeUpdateBackpressure: tradeUpdateTelemetry?.overloaded === true,
      tradeUpdateReconnectAttempt: tradeUpdateTelemetry?.reconnectAttempt ?? 0,
      ...(this.#lastError ? { lastStreamError: this.#lastError } : {}),
      stockWebsocketConnected: stock.websocketConnected,
      optionWebsocketConnected: this.#optionConnected,
      websocketConnected: streamsConnected,
      marketDataIdle: this.#marketDataIdle,
      executionEnabled: this.#executionEnabled,
      executionMode: this.#executionMode,
      accountOptionsApproved: this.#account?.optionsApproved === true,
      positionOpen: this.#execution.position !== undefined,
      pendingOrder: this.#execution.pending !== undefined,
      subscribedOptionContracts: this.#subscribedSymbols.size,
      ...(activeHealth && Number.isFinite(activeHealth.latestProviderAgeMs)
        ? { openPositionOptionQuoteAgeMs: activeHealth.latestProviderAgeMs } : {}),
      brokerAvailable: this.#brokerAvailable,
      marketClockState: this.#marketOpen ? "market-open" :
        this.#marketDataIdle ? "market-closed-idle" : "market-closed",
      marketClockAvailable: this.#marketClockAvailable,
      ...(this.#lastMarketClockError ? { lastMarketClockError: this.#lastMarketClockError } : {}),
      openOrderCount: this.#execution.pending ? 1 : 0,
      positionsReconciled: this.#positionsReconciled,
      recorderHealthy,
      strategyStateReady: this.#strategyStateReady,
      strategyStateStatus: this.#strategyStateStatus,
      ...(this.#strategyStateMarketDate ? { strategyStateMarketDate: this.#strategyStateMarketDate } : {}),
      strategyOpeningRangeEnd: this.#config.session.openingRangeEnd,
      restoredStockEvents: this.#restoredStockEvents,
      restoredFeatureBars: this.#restoredFeatureBars,
      ...(this.#strategyRecoveryError ? { strategyRecoveryError: this.#strategyRecoveryError } : {}),
    };
  }

  #entryRuntimeBlockReasons(timestamp: number): string[] {
    const reasons: string[] = [];
    if (!this.#executionEnabled) reasons.push("EXECUTION_DISABLED");
    if (this.#killSwitch) reasons.push("KILL_SWITCH");
    if (this.#execution.halted) reasons.push("EXECUTION_HALTED");
    if (this.#execution.safeMode) reasons.push("EXECUTION_SAFE_MODE");
    if (this.#executionEnabled && !this.#brokerAvailable) reasons.push("BROKER_UNAVAILABLE");
    if (this.#executionEnabled && !this.#positionsReconciled) reasons.push("POSITIONS_NOT_RECONCILED");
    if (this.#executionEnabled && this.#tradeUpdatesRequired && !this.#tradeUpdatesConnected) {
      reasons.push("TRADE_UPDATES_DISCONNECTED");
    }
    if (this.#executionEnabled && this.#tradeUpdateTelemetry?.()?.overloaded === true) {
      reasons.push("TRADE_UPDATE_BACKPRESSURE");
    }
    if (this.#executionEnabled && !this.#marketClockAvailable) reasons.push("MARKET_CLOCK_UNAVAILABLE");
    if (this.#executionEnabled &&
        (this.#account?.active !== true || this.#account.optionsApproved !== true)) {
      reasons.push("ACCOUNT_NOT_READY");
    }
    if (this.#executionEnabled && !this.#recorder.healthy()) reasons.push("AUDIT_RECORDER_UNHEALTHY");
    if (this.#executionEnabled && !this.#strategyStateReady) reasons.push("STRATEGY_STATE_NOT_READY");
    if (this.#executionEnabled && this.#optionUniverseInitialized && this.#contracts.length === 0 &&
        !this.#execution.position && !this.#execution.pending &&
        optionUniverseRequired(timestamp, this.#marketOpen, false, this.#config)) {
      reasons.push("NO_SAME_DAY_OPTION_CONTRACTS");
    }
    if (this.#executionEnabled && !this.#stockReceiver.healthState(this.#killSwitch).websocketConnected) {
      reasons.push("STOCK_FEED_DISCONNECTED");
    }
    if (this.#executionEnabled && (
      this.#stockReceiver.healthState(this.#killSwitch).marketDataBackpressure === true ||
      this.#optionStream.telemetry?.().overloaded === true
    )) {
      reasons.push("MARKET_DATA_BACKPRESSURE");
    }
    const optionHealth = this.#optionChainHealth(timestamp);
    if (this.#executionEnabled && this.#isOptionQuoteStalled(timestamp)) {
      reasons.push("OPTION_FEED_STALLED");
    } else if (this.#executionEnabled && !this.#optionConnected &&
        optionUniverseRequired(timestamp, this.#marketOpen, false, this.#config)) {
      reasons.push("OPTION_FEED_DISCONNECTED");
    } else if (this.#executionEnabled && this.#subscribedSymbols.size > 0 &&
        optionHealth.diagnosis === "NO_DATA") {
      reasons.push("OPTION_FEED_NOT_READY");
    } else if (this.#executionEnabled && optionHealth.diagnosis === "PROVIDER_DELAYED") {
      reasons.push("OPTION_FEED_PROVIDER_DELAYED");
    } else if (this.#executionEnabled && this.#subscribedSymbols.size > 0 &&
        !optionHealth.entryEligible && optionHealth.diagnosis === "OLD_EVENT_ARRIVED") {
      reasons.push("OPTION_FEED_OLD_EVENT_ARRIVED");
    } else if (this.#executionEnabled && this.#subscribedSymbols.size > 0 &&
        !optionHealth.entryEligible && optionHealth.diagnosis === "CONTRACT_IDLE") {
      reasons.push("OPTION_FEED_CONTRACT_IDLE");
    }
    if (this.#execution.position) reasons.push("POSITION_ALREADY_OPEN");
    if (this.#execution.pending) reasons.push("ORDER_ALREADY_PENDING");
    return reasons;
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

  async #onStockEvents(events: readonly StockStreamEvent[]): Promise<void> {
    try {
      await this.#queue.enqueue(async () => {
        if (this.#marketDataIdle || !this.#marketOpen) return;
        const scopedEvents = events.filter((event) => event.value.symbol === this.#config.symbol);
        if (scopedEvents.length !== events.length) {
          throw new Error(`${this.#config.symbol} runtime received cross-underlying stock events`);
        }
        this.#recordStockHistory(scopedEvents);
        let latestQuote: Extract<StockStreamEvent, { type: "quote" }> | undefined;
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]!;
          if (event.type === "quote") { latestQuote = event; break; }
        }
        if (latestQuote) {
          this.#lastSpot = (latestQuote.value.bidPrice + latestQuote.value.askPrice) / 2;
          this.#scheduleUniverseRefresh(this.#lastSpot, this.#now());
        }
      });
    } catch (error) {
      this.#recordError(error);
    }
  }

  async #onOptionQuote(quote: OptionQuote): Promise<void> {
    await this.#onOptionQuotes([quote]);
  }

  async #onOptionQuotes(quotes: readonly OptionQuote[]): Promise<void> {
    const receiveWallTimestamp = this.#now();
    const receiveMonotonicTimestamp = this.#monotonicNow();
    for (const quote of quotes) {
      if (this.#rawObservedQuotes.has(quote) ||
          parseOccSymbol(quote.symbol)?.underlying !== this.#config.symbol) continue;
      const observation = { quote, receiveWallTimestamp, receiveMonotonicTimestamp };
      this.#rawObservedQuotes.set(quote, observation);
      this.#optionHealth.onWebSocketQuote(observation);
    }
    try {
      await this.#queue.enqueue(async () => {
        if (this.#marketDataIdle || !this.#marketOpen) return;
        this.#recordOptionHistory(quotes);
        const decisionTimestamp = this.#now();
        const activeSymbol = this.#execution.position?.symbol ?? this.#execution.pending?.order.symbol;
        let latestActiveQuote: OptionQuote | undefined;
        for (const quote of quotes) {
          if (parseOccSymbol(quote.symbol)?.underlying !== this.#config.symbol) {
            this.#rejectedOptionQuotes += 1;
            continue;
          }
          this.#optionQuoteCount += 1;
          const validation = validateOptionQuote(
            quote,
            decisionTimestamp,
            this.#config.dataQuality,
          );
          if (!validation.usable || !this.#book.updateQuote(validation.value!)) {
            this.#rejectedOptionQuotes += 1;
            continue;
          }
          if (activeSymbol === quote.symbol) {
            latestActiveQuote = quote;
          }
        }
        if (this.#pendingOptionSelection) {
          await this.#advancePendingOptionSelection(decisionTimestamp);
        }
        if (latestActiveQuote) {
          await this.#tickExecution(decisionTimestamp, latestActiveQuote);
        }
      });
    } catch (error) {
      this.#recordError(error);
    }
  }

  #scheduleUniverseRefresh(spot: number, timestamp: number): void {
    void this.#startUniverseRefresh(spot, timestamp).catch((error: unknown) => this.#recordError(error));
  }

  #startUniverseRefresh(spot: number, timestamp: number, force = false): Promise<void> {
    if (this.#universeRefreshInFlight) return this.#universeRefreshInFlight;
    if (this.#marketDataIdle || !this.#marketOpen ||
        (!force && !this.#universe.shouldRefresh(timestamp))) return Promise.resolve();
    const refresh = this.#refreshUniverse(spot, timestamp);
    this.#universeRefreshInFlight = refresh;
    void refresh.finally(() => {
      if (this.#universeRefreshInFlight === refresh) this.#universeRefreshInFlight = undefined;
    }).catch(() => undefined);
    return refresh;
  }

  async #refreshUniverse(spot: number, timestamp: number): Promise<void> {
    if (this.#marketDataIdle || !this.#marketOpen) return;
    const contracts = await this.#client.listOptionContracts(this.#config.symbol);
    if (this.#stopping || this.#marketDataIdle || !this.#marketOpen) return;
    const nextSymbols = new Set(this.#universe.plan(contracts, spot, timestamp));
    const snapshots = nextSymbols.size > 0
      ? await this.#client.getOptionSnapshots([...nextSymbols])
      : [];
    if (this.#stopping || this.#marketDataIdle || !this.#marketOpen) return;

    const remove = [...this.#subscribedSymbols].filter((symbol) => !nextSymbols.has(symbol));
    const add = [...nextSymbols].filter((symbol) => !this.#subscribedSymbols.has(symbol));
    const subscriptionUpdates: Promise<void>[] = [];
    if (remove.length > 0) subscriptionUpdates.push(this.#optionStream.unsubscribe(remove));
    if (add.length > 0) subscriptionUpdates.push(this.#optionStream.subscribe(add));

    this.#contracts = contracts;
    this.#optionUniverseInitialized = true;
    for (const contract of contracts) {
      this.#book.upsertContract(contract);
      this.#recordHistory("option_contract", timestamp, contract.symbol, { ...contract });
    }
    this.#universe.commitRefresh(this.#now());
    if (nextSymbols.size === 0) {
      this.#optionQuoteStalled = false;
    }
    this.#subscribedSymbols = nextSymbols;
    this.#optionHealth.retainSymbols(nextSymbols);
    this.#alpacaOptionFeatures.retainSymbols(nextSymbols);
    for (const snapshot of snapshots) {
      this.#book.updateSnapshot(snapshot);
      this.#alpacaOptionFeatures.observeSnapshot(snapshot);
      this.#recordHistory("option_snapshot", snapshot.timestamp ?? timestamp, snapshot.symbol, { ...snapshot });
    }
    this.#emit("option_universe_refreshed", {
      contractCount: contracts.length,
      subscribedOptionContracts: nextSymbols.size,
      added: add.length,
      removed: remove.length,
    });
    await Promise.all(subscriptionUpdates);
  }

  #scheduleExecutionTick(): void {
    if (this.#stopping) return;
    const timestamp = this.#now();
    if (this.#marketDataIdle && timestamp - this.#lastClockCheck < CLOSED_MARKET_CLOCK_POLL_MS) return;
    void this.#queue.enqueue(async () => {
      try {
        await this.#refreshMarketSession(timestamp);
      } catch (error) {
        this.#recordError(error);
        return;
      }
      if (!this.#marketDataIdle && this.#marketOpen) {
        await this.#checkOptionQuoteLiveness(timestamp);
        this.#scheduleOptionRestRecovery(timestamp);
        if (this.#pendingOptionSelection) {
          await this.#advancePendingOptionSelection(timestamp);
        }
        await this.#tickExecution(timestamp);
      }
    })
      .catch((error: unknown) => this.#recordError(error));
  }

  #scheduleOptionRestRecovery(timestamp: number): void {
    const getLatestOptionQuotes = this.#client.getLatestOptionQuotes;
    const nowMonotonicTimestamp = this.#monotonicNow();
    const websocketHealth = this.#optionChainHealth(timestamp, nowMonotonicTimestamp);
    if (websocketHealth.diagnosis === "PROVIDER_DELAYED") {
      this.#optionRestCircuit.trip(nowMonotonicTimestamp);
      return;
    }
    if (!getLatestOptionQuotes || this.#stopping || this.#marketDataIdle || !this.#marketOpen ||
        this.#subscribedSymbols.size === 0 ||
        websocketHealth.diagnosis === "HEALTHY" ||
        websocketHealth.diagnosis === "TRANSPORT_DISCONNECTED" ||
        this.#optionRestRecoveryInFlight ||
        nowMonotonicTimestamp - this.#lastOptionRestFallbackMonotonicTimestamp < OPTION_REST_RECOVERY_INTERVAL_MS ||
        !this.#optionRestCircuit.canRequest(nowMonotonicTimestamp)) return;

    const symbols = [...this.#subscribedSymbols];
    this.#lastOptionRestFallbackAt = timestamp;
    this.#lastOptionRestFallbackMonotonicTimestamp = nowMonotonicTimestamp;
    this.#optionRestFallbackRequests += 1;
    const recovery = getLatestOptionQuotes.call(this.#client, symbols)
      .then(async (quotes) => {
        await this.#queue.enqueue(async () => {
          if (this.#stopping || this.#marketDataIdle || !this.#marketOpen) return;
          const observedAt = this.#now();
          const observedAtMonotonic = this.#monotonicNow();
          let freshestProviderTimestamp: number | undefined;
          let freshQuotes = 0;
          let staleQuotes = 0;
          let repeatedQuotes = 0;
          for (const quote of quotes) {
            if (!this.#subscribedSymbols.has(quote.symbol) ||
                parseOccSymbol(quote.symbol)?.underlying !== this.#config.symbol) continue;
            freshestProviderTimestamp = Math.max(freshestProviderTimestamp ?? -Infinity, quote.timestamp);
            const assessment = assessRestQuote(
              quote, observedAt, this.#config.dataQuality.maxOptionQuoteAgeMs,
            );
            if (assessment.fresh) freshQuotes += 1;
            else staleQuotes += 1;
            if (!assessment.fresh && this.#lastOptionRestFingerprints.get(quote.symbol) === assessment.fingerprint) {
              repeatedQuotes += 1;
            }
            this.#lastOptionRestFingerprints.set(quote.symbol, assessment.fingerprint);
          }
          if (freshestProviderTimestamp !== undefined) {
            this.#lastOptionRestQuoteTimestamp = Math.max(
              this.#lastOptionRestQuoteTimestamp ?? -Infinity,
              freshestProviderTimestamp,
            );
          }
          this.#optionRestFallbackFreshQuotes += freshQuotes;
          this.#optionRestRepeatedQuotes += repeatedQuotes;
          this.#lastOptionRestFallbackError = undefined;
          if (freshQuotes > 0) this.#optionRestCircuit.recordSuccess();
          else this.#optionRestCircuit.recordStaleOrRepeated(observedAtMonotonic);

          const reconnectScheduled = freshQuotes > 0 &&
            websocketHealth.diagnosis !== "HEALTHY" &&
            !this.#providerDelayDiagnosticReconnectAttempted;
          if (reconnectScheduled) {
            this.#providerDelayDiagnosticReconnectAttempted = true;
            this.#scheduleOptionReconnect();
          }
          const circuit = this.#optionRestCircuit.snapshot(observedAtMonotonic);
          const result = {
            purpose: "SAME_PROVIDER_DIAGNOSTIC",
            appliedToExecution: false,
            requestedContracts: symbols.length,
            returnedQuotes: quotes.length,
            freshQuotes,
            staleQuotes,
            repeatedQuotes,
            freshestProviderAgeMs: freshestProviderTimestamp === undefined
              ? null : Math.max(0, observedAt - freshestProviderTimestamp),
            freshnessThresholdMs: this.#config.dataQuality.maxOptionQuoteAgeMs,
            websocketDiagnosis: websocketHealth.diagnosis,
            circuitState: circuit.state,
            circuitFailures: circuit.consecutiveFailures,
            circuitRetryAfterMs: circuit.retryAfterMs,
            reconnectScheduled,
          };
          this.#emit("option_rest_fallback_result", result);
          await this.#auditRuntime(observedAt, "option_rest_fallback_result", result);
        });
      })
      .catch((error: unknown) => {
        this.#lastOptionRestFallbackError = error instanceof Error ? error.message : String(error);
        this.#optionRestCircuit.recordStaleOrRepeated(this.#monotonicNow());
        this.#emit("option_rest_fallback_failed", {
          purpose: "SAME_PROVIDER_DIAGNOSTIC",
          requestedContracts: symbols.length,
          error: this.#lastOptionRestFallbackError,
          circuitState: this.#optionRestCircuit.snapshot(this.#monotonicNow()).state,
        });
      })
      .finally(() => {
        if (this.#optionRestRecoveryInFlight === recovery) this.#optionRestRecoveryInFlight = undefined;
      });
    this.#optionRestRecoveryInFlight = recovery;
  }

  async #connectOptionStream(): Promise<void> {
    await this.#optionStream.connect({
      onQuote: (quote) => this.#onOptionQuote(quote),
      onQuotes: (quotes) => this.#onOptionQuotes(quotes),
      onRawEvents: (events) => {
        for (const event of events) {
          if (parseOccSymbol(event.value.symbol)?.underlying !== this.#config.symbol) continue;
          if (event.type === "quote") this.#alpacaOptionFeatures.observeQuote(event.value);
          else this.#alpacaOptionFeatures.observeTrade(event.value);
        }
      },
      onActivity: (activity) => this.#optionHealth.onAnyFrame(activity.receiveMonotonicTimestamp),
      onQuoteObservations: (observations) => {
        for (const observation of observations) {
          if (parseOccSymbol(observation.quote.symbol)?.underlying !== this.#config.symbol) continue;
          this.#rawObservedQuotes.set(observation.quote, observation);
          this.#optionHealth.onWebSocketQuote(observation);
        }
      },
      onState: (connected) => {
        this.#optionConnected = connected;
        if (connected) {
          if (this.#optionReconnectTimer) clearTimeout(this.#optionReconnectTimer);
          this.#optionReconnectTimer = undefined;
          this.#optionReconnectAttempt = 0;
          this.#optionQuoteStalled = false;
          this.#optionHealth.reset(this.#monotonicNow());
          this.#lastOptionDiagnosis = undefined;
          this.#lastError = undefined;
        } else if (!this.#optionStream.reconnectManaged && this.#started && !this.#stopping && !this.#marketDataIdle &&
            !this.#optionReconnectInProgress) {
          this.#scheduleOptionReconnect();
        }
      },
      onError: (error) => this.#recordError(error),
    });
  }

  #scheduleOptionReconnect(): void {
    if (this.#stopping || this.#marketDataIdle || this.#optionReconnectTimer ||
        this.#optionReconnectInProgress) return;
    if (this.#optionStream.reconnectManaged) {
      this.#optionReconnectAttempt += 1;
      void this.#optionStream.requestReconnect?.("runtime detected stale or stalled OPRA data")
        .catch((error: unknown) => this.#recordError(error));
      return;
    }
    this.#optionReconnectAttempt += 1;
    const delay = Math.min(30_000, 1_000 * (2 ** Math.max(0, this.#optionReconnectAttempt - 1)));
    this.#optionReconnectTimer = setTimeout(() => {
      this.#optionReconnectTimer = undefined;
      void (async () => {
        if (this.#marketDataIdle || this.#stopping) return;
        this.#optionReconnectInProgress = true;
        let failed = false;
        try {
          await this.#optionStream.close();
          if (this.#marketDataIdle || this.#stopping) return;
          await this.#connectOptionStream();
        } catch (error) {
          failed = true;
          this.#recordError(error);
        } finally {
          this.#optionReconnectInProgress = false;
        }
        if (failed) this.#scheduleOptionReconnect();
      })();
    }, delay);
  }

  #optionChainHealth(timestamp: number, monotonicTimestamp = this.#monotonicNow()): OpraChainHealth {
    return this.#optionHealth.summarize(this.#subscribedSymbols, timestamp, monotonicTimestamp);
  }

  #isOptionQuoteStalled(timestamp: number): boolean {
    if (this.#optionQuoteStalled) return true;
    return this.#marketOpen && !this.#marketDataIdle && this.#optionConnected &&
      this.#subscribedSymbols.size > 0 &&
      this.#optionChainHealth(timestamp).diagnosis === "TRANSPORT_DISCONNECTED";
  }

  async #checkOptionQuoteLiveness(timestamp: number): Promise<void> {
    if (this.#marketDataIdle || !this.#marketOpen || !this.#optionConnected ||
        this.#subscribedSymbols.size === 0) {
      if (this.#subscribedSymbols.size === 0 || this.#marketDataIdle) this.#optionQuoteStalled = false;
      return;
    }
    const health = this.#optionChainHealth(timestamp);
    if (health.diagnosis !== this.#lastOptionDiagnosis) {
      this.#lastOptionDiagnosis = health.diagnosis;
      const diagnosisEvent = { ...health, freshnessThresholdMs: this.#config.dataQuality.maxOptionQuoteAgeMs };
      this.#emit("option_feed_diagnosis", diagnosisEvent);
      await this.#auditRuntime(timestamp, "option_feed_diagnosis", diagnosisEvent);
      if (health.diagnosis === "HEALTHY") this.#optionRestCircuit.recordSuccess();
    }
    if (health.diagnosis === "PROVIDER_DELAYED") {
      this.#optionRestCircuit.trip(this.#monotonicNow());
      if (!this.#providerDelayDiagnosticReconnectAttempted) {
        this.#providerDelayDiagnosticReconnectAttempted = true;
        this.#scheduleOptionReconnect();
      }
    }
    if (health.diagnosis !== "TRANSPORT_DISCONNECTED" || this.#optionQuoteStalled) return;
    this.#optionQuoteStalled = true;
    this.#optionConnected = false;
    const stallReason = "RECEIVE_SILENCE";
    const stalledForMs = health.transportAgeMs;
    const error = new Error(
      `OPRA option quote stream stalled (${stallReason}) for ${stalledForMs} ms with ` +
      `${this.#subscribedSymbols.size} active subscriptions`,
    );
    this.#recordError(error);
    this.#scheduleOptionReconnect();
    this.#emit("option_stream_stalled", {
      stallReason,
      silenceAgeMs: health.transportAgeMs,
      providerAgeMs: health.latestProviderAgeMs ?? null,
      stallThresholdMs: OPTION_QUOTE_STALL_TIMEOUT_MS,
      subscribedOptionContracts: this.#subscribedSymbols.size,
    });
    await this.#auditRuntime(timestamp, "option_stream_stalled", {
      stallReason,
      silenceAgeMs: health.transportAgeMs,
      providerAgeMs: health.latestProviderAgeMs ?? null,
      stallThresholdMs: OPTION_QUOTE_STALL_TIMEOUT_MS,
      subscribedOptionContracts: this.#subscribedSymbols.size,
      reconnectAttempt: this.#optionReconnectAttempt,
    });
  }

  async #tickExecution(timestamp: number, optionQuote?: OptionQuote): Promise<void> {
    if (this.#marketDataIdle || !this.#marketOpen || !this.#executionEnabled || this.#execution.halted) return;
    const activeSymbol = this.#execution.position?.symbol ?? this.#execution.pending?.order.symbol;
    const optionSnapshot = activeSymbol ? this.#book.get(activeSymbol)?.snapshot : undefined;
    const alpacaOptionFeatures = activeSymbol
      ? this.#alpacaOptionFeatures.snapshot(activeSymbol, timestamp)
      : undefined;
    this.#execution = await this.#orders.tick({
      timestamp,
      ...(optionQuote ? { optionQuote } : {}),
      ...(optionSnapshot ? { optionSnapshot } : {}),
      ...(alpacaOptionFeatures ? { alpacaOptionFeatures } : {}),
      ...(this.#lastFeature ? { feature: this.#lastFeature } : {}),
      ...(this.#lastRegime ? { regime: this.#lastRegime } : {}),
      killSwitch: this.#killSwitch,
    });
    this.#synchronizePositionLifecycle();
    this.#synchronizeHistoryPriorities();
  }

  async #refreshMarketSession(timestamp: number): Promise<void> {
    const interval = this.#marketDataIdle ? CLOSED_MARKET_CLOCK_POLL_MS : OPEN_MARKET_CLOCK_POLL_MS;
    if (timestamp - this.#lastClockCheck < interval) return;
    this.#lastClockCheck = timestamp;
    let clock: Awaited<ReturnType<SpyOptionsRuntimeClient["getMarketClock"]>>;
    try {
      clock = await this.#client.getMarketClock();
    } catch (error) {
      this.#marketClockAvailable = false;
      this.#lastMarketClockError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    this.#marketClockAvailable = true;
    this.#lastMarketClockError = undefined;
    this.#marketOpen = clock.isOpen;
    if (!clock.isOpen && !this.#marketDataIdle) {
      await this.#enterMarketClosedIdle(clock.timestamp);
    } else if (clock.isOpen && this.#marketDataIdle) {
      await this.#resumeMarketData(clock.timestamp);
    }
  }

  async #enterMarketClosedIdle(timestamp: number): Promise<void> {
    if (this.#marketDataIdle) return;
    this.#marketOpen = false;
    this.#marketDataIdle = true;
    this.#optionConnected = false;
    this.#optionQuoteStalled = false;
    this.#providerDelayDiagnosticReconnectAttempted = false;
    if (this.#optionReconnectTimer) clearTimeout(this.#optionReconnectTimer);
    this.#optionReconnectTimer = undefined;
    const subscribedSymbols = [...this.#subscribedSymbols];
    this.#subscribedSymbols.clear();
    this.#history?.setPrioritySymbols?.(new Set());
    this.#marketDataTransition = this.#marketDataTransition.then(async () => {
      await Promise.allSettled([
        this.#stockReceiver.close(),
        (async () => {
          await this.#optionStream.close();
          await this.#optionStream.unsubscribe(subscribedSymbols);
        })(),
      ]);
    });
    await this.#auditRuntime(timestamp, "market_session_idle", {
      reason: "MARKET_CLOSED",
      marketOpen: false,
      controlPlanePollMs: CLOSED_MARKET_CLOCK_POLL_MS,
      positionOpen: this.#execution.position !== undefined,
      pendingOrder: this.#execution.pending !== undefined,
    });
    this.#emit("market_session_idle", {
      reason: "MARKET_CLOSED",
      controlPlanePollMs: CLOSED_MARKET_CLOCK_POLL_MS,
    });
  }

  async #resumeMarketData(timestamp: number): Promise<void> {
    await this.#marketDataTransition;
    if (this.#stopping || !this.#marketOpen || !this.#marketDataIdle) return;
    this.#marketDataIdle = false;
    this.#optionQuoteStalled = false;
    this.#optionUniverseInitialized = false;
    this.#contracts = [];
    this.#lastFeature = undefined;
    this.#lastRegime = undefined;
    this.#strategyStateMarketDate = marketDate(timestamp, this.#config.timeZone);
    this.#strategyStateReady = !this.#requireStrategyRecovery;
    this.#strategyStateStatus = this.#requireStrategyRecovery
      ? "RESTORING_SESSION_STATE" : "RECOVERY_NOT_REQUIRED";
    this.#strategyCoverageStartedAtOpen = false;
    this.#strategyRecoveryError = undefined;
    this.#stockReceiver.resetSessionState();
    await this.#stockReceiver.startBuffered();
    await this.#restoreStrategyState(Math.max(timestamp, this.#now()));
    const latestQuote = await this.#getLatestSipQuote();
    this.#lastSpot = (latestQuote.bidPrice + latestQuote.askPrice) / 2;
    await this.#startUniverseRefresh(this.#lastSpot, timestamp, true);
    try {
      await this.#connectOptionStream();
    } catch (error) {
      this.#recordError(error);
      if (!this.#optionStream.reconnectManaged) this.#scheduleOptionReconnect();
    }
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
    await this.#auditRuntime(timestamp, "market_session_resumed", {
      reason: "MARKET_OPEN",
      marketOpen: true,
      subscribedOptionContracts: this.#subscribedSymbols.size,
    });
    this.#emit("market_session_resumed", {
      reason: "MARKET_OPEN",
      subscribedOptionContracts: this.#subscribedSymbols.size,
    });
  }

  #synchronizeHistoryPriorities(): void {
    const symbol = this.#execution.position?.symbol ?? this.#execution.pending?.order.symbol ??
      this.#pendingLateBullishGrindConfirmation?.candidate.symbol ??
      (this.#pendingOptionSelection
        ? relevantOptionEvaluations(
            this.#pendingOptionSelection.signal,
            this.#pendingOptionSelection.lastSelection,
            this.#config,
          )[0]?.symbol
        : undefined);
    this.#history?.setPrioritySymbols?.(symbol ? new Set([symbol]) : new Set());
  }

  #synchronizePositionLifecycle(): void {
    const symbol = this.#execution.position?.symbol;
    if (symbol && symbol !== this.#retainedPositionSymbol) {
      this.#universe.retainOpenPosition(symbol, this.#now());
      this.#retainedPositionSymbol = symbol;
      this.#signals.recordEntry(this.#execution.position!.direction, this.#execution.position!.entryTimestamp);
      this.#lateEntryBaselineSignals?.recordEntry(
        this.#execution.position!.direction,
        this.#execution.position!.entryTimestamp,
      );
      for (const engine of this.#shadowSignals.values()) {
        engine.recordEntry(this.#execution.position!.direction, this.#execution.position!.entryTimestamp);
      }
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
      data: { underlying: this.#config.symbol, ...data },
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

  #recordStockHistory(events: readonly StockStreamEvent[]): void {
    if (!this.#history || events.length === 0) return;
    const receivedTimestamp = this.#now();
    const date = marketDate(receivedTimestamp, this.#config.timeZone);
    const historyEvents: HistoricalMarketEvent[] = events.map((event) => ({
      type: event.type === "quote" ? "stock_quote" : "stock_trade",
      providerTimestamp: event.value.timestamp,
      receivedTimestamp,
      marketDate: date,
      symbol: event.value.symbol,
      data: { ...event.value },
    }));
    if (this.#history.recordMarketEvents) this.#history.recordMarketEvents(historyEvents);
    else for (const event of historyEvents) this.#history.recordMarketEvent(event);
  }

  #recordOptionHistory(quotes: readonly OptionQuote[]): void {
    if (!this.#history || quotes.length === 0) return;
    const historyEvents: HistoricalMarketEvent[] = quotes.map((quote) => {
      const observation = this.#rawObservedQuotes.get(quote);
      const receivedTimestamp = observation?.receiveWallTimestamp ?? this.#now();
      return {
        type: "option_quote",
        providerTimestamp: quote.timestamp,
        receivedTimestamp,
        marketDate: marketDate(receivedTimestamp, this.#config.timeZone),
        symbol: quote.symbol,
        data: {
          ...quote,
          ...(observation
            ? {
                receiveMonotonicTimestamp: observation.receiveMonotonicTimestamp,
                ...(observation.websocketConnectionId !== undefined
                  ? { websocketConnectionId: observation.websocketConnectionId } : {}),
                ...(observation.subscriptionSymbols
                  ? { subscriptionSymbols: observation.subscriptionSymbols } : {}),
                correctedProviderAgeMs: receivedTimestamp - quote.timestamp,
                messageFingerprint: optionQuoteFingerprint(quote),
              }
            : {}),
        },
      };
    });
    if (this.#history.recordMarketEvents) this.#history.recordMarketEvents(historyEvents);
    else for (const event of historyEvents) this.#history.recordMarketEvent(event);
  }

  #emit(type: string, data: Record<string, unknown>): void {
    this.#onEvent?.(type, { underlying: this.#config.symbol, ...data });
  }

  async #getLatestSipQuote(): Promise<StockQuote> {
    const quote = this.#client.getLatestUnderlyingSipQuote
      ? await this.#client.getLatestUnderlyingSipQuote(this.#config.symbol)
      : this.#config.symbol === "SPY" && this.#client.getLatestSpySipQuote
      ? await this.#client.getLatestSpySipQuote()
      : undefined;
    if (!quote) throw new Error(`${this.#config.symbol} runtime client cannot fetch its latest SIP quote`);
    if (quote.symbol !== this.#config.symbol) {
      throw new Error(`${this.#config.symbol} runtime received latest quote for ${quote.symbol}`);
    }
    return quote;
  }
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

function optionCandidateMetrics(candidate: OptionCandidateEvaluation): Record<string, number> {
  return {
    ...(candidate.score !== undefined ? { score: candidate.score } : {}),
    ...(candidate.delta !== undefined ? { delta: candidate.delta } : {}),
    ...(candidate.gamma !== undefined ? { gamma: candidate.gamma } : {}),
    ...(candidate.impliedVolatility !== undefined
      ? { impliedVolatility: candidate.impliedVolatility }
      : {}),
    ...(candidate.mid !== undefined ? { mid: candidate.mid } : {}),
    ...(candidate.spreadPct !== undefined ? { spreadPct: candidate.spreadPct } : {}),
    ...(candidate.equivalentUnderlyingCostBps !== undefined
      ? { equivalentUnderlyingCostBps: candidate.equivalentUnderlyingCostBps }
      : {}),
    ...(candidate.requiredMoveBps !== undefined ? { requiredMoveBps: candidate.requiredMoveBps } : {}),
    ...(candidate.costMarginBps !== undefined ? { costMarginBps: candidate.costMarginBps } : {}),
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
  events: readonly AuditEvent[], timestamp: number, timeZone: string, underlying: UnderlyingSymbol = "SPY",
): RestoredRuntimeState {
  const date = marketDate(timestamp, timeZone);
  const knownClientOrderIds = new Set<string>();
  const filledEntries = new Set<string>();
  const lastEntries: RestoredSignalState["lastEntries"] = {};
  const lastProtectedExits: RestoredSignalState["lastProtectedExits"] = {};
  let lastSignalTimestamp: number | undefined;
  let realizedPnl = 0;

  for (const event of events) {
    if (!auditEventBelongsToUnderlying(event, underlying)) continue;
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
      const exitPnl = finiteNumber(event.data.realizedPnl) ?? 0;
      realizedPnl += exitPnl;
      const direction = directionValue(event.data.direction);
      if (direction && isProtectedProfitExit(event.data.reason, exitPnl)) {
        lastProtectedExits[direction] = Math.max(
          lastProtectedExits[direction] ?? -Infinity,
          event.timestamp,
        );
      }
    }
  }

  return {
    signal: {
      ...(lastSignalTimestamp !== undefined ? { lastSignalTimestamp } : {}),
      lastEntries,
      lastProtectedExits,
    },
    risk: { marketDate: date, entries: filledEntries.size, realizedPnl },
    knownClientOrderIds,
  };
}

function auditEventBelongsToUnderlying(event: AuditEvent, underlying: UnderlyingSymbol): boolean {
  const tagged = stringValue(event.data.underlying);
  if (tagged) return tagged === underlying;
  const candidates = [
    stringValue(event.data.symbol),
    stringValue(objectValue(event.data.order).symbol),
    stringValue(objectValue(event.data.position).symbol),
    stringValue(objectValue(event.data.localOrder).symbol),
  ];
  for (const symbol of candidates) {
    const parsed = symbol ? parseOccSymbol(symbol) : undefined;
    if (parsed) return parsed.underlying === underlying;
    if (isUnderlyingSymbol(symbol)) return symbol === underlying;
  }
  // Untagged historical audit events predate multi-underlying support and are SPY-only.
  return underlying === "SPY";
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
