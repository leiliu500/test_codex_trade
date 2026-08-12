import type { EngineConfig } from "../config.js";
import { defaultConfig } from "../config.js";
import type {
  AccountState, CalibrationProfile, FeatureSnapshot, OptionCandidateEvaluation, OptionQuote, PositionState,
  RegimeDecision, ReplayEvent, RiskDecision, SecondBar, TradeSignal, UnderlyingSymbol,
} from "../types.js";
import { SecondAggregator } from "../features/secondAggregator.js";
import { FeatureEngine } from "../features/featureEngine.js";
import { classifyRegime } from "../strategy/regimeClassifier.js";
import { SignalEngine } from "../strategy/signalEngine.js";
import {
  currentBullishProjectionBps, evaluateLateBullishGrindOptionConfirmation,
  requiresLateBullishGrindOptionConfirmation,
} from "../strategy/lateBullishGrindConfirmation.js";
import { OptionBook } from "../options/optionBook.js";
import {
  OptionSelector, relevantOptionEvaluations, retryableOptionEvaluations, type SelectionResult,
} from "../options/optionSelector.js";
import { RiskManager } from "../risk/riskManager.js";
import { ExitManager } from "../risk/exitManager.js";
import {
  entryAggressionFromMicrostructure,
  entryReplaceTtlFromMicrostructure,
  OrderExecutor,
  type OrderState,
} from "../execution/orderExecutor.js";
import { SerializedDecisionQueue } from "../execution/tradingEngine.js";
import { MemoryRecorder, type AuditRecorder } from "../ops/recorder.js";
import { computeStrategyMetrics, type CompletedTrade, type StrategyMetrics } from "./metrics.js";
import { businessDaysBetween, marketDate } from "../utils/time.js";
import { parseOccSymbol } from "../options/occSymbol.js";

export type FillModel = "conservative" | "midpoint-touch" | "queue";

interface PendingEntry {
  purpose: "ENTRY";
  state: OrderState;
  signal: TradeSignal;
  candidate: OptionCandidateEvaluation;
  risk: RiskDecision;
}
interface PendingExit {
  purpose: "EXIT";
  state: OrderState;
  reason: string;
}
type PendingOrder = PendingEntry | PendingExit;

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

export interface ReplayFunnel {
  validFeatures: number;
  signals: number;
  candidateAvailable: number;
  costGatePassed: number;
  riskAllowed: number;
  ordersSubmitted: number;
  fills: number;
  completedTrades: number;
}

export interface ReplayResult {
  metadata: {
    underlying: UnderlyingSymbol;
    configVersion: string;
    fillModel: FillModel;
    calibrationVersion: string | null;
    feesPerContractRoundTrip: number;
  };
  funnel: ReplayFunnel;
  trades: CompletedTrade[];
  metrics: StrategyMetrics;
  rejectionCounts: Record<string, number>;
  auditEvents: ReturnType<MemoryRecorder["events"]["slice"]>;
  openPosition?: PositionState;
  pendingOrder?: OrderState;
}

export interface ReplayOptions {
  config?: EngineConfig;
  calibration?: CalibrationProfile;
  fillModel?: FillModel;
  account?: Partial<AccountState>;
  recorder?: AuditRecorder;
  feesPerContractRoundTrip?: number;
}

