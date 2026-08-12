import type { EngineConfig, FollowThroughScope } from "../config.js";
import type {
  OptionStream, OptionStreamActivity, OptionStreamEvent,
} from "../alpaca/optionStream.js";
import type { StockStream } from "../alpaca/stockStream.js";
import type { StockStreamEvent } from "../alpaca/stockStream.js";
import type { TradingRestClient } from "../alpaca/restClient.js";
import {
  isUnderlyingSymbol,
  type AccountState, type FeatureSnapshot, type OptionCandidateEvaluation, type OptionContract,
  type OptionQuote, type RegimeDecision, type StockQuote,
  type TradeSignal, type UnderlyingSymbol,
} from "../types.js";
import type { HealthState } from "../ops/healthServer.js";
import type { AuditEvent, AuditRecorder } from "../ops/recorder.js";
import type { HistoricalMarketEvent, MarketHistorySink, HistoricalMarketEventType } from "../history/types.js";
import { MemoryRecorder } from "../ops/recorder.js";
import { SerializedDecisionQueue } from "../execution/tradingEngine.js";
import {
  ConcurrentLiveOrderManager, type ConcurrentLiveExecutionSnapshot,
} from "../execution/concurrentLiveOrderManager.js";
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
import { sameDayOptionContractReasons } from "../options/tradingInvariants.js";
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
  marketDataClockOffsetMs?: number;
  optionDataProvider?: "massive" | "alpaca";
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
}

export function optionUniverseRequired(
  now: number, marketOpen: boolean, hasOptionExposure: boolean, config: EngineConfig,
  sameDayOptionContractsAvailable = true,
): boolean {
  return marketOpen && (
    hasOptionExposure ||
    sameDayOptionContractsAvailable &&
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
  readonly #marketDataClockOffsetMs: number;
  readonly #optionDataProvider: "massive" | "alpaca";
  readonly #executionTickMs: number;
  readonly #onEvent: ((type: string, data: Record<string, unknown>) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #requireStrategyRecovery: boolean;
  readonly #loadStockHistory: SpyOptionsTradingRuntimeOptions["loadStockHistory"];
  readonly #queue = new SerializedDecisionQueue();
  readonly #book: OptionBook;
  readonly #selector: OptionSelector;
  readonly #universe: OptionUniverseManager;
  readonly #signals: SignalEngine;
  readonly #lateEntryBaselineSignals: SignalEngine | undefined;
  readonly #shadowSignals = new Map<FollowThroughScope, SignalEngine>();
  readonly #orders: ConcurrentLiveOrderManager;
  readonly #stockReceiver: SpySipReceiver;
  readonly #restoredRuntimeState: RestoredRuntimeState;
  readonly #optionHealth: OpraQuoteHealthMonitor;
  readonly #optionRestCircuit = new StaleQuoteCircuitBreaker();
  readonly #rawObservedQuotes = new WeakMap<OptionQuote, OpraQuoteObservation>();
  readonly #rawProcessedOptionEvents = new WeakSet<object>();
  readonly #lastOptionRestFingerprints = new Map<string, string>();
  #contracts: OptionContract[] = [];
  #subscribedSymbols = new Set<string>();
  #sameDayOptionContractsAvailable: boolean | undefined;
  #optionConnected = false;
  #brokerAvailable = false;
  #positionsReconciled = false;
  #account: AccountState | undefined;
  #marketOpen = false;
  #marketDataIdle = false;
  #marketDataTransition: Promise<void> = Promise.resolve();
  #universeRefreshInFlight: Promise<void> | undefined;
  #optionSnapshotRefreshInFlight: Promise<void> | undefined;
  #lastOptionSnapshotRefresh = -Infinity;
  #lastSpot: number | undefined;
  #lastFeature: FeatureSnapshot | undefined;
  #lastRegime: RegimeDecision | undefined;
  #optionQuoteCount = 0;
  #optionTradeCount = 0;
  #optionAggregateCount = 0;
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
  #execution: ConcurrentLiveExecutionSnapshot = {
    halted: false, lifecycle: "FLAT", safeMode: false,
    positions: [], pendingOrders: [], exitIntents: [], positionCount: 0, maxPositions: 1,
  };
  #pendingOptionSelection: PendingOptionSelection | undefined;
  #pendingLateBullishGrindConfirmation: PendingLateBullishGrindConfirmation | undefined;
  readonly #retainedPositions = new Map<string, number>();
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
  #ordersInitialized = false;
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
    this.#marketDataClockOffsetMs = options.marketDataClockOffsetMs ?? 0;
    this.#optionDataProvider = options.optionDataProvider ?? "alpaca";
    this.#book = new OptionBook(options.config.options.microstructure.windowSec * 1_000);
    this.#optionHealth = new OpraQuoteHealthMonitor({
      executionMaxQuoteAgeMs: options.config.dataQuality.maxOptionQuoteAgeMs,
      transportTimeoutMs: OPTION_QUOTE_STALL_TIMEOUT_MS,
      clockOffsetMs: this.#marketDataClockOffsetMs,
    });
    this.#executionTickMs = options.executionTickMs ?? 250;
    this.#onEvent = options.onEvent;
    this.#onError = options.onError;
    this.#requireStrategyRecovery = options.requireStrategyRecovery === true;
    this.#loadStockHistory = options.loadStockHistory;
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
    this.#orders = new ConcurrentLiveOrderManager({
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
    this.#execution = this.#orders.snapshot();
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
      this.#ordersInitialized = true;
      await this.#auditRuntime(clock.timestamp, "runtime_config_snapshot", {
        config: this.#config,
        executionMode: this.#executionMode,
        executionEnabled: this.#executionEnabled,
        executionTickMs: this.#executionTickMs,
        optionDataProvider: this.#optionDataProvider,
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
      this.#positionsReconciled = true;
      this.#brokerAvailable = true;
      if (clock.isOpen) {
        const latestQuote = await this.#getLatestSipQuote();
        this.#lastSpot = (latestQuote.bidPrice + latestQuote.askPrice) / 2;
        await this.#startUniverseRefresh(this.#lastSpot, clock.timestamp, true);
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
        optionDataProvider: this.#optionDataProvider,
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
    this.#ordersInitialized = false;
    if (this.#tickTimer) clearInterval(this.#tickTimer);
    if (this.#optionReconnectTimer) clearTimeout(this.#optionReconnectTimer);
    this.#tickTimer = undefined;
    this.#optionReconnectTimer = undefined;
    await this.#marketDataTransition;
    await Promise.allSettled(this.#universeRefreshInFlight ? [this.#universeRefreshInFlight] : []);
    await Promise.allSettled(this.#optionSnapshotRefreshInFlight
      ? [this.#optionSnapshotRefreshInFlight] : []);
    await Promise.allSettled([this.#stockReceiver.close(), this.#optionStream.close()]);
    await this.#queue.drained();
    this.#optionConnected = false;
    this.#history?.setPrioritySymbols?.(new Set());
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
    const occupiedSymbols = new Set(this.#execution.positions.map((position) => position.symbol));
    const subscribedContracts = this.#contracts.filter((contract) =>
      this.#subscribedSymbols.has(contract.symbol) && !occupiedSymbols.has(contract.symbol));
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
    const closestQuote = closest ? this.#book.get(closest.symbol)?.quote : undefined;
    const closestQuoteProviderAgeMs = closestQuote
      ? decisionTimestamp - closestQuote.timestamp - this.#marketDataClockOffsetMs
      : undefined;
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
      closestCandidateQuote: closestQuote ? {
        timestamp: closestQuote.timestamp,
        bidPrice: closestQuote.bidPrice,
        askPrice: closestQuote.askPrice,
        bidSize: closestQuote.bidSize,
        askSize: closestQuote.askSize,
        correctedProviderAgeMs: closestQuoteProviderAgeMs,
        freshnessThresholdMs: this.#config.dataQuality.maxOptionQuoteAgeMs,
        freshAtDecision: closestQuoteProviderAgeMs !== undefined &&
          closestQuoteProviderAgeMs >= 0 &&
          closestQuoteProviderAgeMs <= this.#config.dataQuality.maxOptionQuoteAgeMs,
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
    const confirmedCandidate = pending.candidate.contract
      ? this.#selector.evaluate(
          pending.candidate.contract,
          this.#book.get(pending.candidate.symbol),
          confirmedSignal,
          decisionTimestamp,
          this.#book,
        )
      : undefined;
    if (!confirmedCandidate?.eligible) {
      await this.#auditRuntime(feature.timestamp, "option_microstructure_confirmation_rejected", {
        signalId: confirmedSignal.id,
        symbol: pending.candidate.symbol,
        reasons: confirmedCandidate?.rejectionReasons ?? ["MISSING_OPTION_CONTRACT"],
        optionMicrostructure: confirmedCandidate?.optionMicrostructure ?? null,
        chainConfirmation: confirmedCandidate?.chainConfirmation ?? null,
      });
      this.#synchronizeHistoryPriorities();
      return false;
    }
    await this.#submitSelectedEntry(confirmedSignal, confirmedCandidate, quote);
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
        ...(candidate.optionMicrostructure
          ? { optionMicrostructure: candidate.optionMicrostructure } : {}),
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
    };
    await this.#auditRuntime(this.#now(), "paper_order_submission_result", submissionEvent);
    this.#emit("paper_order_submission_result", submissionEvent);
  }

  healthState(): HealthState {
    const now = this.#now();
    const stock = this.#stockReceiver.healthState(this.#killSwitch);
    const recorderHealthy = this.#recorder.healthy();
    const brokerReady = !this.#executionEnabled || (this.#brokerAvailable && this.#positionsReconciled && this.#account?.optionsApproved === true);
    const streamsConnected = stock.websocketConnected && this.#optionConnected;
    const streamsReady = this.#marketDataIdle || streamsConnected;
    const hasOptionExposure = this.#execution.positions.length > 0 || this.#execution.pendingOrders.length > 0;
    const noSameDayContractIdle = !hasOptionExposure && this.#sameDayOptionContractsAvailable === false;
    const optionSubscriptionsRequired = optionUniverseRequired(
      now, this.#marketOpen, hasOptionExposure, this.#config,
      this.#sameDayOptionContractsAvailable !== false,
    );
    const universeReady = this.#subscribedSymbols.size > 0 || !optionSubscriptionsRequired;
    const strategyReady = !this.#executionEnabled || !this.#marketOpen ||
      this.#strategyStateReady || noSameDayContractIdle;
    const optionChainHealth = this.#optionChainHealth(now);
    const optionQuoteSilenceAgeMs = this.#subscribedSymbols.size > 0
      ? optionChainHealth.transportAgeMs : undefined;
    const optionQuoteProviderAgeMs = optionChainHealth.latestProviderAgeMs;
    const optionQuotePrimed = this.#marketDataIdle || this.#subscribedSymbols.size === 0 ||
      optionChainHealth.observedSymbolCount > 0;
    const optionQuoteProviderLagged = optionChainHealth.diagnosis === "PROVIDER_DELAYED";
    const optionQuoteStalled = this.#isOptionQuoteStalled(now);
    const activeHealth = this.#activeExecutionSymbols().map((symbol) =>
      this.#optionHealth.diagnose(symbol, now, this.#monotonicNow()));
    const optionDataReady = !optionSubscriptionsRequired || (
      optionQuotePrimed && optionChainHealth.entryEligible && !optionQuoteStalled &&
      activeHealth.every((health) => health.entryEligible)
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
      receivedOptionTrades: this.#optionTradeCount,
      receivedOptionAggregates: this.#optionAggregateCount,
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
      ...(this.#sameDayOptionContractsAvailable !== undefined
        ? { optionSameDayContractsAvailable: this.#sameDayOptionContractsAvailable }
        : {}),
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
      reconnectAttempt: Math.max(stock.reconnectAttempt ?? 0, this.#optionReconnectAttempt),
      ...(this.#lastError ? { lastStreamError: this.#lastError } : {}),
      stockWebsocketConnected: stock.websocketConnected,
      optionWebsocketConnected: this.#optionConnected,
      websocketConnected: streamsConnected,
      marketDataIdle: this.#marketDataIdle,
      executionEnabled: this.#executionEnabled,
      executionMode: this.#executionMode,
      accountOptionsApproved: this.#account?.optionsApproved === true,
      positionOpen: this.#execution.positions.length > 0,
      positionCount: this.#execution.positionCount,
      maxPositions: this.#execution.maxPositions,
      pendingOrder: this.#execution.pendingOrders.length > 0,
      pendingOrderCount: this.#execution.pendingOrders.length,
      subscribedOptionContracts: this.#subscribedSymbols.size,
      ...(activeHealth.some((health) => Number.isFinite(health.latestProviderAgeMs))
        ? { openPositionOptionQuoteAgeMs: Math.max(...activeHealth
            .map((health) => health.latestProviderAgeMs)
            .filter((age): age is number => Number.isFinite(age))) } : {}),
      brokerAvailable: this.#brokerAvailable,
      marketClockState: this.#marketOpen ? "market-open" :
        this.#marketDataIdle ? "market-closed-idle" : "market-closed",
      marketClockAvailable: this.#marketClockAvailable,
      ...(this.#lastMarketClockError ? { lastMarketClockError: this.#lastMarketClockError } : {}),
      openOrderCount: this.#execution.pendingOrders.length,
      positionsReconciled: this.#positionsReconciled,
      recorderHealthy,
      strategyStateReady: this.#strategyStateReady || noSameDayContractIdle,
      strategyStateStatus: noSameDayContractIdle
        ? "NO_SAME_DAY_OPTION_CONTRACTS" : this.#strategyStateStatus,
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
    if (this.#executionEnabled && !this.#marketClockAvailable) reasons.push("MARKET_CLOCK_UNAVAILABLE");
    if (this.#executionEnabled &&
        (this.#account?.active !== true || this.#account.optionsApproved !== true)) {
      reasons.push("ACCOUNT_NOT_READY");
    }
    if (this.#executionEnabled && !this.#recorder.healthy()) reasons.push("AUDIT_RECORDER_UNHEALTHY");
    if (this.#executionEnabled && !this.#strategyStateReady &&
        this.#sameDayOptionContractsAvailable !== false) reasons.push("STRATEGY_STATE_NOT_READY");
    if (this.#executionEnabled && !this.#ordersInitialized) reasons.push("ORDER_MANAGER_NOT_READY");
    if (this.#executionEnabled && !this.#stockReceiver.healthState(this.#killSwitch).websocketConnected) {
      reasons.push("STOCK_FEED_DISCONNECTED");
    }
    if (this.#executionEnabled && this.#sameDayOptionContractsAvailable === false) {
      reasons.push("NO_SAME_DAY_OPTION_CONTRACTS");
    }
    const optionHealth = this.#optionChainHealth(timestamp);
    if (this.#executionEnabled && this.#isOptionQuoteStalled(timestamp)) {
      reasons.push("OPTION_FEED_STALLED");
    } else if (this.#executionEnabled && !this.#optionConnected &&
        optionUniverseRequired(
          timestamp, this.#marketOpen, false, this.#config,
          this.#sameDayOptionContractsAvailable !== false,
        )) {
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
    if (this.#execution.positionCount >= this.#execution.maxPositions) {
      reasons.push("MAX_POSITIONS_PER_UNDERLYING");
    }
    if (this.#execution.pendingOrders.length > 0) reasons.push("ORDER_ALREADY_PENDING");
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

  #onRawOptionEvents(events: readonly OptionStreamEvent[], activity: OptionStreamActivity): void {
    if (this.#marketDataIdle || !this.#marketOpen) return;
    const scoped = events.filter((event) =>
      parseOccSymbol(event.value.symbol)?.underlying === this.#config.symbol &&
      this.#subscribedSymbols.has(event.value.symbol));
    if (scoped.length === 0) return;
    const historyEvents: HistoricalMarketEvent[] = [];
    const date = marketDate(activity.receiveWallTimestamp, this.#config.timeZone);
    for (const event of scoped) {
      this.#rawProcessedOptionEvents.add(event.value);
      if (event.type === "quote") {
        this.#optionQuoteCount += 1;
        if (!this.#book.observeQuote(event.value)) this.#rejectedOptionQuotes += 1;
      } else if (event.type === "trade") {
        this.#optionTradeCount += 1;
        if (!this.#book.updateTrade(event.value)) this.#rejectedOptionQuotes += 1;
      } else {
        this.#optionAggregateCount += 1;
        if (!this.#book.updateAggregate(event.value)) this.#rejectedOptionQuotes += 1;
      }
      if (!this.#history) continue;
      const providerTimestamp = event.type === "aggregate"
        ? event.value.endTimestamp : event.value.timestamp;
      const observation = event.type === "quote"
        ? this.#rawObservedQuotes.get(event.value) : undefined;
      historyEvents.push({
        type: event.type === "quote"
          ? "option_quote"
          : event.type === "trade"
            ? "option_trade"
            : "option_aggregate",
        providerTimestamp,
        receivedTimestamp: activity.receiveWallTimestamp,
        marketDate: date,
        symbol: event.value.symbol,
        data: {
          ...event.value,
          receiveMonotonicTimestamp: activity.receiveMonotonicTimestamp,
          ...(observation?.websocketConnectionId !== undefined
            ? { websocketConnectionId: observation.websocketConnectionId } : {}),
          ...(observation?.subscriptionSymbols
            ? { subscriptionSymbols: observation.subscriptionSymbols } : {}),
          correctedProviderAgeMs: activity.receiveWallTimestamp - providerTimestamp -
            this.#marketDataClockOffsetMs,
          ...(event.type === "quote"
            ? { messageFingerprint: optionQuoteFingerprint(event.value) } : {}),
        },
      });
    }
    if (historyEvents.length > 0) {
      if (this.#history?.recordMarketEvents) this.#history.recordMarketEvents(historyEvents);
      else for (const event of historyEvents) this.#history?.recordMarketEvent(event);
    }
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
        const fallbackQuotes = quotes.filter((quote) => !this.#rawProcessedOptionEvents.has(quote));
        this.#recordOptionHistory(fallbackQuotes);
        const decisionTimestamp = this.#now();
        const activeSymbols = new Set(this.#activeExecutionSymbols());
        const latestActiveQuotes = new Map<string, OptionQuote>();
        for (const quote of quotes) {
          if (parseOccSymbol(quote.symbol)?.underlying !== this.#config.symbol) {
            this.#rejectedOptionQuotes += 1;
            continue;
          }
          if (!this.#rawProcessedOptionEvents.has(quote)) {
            this.#optionQuoteCount += 1;
            this.#book.observeQuote(quote);
          }
          const validation = validateOptionQuote(
            quote,
            decisionTimestamp,
            this.#config.dataQuality,
          );
          if (!validation.usable || !this.#book.updateQuote(validation.value!)) {
            this.#rejectedOptionQuotes += 1;
            continue;
          }
          if (activeSymbols.has(quote.symbol)) latestActiveQuotes.set(quote.symbol, quote);
        }
        if (this.#pendingOptionSelection) {
          await this.#advancePendingOptionSelection(decisionTimestamp);
        }
        if (latestActiveQuotes.size > 0) {
          await this.#tickExecution(decisionTimestamp, [...latestActiveQuotes.values()]);
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
    this.#sameDayOptionContractsAvailable = contracts.some((contract) =>
      contract.active && contract.tradable &&
      sameDayOptionContractReasons(
        contract, timestamp, this.#config.timeZone, this.#config.symbol,
      ).length === 0);
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
    for (const contract of contracts) {
      this.#book.upsertContract(contract);
      this.#recordHistory("option_contract", timestamp, contract.symbol, { ...contract });
    }
    this.#universe.commitRefresh(this.#now());
    if (nextSymbols.size === 0) {
      this.#optionQuoteStalled = false;
    }
    this.#subscribedSymbols = nextSymbols;
    this.#book.retainMicrostructureSymbols(nextSymbols);
    this.#optionHealth.retainSymbols(nextSymbols);
    for (const snapshot of snapshots) {
      this.#book.updateSnapshot(snapshot);
      this.#recordHistory("option_snapshot", snapshot.timestamp ?? timestamp, snapshot.symbol, { ...snapshot });
    }
    this.#emit("option_universe_refreshed", {
      contractCount: contracts.length,
      sameDayOptionContractsAvailable: this.#sameDayOptionContractsAvailable,
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
        this.#scheduleOptionSnapshotRefresh(timestamp);
        if (this.#pendingOptionSelection) {
          await this.#advancePendingOptionSelection(timestamp);
        }
        await this.#tickExecution(timestamp);
      }
    })
      .catch((error: unknown) => this.#recordError(error));
  }

  #scheduleOptionSnapshotRefresh(timestamp: number): void {
    const intervalMs = this.#config.options.microstructure.snapshotRefreshSec * 1_000;
    if (this.#optionSnapshotRefreshInFlight || this.#subscribedSymbols.size === 0 ||
        timestamp - this.#lastOptionSnapshotRefresh < intervalMs ||
        this.#marketDataIdle || !this.#marketOpen) return;
    const symbols = [...this.#subscribedSymbols];
    this.#lastOptionSnapshotRefresh = timestamp;
    const refresh = this.#client.getOptionSnapshots(symbols)
      .then(async (snapshots) => {
        await this.#queue.enqueue(() => {
          if (this.#stopping || this.#marketDataIdle || !this.#marketOpen) return;
          const subscribed = this.#subscribedSymbols;
          for (const snapshot of snapshots) {
            if (!subscribed.has(snapshot.symbol)) continue;
            this.#book.updateSnapshot(snapshot);
            this.#recordHistory(
              "option_snapshot",
              snapshot.timestamp ?? this.#now(),
              snapshot.symbol,
              { ...snapshot },
            );
          }
          this.#emit("option_snapshots_refreshed", {
            requestedContracts: symbols.length,
            refreshedContracts: snapshots.length,
            intervalMs,
          });
        });
      })
      .catch((error: unknown) => this.#recordError(error))
      .finally(() => {
        if (this.#optionSnapshotRefreshInFlight === refresh) {
          this.#optionSnapshotRefreshInFlight = undefined;
        }
      });
    this.#optionSnapshotRefreshInFlight = refresh;
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
              this.#marketDataClockOffsetMs,
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
      onActivity: (activity) => this.#optionHealth.onAnyFrame(activity.receiveMonotonicTimestamp),
      onQuoteObservations: (observations) => {
        for (const observation of observations) {
          if (parseOccSymbol(observation.quote.symbol)?.underlying !== this.#config.symbol) continue;
          this.#rawObservedQuotes.set(observation.quote, observation);
          this.#optionHealth.onWebSocketQuote(observation);
        }
      },
      onRawEvents: (events, activity) => this.#onRawOptionEvents(events, activity),
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
        } else if (this.#started && !this.#stopping && !this.#marketDataIdle &&
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

  async #tickExecution(timestamp: number, optionQuotes: readonly OptionQuote[] = []): Promise<void> {
    if (!this.#ordersInitialized || this.#marketDataIdle || !this.#marketOpen ||
        !this.#executionEnabled || this.#execution.halted) return;
    const optionSnapshots = this.#activeExecutionSymbols().flatMap((symbol) => {
      const snapshot = this.#book.get(symbol)?.snapshot;
      return snapshot ? [snapshot] : [];
    });
    const optionMicrostructures = this.#activeExecutionSymbols().flatMap((symbol) => {
      const snapshot = this.#book.microstructure(symbol, timestamp);
      return snapshot ? [snapshot] : [];
    });
    this.#execution = await this.#orders.tick({
      timestamp,
      ...(optionQuotes.length > 0 ? { optionQuotes } : {}),
      ...(optionSnapshots.length > 0 ? { optionSnapshots } : {}),
      ...(optionMicrostructures.length > 0 ? { optionMicrostructures } : {}),
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
    this.#sameDayOptionContractsAvailable = undefined;
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
      positionOpen: this.#execution.positions.length > 0,
      positionCount: this.#execution.positionCount,
      pendingOrder: this.#execution.pendingOrders.length > 0,
      pendingOrderCount: this.#execution.pendingOrders.length,
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
    this.#sameDayOptionContractsAvailable = undefined;
    this.#optionQuoteStalled = false;
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
    const symbols = new Set(this.#activeExecutionSymbols());
    if (this.#pendingLateBullishGrindConfirmation) {
      symbols.add(this.#pendingLateBullishGrindConfirmation.candidate.symbol);
    }
    if (this.#pendingOptionSelection) {
      const candidate = relevantOptionEvaluations(
        this.#pendingOptionSelection.signal,
        this.#pendingOptionSelection.lastSelection,
        this.#config,
      )[0];
      if (candidate) symbols.add(candidate.symbol);
    }
    this.#history?.setPrioritySymbols?.(symbols);
  }

  #synchronizePositionLifecycle(): void {
    const currentSymbols = new Set(this.#execution.positions.map((position) => position.symbol));
    for (const position of this.#execution.positions) {
      if (this.#retainedPositions.get(position.symbol) === position.entryTimestamp) continue;
      this.#universe.retainOpenPosition(position.symbol, this.#now());
      this.#retainedPositions.set(position.symbol, position.entryTimestamp);
      this.#signals.recordEntry(position.direction, position.entryTimestamp);
      this.#lateEntryBaselineSignals?.recordEntry(
        position.direction,
        position.entryTimestamp,
      );
      for (const engine of this.#shadowSignals.values()) {
        engine.recordEntry(position.direction, position.entryTimestamp);
      }
    }
    for (const symbol of this.#retainedPositions.keys()) {
      if (currentSymbols.has(symbol)) continue;
      this.#universe.releaseClosedPosition(symbol);
      this.#retainedPositions.delete(symbol);
    }
  }

  #activeExecutionSymbols(): string[] {
    return [...new Set([
      ...this.#execution.positions.map((position) => position.symbol),
      ...this.#execution.pendingOrders.map((pending) => pending.order.symbol),
    ])];
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
    ...(candidate.expectedThetaCostPerShare !== undefined
      ? { expectedThetaCostPerShare: candidate.expectedThetaCostPerShare } : {}),
    ...(candidate.expectedVegaRiskPerShare !== undefined
      ? { expectedVegaRiskPerShare: candidate.expectedVegaRiskPerShare } : {}),
    ...(candidate.expectedNetOptionMove !== undefined
      ? { expectedNetOptionMove: candidate.expectedNetOptionMove } : {}),
    ...(candidate.optionMicrostructure
      ? {
          optionMicrostructureScore: candidate.optionMicrostructure.confirmationScore,
          optionQuoteOfi: candidate.optionMicrostructure.quoteOfi,
          optionTradeImbalance: candidate.optionMicrostructure.tradeImbalance,
          optionTradeEvents: candidate.optionMicrostructure.tradeEvents,
          optionQualifiedTradeEvents: candidate.optionMicrostructure.qualifiedTradeEvents,
          optionDirectionalTradeEvents: candidate.optionMicrostructure.directionalTradeEvents,
          optionExcludedTradeEvents: candidate.optionMicrostructure.excludedTradeEvents,
          optionExcludedTradeVolume: candidate.optionMicrostructure.excludedTradeVolume,
          optionPremiumMomentumBps: candidate.optionMicrostructure.premiumMomentumBps,
          optionSpreadExpansionRatio: candidate.optionMicrostructure.spreadExpansionRatio,
        }
      : {}),
    ...(candidate.chainConfirmation
      ? {
          chainConfirmationScore: candidate.chainConfirmation.averageScore,
          chainConfirmationFraction: candidate.chainConfirmation.confirmationFraction,
          chainObservedContracts: candidate.chainConfirmation.observedContracts,
        }
      : {}),
    ...(candidate.ivSkewVsNearby !== undefined
      ? { ivSkewVsNearby: candidate.ivSkewVsNearby } : {}),
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