export class ReplayEngine {
  readonly #config: EngineConfig;
  readonly #calibration: CalibrationProfile | undefined;
  readonly #fillModel: FillModel;
  readonly #aggregator: SecondAggregator;
  readonly #features: FeatureEngine;
  readonly #signals: SignalEngine;
  readonly #book: OptionBook;
  readonly #selector: OptionSelector;
  readonly #risk: RiskManager;
  readonly #exits: ExitManager;
  readonly #orders: OrderExecutor;
  readonly #queue = new SerializedDecisionQueue();
  readonly #memoryRecorder = new MemoryRecorder();
  readonly #recorder: AuditRecorder;
  readonly #account: AccountState;
  readonly #feesPerContractRoundTrip: number;
  readonly #contracts = new Map<string, ReplayEvent & { type: "option_contract" }>();
  readonly #trades: CompletedTrade[] = [];
  readonly #rejections: Record<string, number> = {};
  readonly #funnel: ReplayFunnel = {
    validFeatures: 0, signals: 0, candidateAvailable: 0, costGatePassed: 0,
    riskAllowed: 0, ordersSubmitted: 0, fills: 0, completedTrades: 0,
  };
  #lastTimestamp = -Infinity;
  #position: PositionState | undefined;
  #positionSignal: TradeSignal | undefined;
  #positionCandidate: OptionCandidateEvaluation | undefined;
  #positionMarks: number[] = [];
  #pending: PendingOrder | undefined;
  #pendingOptionSelection: PendingOptionSelection | undefined;
  #pendingLateBullishGrindConfirmation: PendingLateBullishGrindConfirmation | undefined;
  #lastFeature: FeatureSnapshot | undefined;
  #lastRegime: RegimeDecision | undefined;

  constructor(options: ReplayOptions = {}) {
    this.#config = options.config ?? defaultConfig;
    this.#book = new OptionBook(this.#config.options.microstructure.windowSec * 1_000);
    this.#calibration = options.calibration;
    this.#fillModel = options.fillModel ?? "conservative";
    this.#aggregator = new SecondAggregator(this.#config.dataQuality);
    this.#features = new FeatureEngine(this.#config, options.calibration);
    this.#signals = new SignalEngine(this.#config);
    this.#selector = new OptionSelector(this.#config);
    this.#risk = new RiskManager(this.#config);
    this.#exits = new ExitManager(this.#config);
    this.#orders = new OrderExecutor(this.#config);
    this.#recorder = options.recorder ?? this.#memoryRecorder;
    this.#feesPerContractRoundTrip = options.feesPerContractRoundTrip ?? 0;
    this.#account = {
      equity: options.account?.equity ?? 100_000,
      optionBuyingPower: options.account?.optionBuyingPower ?? 100_000,
      active: options.account?.active ?? true,
      optionsApproved: options.account?.optionsApproved ?? true,
      killSwitch: options.account?.killSwitch ?? false,
    };
  }

  async ingest(event: ReplayEvent): Promise<void> {
    if (!Number.isFinite(event.timestamp)) throw new Error("Replay event has invalid timestamp");
    if (event.timestamp < this.#lastTimestamp) throw new Error(`Replay timestamp decreased: ${event.timestamp} < ${this.#lastTimestamp}`);
    this.#lastTimestamp = event.timestamp;
    await this.#queue.enqueue(async () => {
      // Completed bars are handled before the next arrival, preserving arrival-order causality.
      await this.#handleBars(this.#aggregator.flushThrough(event.timestamp));
      switch (event.type) {
        case "stock_quote": {
          this.#assertUnderlying(event.data.symbol);
          const result = this.#aggregator.ingestQuote(event.data);
          if (result.rejected) this.#audit(event.timestamp, "stock_quote_rejected", { reasons: result.rejected.reasons });
          await this.#handleBars(result.bars);
          break;
        }
        case "stock_trade": {
          this.#assertUnderlying(event.data.symbol);
          const result = this.#aggregator.ingestTrade(event.data);
          if (result.rejected) this.#audit(event.timestamp, "stock_trade_rejected", { reasons: result.rejected.reasons });
          await this.#handleBars(result.bars);
          break;
        }
        case "option_contract":
          if (event.data.underlying !== this.#config.symbol) {
            throw new Error(`${this.#config.symbol} replay rejected ${event.data.underlying} option contract`);
          }
          this.#book.upsertContract(event.data);
          this.#contracts.set(event.data.symbol, event as ReplayEvent & { type: "option_contract" });
          break;
        case "option_quote":
          this.#assertOptionUnderlying(event.data.symbol);
          if (!this.#book.updateQuote(event.data)) {
            this.#audit(event.timestamp, "option_quote_rejected", { reason: "OUT_OF_ORDER", symbol: event.data.symbol });
          } else if (this.#pendingOptionSelection) {
            this.#advancePendingOptionSelection(event.timestamp);
          }
          break;
        case "option_trade":
          this.#assertOptionUnderlying(event.data.symbol);
          if (!this.#book.updateTrade(event.data)) {
            this.#audit(event.timestamp, "option_trade_rejected", {
              reason: "INVALID_OR_DUPLICATE", symbol: event.data.symbol,
            });
          } else if (this.#pendingOptionSelection) {
            this.#advancePendingOptionSelection(event.timestamp);
          }
          break;
        case "option_aggregate":
          this.#assertOptionUnderlying(event.data.symbol);
          if (!this.#book.updateAggregate(event.data)) {
            this.#audit(event.timestamp, "option_aggregate_rejected", {
              reason: "INVALID_OR_OUT_OF_ORDER", symbol: event.data.symbol,
            });
          } else if (this.#pendingOptionSelection) {
            this.#advancePendingOptionSelection(event.timestamp);
          }
          break;
        case "option_snapshot":
          this.#assertOptionUnderlying(event.data.symbol);
          if (!this.#book.updateSnapshot(event.data)) this.#audit(event.timestamp, "option_snapshot_rejected", { reason: "OUT_OF_ORDER", symbol: event.data.symbol });
          break;
        case "prior_close":
          this.#assertUnderlying(event.data.symbol);
          this.#features.setPriorClose(event.data.close);
          break;
      }
    });
  }

  /** Replays a durable live feature without rebuilding it from retention-sampled raw quotes. */
  async ingestRecordedFeature(feature: FeatureSnapshot, receivedTimestamp = feature.timestamp): Promise<void> {
    if (!Number.isFinite(receivedTimestamp) || !Number.isFinite(feature.timestamp)) {
      throw new Error("Recorded feature has an invalid timestamp");
    }
    if (receivedTimestamp < this.#lastTimestamp) {
      throw new Error(`Replay timestamp decreased: ${receivedTimestamp} < ${this.#lastTimestamp}`);
    }
    this.#assertUnderlying(feature.symbol);
    this.#lastTimestamp = receivedTimestamp;
    await this.#queue.enqueue(() => this.#handleFeature(feature));
  }

  #assertUnderlying(symbol: string): void {
    if (symbol !== this.#config.symbol) {
      throw new Error(`${this.#config.symbol} replay rejected ${symbol} underlying data`);
    }
  }

  #assertOptionUnderlying(symbol: string): void {
    if (parseOccSymbol(symbol)?.underlying !== this.#config.symbol) {
      throw new Error(`${this.#config.symbol} replay rejected cross-underlying option ${symbol}`);
    }
  }

  async finish(): Promise<ReplayResult> {
    if (Number.isFinite(this.#lastTimestamp)) await this.#queue.enqueue(() => this.#handleBars(this.#aggregator.flushThrough(this.#lastTimestamp + 1000)));
    if (this.#pendingOptionSelection) {
      const expiresAt = this.#pendingOptionSelection.expiresAt;
      await this.#queue.enqueue(() => { this.#advancePendingOptionSelection(expiresAt); });
    }
    await this.#queue.drained();
    const auditEvents = this.#recorder === this.#memoryRecorder ? this.#memoryRecorder.events.slice() : [];
    return {
      metadata: {
        underlying: this.#config.symbol,
        configVersion: this.#config.version,
        fillModel: this.#fillModel,
        calibrationVersion: this.#calibration?.version ?? null,
        feesPerContractRoundTrip: this.#feesPerContractRoundTrip,
      },
      funnel: { ...this.#funnel },
      trades: this.#trades.slice(),
      metrics: computeStrategyMetrics(this.#trades, this.#account.equity),
      rejectionCounts: { ...this.#rejections },
      auditEvents,
      ...(this.#position ? { openPosition: { ...this.#position } } : {}),
      ...(this.#pending ? { pendingOrder: { ...this.#pending.state, events: [...this.#pending.state.events] } } : {}),
    };
  }

  async #handleBars(bars: readonly SecondBar[]): Promise<void> {
    for (const bar of bars) {
      const feature = this.#features.onBar(bar);
      if (!feature) continue;
      await this.#handleFeature(feature);
    }
  }

  async #handleFeature(feature: FeatureSnapshot): Promise<void> {
    const timestamp = feature.timestamp;
    if (feature.dataValid) this.#funnel.validFeatures += 1;
    const regime = classifyRegime(feature, this.#config.regimes);
    this.#lastFeature = feature;
    this.#lastRegime = regime;
    this.#audit(timestamp, "decision_snapshot", {
      feature, regime, position: this.#position ?? null, pendingOrder: this.#pending?.state ?? null,
    });

    if (this.#pending) this.#advancePending(timestamp);
    if (this.#pending) return;

    if (this.#position) {
      const entry = this.#book.get(this.#position.symbol);
      if (entry?.quote) this.#positionMarks.push((entry.quote.bidPrice + entry.quote.askPrice) / 2);
      const decision = this.#exits.evaluate({
        timestamp,
        position: this.#position,
        ...(entry?.quote ? { optionQuote: entry.quote } : {}),
        ...(entry?.snapshot ? { optionSnapshot: entry.snapshot } : {}),
        feature,
        regime,
        killSwitch: this.#account.killSwitch,
      });
      this.#position = decision.updatedPosition;
      if (decision.exit) {
        this.#audit(timestamp, "exit_decision", {
          reason: decision.reason ?? "UNKNOWN",
          mark: decision.markPrice ?? null,
        });
        if (entry?.quote) this.#submitExit(timestamp, entry.quote, decision.reason ?? "UNKNOWN");
      }
      return;
    }

    if (this.#pendingOptionSelection && this.#advancePendingOptionSelection(timestamp, feature, regime)) return;

    if (this.#pendingLateBullishGrindConfirmation) {
      const pendingConfirmation = this.#pendingLateBullishGrindConfirmation;
      const rawQuote = this.#book.get(pendingConfirmation.candidate.symbol)?.quote;
      const quote = rawQuote &&
        timestamp - rawQuote.timestamp <= this.#config.dataQuality.maxOptionQuoteAgeMs
        ? rawQuote : undefined;
      const confirmation = evaluateLateBullishGrindOptionConfirmation(
        this.#config,
        {
          armedAt: pendingConfirmation.armedAt,
          referenceBidPrice: pendingConfirmation.referenceBidPrice,
        },
        feature,
        quote,
      );
      this.#audit(timestamp, "late_bullish_grind_confirmation", {
        signalId: pendingConfirmation.signal.id,
        decision: confirmation.confirmed ? "CONFIRMED" : confirmation.expired ? "EXPIRED" : "PENDING",
        armedAt: pendingConfirmation.armedAt,
        symbol: pendingConfirmation.candidate.symbol,
        elapsedSec: confirmation.elapsedSec,
        bidImprovement: Number.isFinite(confirmation.bidImprovement) ? confirmation.bidImprovement : null,
        projectedMoveBps: confirmation.projectedMoveBps,
        reasons: confirmation.reasons,
      });
      if (confirmation.expired) {
        this.#pendingLateBullishGrindConfirmation = undefined;
      } else if (confirmation.confirmed && quote) {
        const confirmedSignal: TradeSignal = {
          ...pendingConfirmation.signal,
          id: `${pendingConfirmation.signal.id}-option-confirmed-${feature.timestamp}`,
          timestamp: feature.timestamp,
          regime: regime.regime,
          projectedMoveBps: currentBullishProjectionBps(this.#config, feature),
          featureSnapshot: feature,
          reasons: [
            ...pendingConfirmation.signal.reasons,
            `late bullish grind option bid confirmed +${confirmation.bidImprovement.toFixed(3)} after ` +
              `${confirmation.elapsedSec.toFixed(1)}s`,
          ],
        };
        this.#pendingLateBullishGrindConfirmation = undefined;
        const confirmedCandidate = pendingConfirmation.candidate.contract
          ? this.#selector.evaluate(
              pendingConfirmation.candidate.contract,
              this.#book.get(pendingConfirmation.candidate.symbol),
              confirmedSignal,
              timestamp,
              this.#book,
            )
          : undefined;
        if (!confirmedCandidate?.eligible) {
          this.#audit(timestamp, "option_microstructure_confirmation_rejected", {
            signalId: confirmedSignal.id,
            symbol: pendingConfirmation.candidate.symbol,
            reasons: confirmedCandidate?.rejectionReasons ?? ["MISSING_OPTION_CONTRACT"],
          });
          return;
        }
        this.#submitEntryCandidate(timestamp, confirmedSignal, confirmedCandidate, quote);
        return;
      } else {
        return;
      }
    }

    const signal = this.#signals.evaluate(feature, regime);
    if (!signal) return;
    this.#funnel.signals += 1;
    this.#audit(timestamp, "signal", { signal });
    this.#beginOptionSelection(timestamp, signal);
  }

  #beginOptionSelection(timestamp: number, signal: TradeSignal): void {
    const contracts = [...this.#contracts.values()].map((event) => event.data);
    const selection = this.#selector.select(signal, contracts, this.#book, timestamp);
    const candidate = selection.selected;
    const quote = candidate ? this.#book.get(candidate.symbol)?.quote : undefined;
    if (candidate && quote) {
      this.#recordOptionSelection(signal, signal, selection, timestamp, "SELECTED", {
        selectionAttempt: 1,
        retryWaitMs: 0,
      });
      this.#handleSelectedCandidate(timestamp, signal, candidate, quote);
      return;
    }

    const retryable = retryableOptionEvaluations(signal, selection, this.#config);
    if (this.#config.execution.optionSelectionRetryMs > 0 && retryable.length > 0) {
      this.#pendingOptionSelection = {
        signal,
        armedAt: timestamp,
        expiresAt: Math.min(
          signal.timestamp + this.#config.execution.entrySignalTtlMs,
          timestamp + this.#config.execution.optionSelectionRetryMs,
        ),
        attempts: 1,
        lastSelection: selection,
      };
      this.#recordOptionSelection(signal, signal, selection, timestamp, "RETRYING", {
        selectionAttempt: 1,
        retryWaitMs: 0,
        retryDeadline: this.#pendingOptionSelection.expiresAt,
        retryableCandidates: retryable.map((evaluation) => evaluation.symbol),
      });
      return;
    }

    this.#recordOptionSelection(signal, signal, selection, timestamp, "NO_ELIGIBLE_OPTION", {
      selectionAttempt: 1,
      retryWaitMs: 0,
      retryOutcome: retryable.length > 0 ? "RETRY_DISABLED" : "STRUCTURAL_REJECTION",
    });
  }

  #advancePendingOptionSelection(
    timestamp: number,
    feature = this.#lastFeature,
    regime = this.#lastRegime,
  ): boolean {
    const pending = this.#pendingOptionSelection;
    if (!pending) return false;
    if (timestamp >= pending.expiresAt) {
      this.#pendingOptionSelection = undefined;
      this.#recordOptionSelection(
        pending.signal,
        pending.signal,
        pending.lastSelection,
        timestamp,
        "NO_ELIGIBLE_OPTION",
        {
          selectionAttempt: pending.attempts,
          retryWaitMs: Math.max(0, timestamp - pending.armedAt),
          retryOutcome: "EXPIRED",
        },
      );
      return false;
    }

    if (!feature || !regime) return true;
    const revalidation = this.#signals.revalidateForEntry(pending.signal, feature, regime);
    if (!revalidation.valid || !revalidation.signal) {
      this.#pendingOptionSelection = undefined;
      this.#recordOptionSelection(
        pending.signal,
        pending.signal,
        pending.lastSelection,
        timestamp,
        "NO_ELIGIBLE_OPTION",
        {
          selectionAttempt: pending.attempts,
          retryWaitMs: Math.max(0, timestamp - pending.armedAt),
          retryOutcome: "SIGNAL_INVALIDATED",
          selectionReasons: revalidation.reasons,
        },
      );
      return false;
    }

    pending.attempts += 1;
    const contracts = [...this.#contracts.values()].map((event) => event.data);
    const selection = this.#selector.select(revalidation.signal, contracts, this.#book, timestamp);
    pending.lastSelection = selection;
    const candidate = selection.selected;
    const quote = candidate ? this.#book.get(candidate.symbol)?.quote : undefined;
    if (candidate && quote) {
      this.#pendingOptionSelection = undefined;
      this.#recordOptionSelection(
        pending.signal,
        revalidation.signal,
        selection,
        timestamp,
        "SELECTED",
        {
          selectionAttempt: pending.attempts,
          retryWaitMs: Math.max(0, timestamp - pending.armedAt),
          retryOutcome: "SELECTED_AFTER_RETRY",
        },
      );
      this.#handleSelectedCandidate(timestamp, revalidation.signal, candidate, quote);
      return true;
    }

    if (retryableOptionEvaluations(revalidation.signal, selection, this.#config).length > 0) return true;

    this.#pendingOptionSelection = undefined;
    this.#recordOptionSelection(
      pending.signal,
      revalidation.signal,
      selection,
      timestamp,
      "NO_ELIGIBLE_OPTION",
      {
        selectionAttempt: pending.attempts,
        retryWaitMs: Math.max(0, timestamp - pending.armedAt),
        retryOutcome: "STRUCTURAL_REJECTION",
      },
    );
    return false;
  }

  #recordOptionSelection(
    identitySignal: TradeSignal,
    evaluatedSignal: TradeSignal,
    selection: SelectionResult,
    timestamp: number,
    selectionStatus: "SELECTED" | "RETRYING" | "NO_ELIGIBLE_OPTION",
    retry: {
      selectionAttempt: number;
      retryWaitMs: number;
      retryDeadline?: number;
      retryOutcome?: string;
      retryableCandidates?: string[];
      selectionReasons?: string[];
    },
  ): void {
    if (selectionStatus !== "RETRYING") this.#aggregateOptionRejections(selection);
    const relevant = relevantOptionEvaluations(evaluatedSignal, selection, this.#config);
    const closest = relevant[0];
    this.#audit(timestamp, "option_selection", {
      signalId: identitySignal.id,
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
      selectionReasons: retry.selectionReasons ?? closest?.rejectionReasons ?? [],
      closestCandidate: closest ?? null,
      evaluations: selection.evaluations,
      selected: selection.selected ?? null,
    });
  }

  #aggregateOptionRejections(selection: SelectionResult): void {
    for (const [reason, count] of Object.entries(selection.rejectionCounts)) {
      this.#rejections[reason] = (this.#rejections[reason] ?? 0) + count;
    }
  }

  #handleSelectedCandidate(
    timestamp: number,
    signal: TradeSignal,
    candidate: OptionCandidateEvaluation,
    quote: OptionQuote,
  ): void {
    this.#funnel.candidateAvailable += 1;
    this.#funnel.costGatePassed += 1;
    if (requiresLateBullishGrindOptionConfirmation(this.#config, signal)) {
      this.#pendingLateBullishGrindConfirmation = {
        signal,
        candidate,
        armedAt: timestamp,
        referenceBidPrice: quote.bidPrice,
      };
      this.#audit(timestamp, "late_bullish_grind_confirmation", {
        signalId: signal.id,
        decision: "ARMED",
        symbol: candidate.symbol,
        armedAt: timestamp,
        referenceBidPrice: quote.bidPrice,
      });
      return;
    }
    this.#submitEntryCandidate(timestamp, signal, candidate, quote);
  }

  #submitEntryCandidate(
    timestamp: number,
    signal: TradeSignal,
    candidate: OptionCandidateEvaluation,
    quote: OptionQuote,
  ): void {
    const risk = this.#risk.evaluate({
      timestamp,
      optionMid: (quote.bidPrice + quote.askPrice) / 2,
      account: this.#account,
      hasOpenPosition: false,
    });
    this.#audit(timestamp, "risk_decision", { risk });
    if (!risk.allowed) return;
    this.#funnel.riskAllowed += 1;
    let state = this.#orders.propose({
      clientOrderId: `entry-${signal.id}`,
      symbol: candidate.symbol,
      side: "buy",
      quantity: risk.quantity,
      timestamp,
      quote,
      spreadFraction: entryAggressionFromMicrostructure(
        this.#config,
        candidate.optionMicrostructure,
      ),
      actionTtlMs: entryReplaceTtlFromMicrostructure(
        this.#config,
        candidate.optionMicrostructure,
      ),
      urgency: Math.max(0, candidate.optionMicrostructure?.confirmationScore ?? 0),
    });
    state = this.#orders.submit(state, timestamp);
    this.#pending = { purpose: "ENTRY", state, signal, candidate, risk };
    this.#funnel.ordersSubmitted += 1;
    this.#audit(timestamp, "order_submitted", { purpose: "ENTRY", order: state });
    this.#tryImmediateFill(timestamp, quote);
  }

  #submitExit(timestamp: number, quote: OptionQuote, reason: string): void {
    if (!this.#position) return;
    let state = this.#orders.propose({
      clientOrderId: `exit-${this.#position.symbol}-${timestamp}`,
      symbol: this.#position.symbol,
      side: "sell",
      quantity: this.#position.quantity,
      timestamp,
      quote,
      marketable: reason === "FORCED_SESSION_EXIT" || reason === "KILL_SWITCH",
    });
    state = this.#orders.submit(state, timestamp);
    this.#pending = { purpose: "EXIT", state, reason };
    this.#funnel.ordersSubmitted += 1;
    this.#audit(timestamp, "order_submitted", { purpose: "EXIT", reason, order: state });
    this.#tryImmediateFill(timestamp, quote);
  }

  #tryImmediateFill(timestamp: number, quote: OptionQuote): void {
    if (!this.#pending) return;
    if (this.#fillModel === "conservative") {
      const price = this.#pending.state.side === "buy" ? quote.askPrice : quote.bidPrice;
      this.#pending.state.limitPrice = price;
      this.#orders.recordFill(this.#pending.state, timestamp, this.#pending.state.requestedQuantity, price);
      this.#completePending(timestamp);
    } else if (this.#fillModel === "midpoint-touch") {
      this.#orders.simulateMidpointFill(this.#pending.state, quote, timestamp);
      if (this.#pending.state.status === "FILLED") this.#completePending(timestamp);
    }
  }

  #advancePending(timestamp: number): void {
    const pending = this.#pending;
    if (!pending) return;
    const quote = this.#book.get(pending.state.symbol)?.quote;
    if (pending.purpose === "ENTRY") {
      const microstructure = this.#book.microstructure(pending.state.symbol, timestamp);
      if (microstructure && (
        microstructure.confirmationScore < this.#config.execution.entryMicrostructureCancelScore ||
        microstructure.spreadExpansionRatio > this.#config.execution.entrySpreadExpansionCancelRatio
      )) {
        this.#orders.requestCancel(
          pending.state,
          timestamp,
          "option microstructure reversed while entry was pending",
        );
      }
    }
    this.#orders.onTimer(pending.state, timestamp, quote);
    if (pending.state.status === "CANCEL_PENDING") {
      this.#orders.confirmCancel(pending.state, timestamp);
      this.#audit(timestamp, "order_canceled", { order: pending.state });
      this.#pending = undefined;
      return;
    }
    if (!quote || quote.timestamp <= pending.state.submittedAt) return;
    if (this.#fillModel === "midpoint-touch") this.#orders.simulateMidpointFill(pending.state, quote, timestamp);
    else if (this.#fillModel === "queue") {
      const crossed = pending.state.side === "buy"
        ? quote.askPrice <= pending.state.limitPrice : quote.bidPrice >= pending.state.limitPrice;
      if (crossed) this.#orders.recordFill(
        pending.state, timestamp, pending.state.requestedQuantity - pending.state.filledQuantity, pending.state.limitPrice,
      );
    }
    if (pending.state.status === "FILLED") this.#completePending(timestamp);
  }

  #completePending(timestamp: number): void {
    const pending = this.#pending;
    if (!pending || pending.state.status !== "FILLED") return;
    this.#funnel.fills += 1;
    if (pending.purpose === "ENTRY") {
      this.#position = this.#risk.createFilledPosition(
        pending.state.symbol, pending.signal.direction, pending.state.filledQuantity, pending.state.averageFillPrice, timestamp,
        pending.signal.featureSnapshot.price,
      );
      if (pending.candidate.impliedVolatility !== undefined) {
        this.#position.entryImpliedVolatility = pending.candidate.impliedVolatility;
        this.#position.lastImpliedVolatility = pending.candidate.impliedVolatility;
        this.#position.lastOptionSnapshotTimestamp =
          this.#book.get(pending.state.symbol)?.snapshot?.timestamp ?? timestamp;
      }
      this.#positionSignal = pending.signal;
      this.#positionCandidate = pending.candidate;
      this.#positionMarks = [pending.state.averageFillPrice];
      this.#risk.recordEntry(timestamp);
      this.#signals.recordEntry(pending.signal.direction, timestamp);
      this.#account.optionBuyingPower -= 100 * pending.state.filledQuantity * pending.state.averageFillPrice;
      this.#audit(timestamp, "entry_filled", { order: pending.state, position: this.#position });
    } else if (this.#position) {
      const position = this.#position;
      const fees = this.#feesPerContractRoundTrip * position.quantity;
      const pnl = 100 * position.quantity * (pending.state.averageFillPrice - position.averageEntryPrice) - fees;
      const candidate = this.#positionCandidate;
      const trade: CompletedTrade = {
        sessionDate: marketDate(position.entryTimestamp, this.#config.timeZone),
        quantity: position.quantity,
        entryPrice: position.averageEntryPrice,
        exitPrice: pending.state.averageFillPrice,
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: timestamp,
        fees,
        ...(this.#positionSignal ? { direction: this.#positionSignal.direction, kind: this.#positionSignal.kind, regime: this.#positionSignal.regime } : {}),
        ...(candidate?.contract ? { dte: businessDaysBetween(marketDate(position.entryTimestamp, this.#config.timeZone), candidate.contract.expirationDate) } : {}),
        ...(candidate?.delta !== undefined ? { delta: candidate.delta } : {}),
        ...(candidate?.spreadPct !== undefined ? { optionSpreadPct: candidate.spreadPct } : {}),
        marks: [...this.#positionMarks, pending.state.averageFillPrice],
        estimatedTradingCost: (candidate?.roundTripCostPerShare ?? 0) * 100 * position.quantity + fees,
      };
      this.#trades.push(trade);
      this.#funnel.completedTrades += 1;
      this.#risk.recordRealizedPnl(timestamp, pnl);
      this.#signals.recordCompletedExit(position.direction, timestamp, pending.reason, pnl);
      this.#account.optionBuyingPower += 100 * position.quantity * pending.state.averageFillPrice;
      this.#audit(timestamp, "exit_filled", { reason: pending.reason, order: pending.state, pnl, trade });
      this.#position = undefined;
      this.#positionSignal = undefined;
      this.#positionCandidate = undefined;
      this.#positionMarks = [];
    }
    this.#pending = undefined;
  }

  #audit(timestamp: number, type: string, data: Record<string, unknown>): void {
    const event = {
      timestamp,
      marketDate: marketDate(timestamp, this.#config.timeZone),
      type,
      configVersion: this.#config.version,
      ...(this.#calibration ? { calibrationVersion: this.#calibration.version } : {}),
      data,
    };
    void this.#recorder.record(event);
  }
}

export function parseReplayLine(line: string, lineNumber = 1): ReplayEvent {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw new Error(`Invalid JSON at replay line ${lineNumber}`); }
  if (!value || typeof value !== "object") throw new Error(`Replay line ${lineNumber} is not an object`);
  const candidate = value as Partial<ReplayEvent>;
  const allowed = new Set([
    "stock_quote", "stock_trade", "option_contract", "option_quote", "option_trade",
    "option_aggregate", "option_snapshot", "prior_close",
  ]);
  if (!candidate.type || !allowed.has(candidate.type) || !Number.isFinite(candidate.timestamp) || !("data" in candidate)) {
    throw new Error(`Invalid replay schema at line ${lineNumber}`);
  }
  return candidate as ReplayEvent;
}

export async function replayEvents(events: readonly ReplayEvent[], options: ReplayOptions = {}): Promise<ReplayResult> {
  const engine = new ReplayEngine(options);
  for (const event of events) await engine.ingest(event);
  return engine.finish();
}

export async function replaySensitivityBand(
  events: readonly ReplayEvent[], options: Omit<ReplayOptions, "fillModel"> = {},
): Promise<Record<FillModel, ReplayResult>> {
  const conservative = await replayEvents(events, { ...options, fillModel: "conservative" });
  const midpoint = await replayEvents(events, { ...options, fillModel: "midpoint-touch" });
  const queue = await replayEvents(events, { ...options, fillModel: "queue" });
  return { conservative, "midpoint-touch": midpoint, queue };
}
