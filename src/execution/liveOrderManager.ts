import type { EngineConfig } from "../config.js";
import type {
  AccountState, ExitDecision, ExitReason, ExitTrigger, FeatureSnapshot, OptionCandidateEvaluation,
  OptionMicrostructureSnapshot, OptionQuote, OptionSnapshot, PositionState, RegimeDecision,
  RiskDecision, TradeSignal,
} from "../types.js";
import type { BrokerOrder, BrokerPosition, TradingRestClient } from "../alpaca/restClient.js";
import { reconcileBrokerState } from "../alpaca/restClient.js";
import { validateOptionQuote } from "../features/quoteSanitizer.js";
import { sameDayOptionContractReasons } from "../options/tradingInvariants.js";
import { activeSignalEntryGuard } from "../strategy/lateEntryGuard.js";
import { ExitManager } from "../risk/exitManager.js";
import { RiskManager } from "../risk/riskManager.js";
import type { DailyRiskState } from "../risk/riskManager.js";
import type { PortfolioRiskCoordinator } from "../risk/portfolioRiskCoordinator.js";
import type { AuditRecorder } from "../ops/recorder.js";
import { MemoryRecorder } from "../ops/recorder.js";
import {
  sameMaterialOrderManagement,
  type DashboardOrderManagement,
} from "../ops/orderCards.js";
import { marketDate } from "../utils/time.js";
import {
  entryAggressionFromMicrostructure,
  entryReplaceTtlFromMicrostructure,
  exitUrgencyFromMicrostructure,
  OrderExecutor,
  reconcileEntryExposure,
  urgencyTtl,
  type OrderState,
} from "./orderExecutor.js";

type ExecutionPurpose = "ENTRY" | "EXIT";

interface PendingBrokerExecution {
  purpose: ExecutionPurpose;
  brokerOrderId: string;
  state: OrderState;
  direction: TradeSignal["direction"];
  signalId?: string;
  underlyingEntryPrice?: number;
  exitReason?: ExitReason;
  cancelRequested?: boolean;
  lastPolledAt: number;
  signalTimestamp?: number;
  maxEntryPremium?: number;
  exitIntentId?: string;
  entryImpliedVolatility?: number;
  entrySnapshotTimestamp?: number;
  arrivalMid?: number;
  entryMicrostructureScore?: number;
}

interface ExecutionQualityProbe {
  symbol: string;
  side: "buy" | "sell";
  purpose: ExecutionPurpose;
  fillTimestamp: number;
  fillPrice: number;
  quantity: number;
  horizonSec: number;
}

export type TradeLifecycleState =
  | "FLAT"
  | "ENTRY_PENDING"
  | "OPEN_UNPROTECTED"
  | "PROTECTED_SOFT"
  | "PROTECTED_WINNER"
  | "PROTECTED_RECOVERED"
  | "EXIT_PENDING"
  | "CLOSED"
  | "SAFE_MODE";

interface LogicalExitIntent {
  id: string;
  createdAt: number;
  reason: ExitReason;
  triggers: ExitTrigger[];
  urgency: number;
  attempts: number;
}

export interface EntryExecutionRequest {
  timestamp: number;
  signal: TradeSignal;
  candidate: OptionCandidateEvaluation;
  quote: OptionQuote;
  optionSnapshot?: OptionSnapshot;
  optionMicrostructure?: OptionMicrostructureSnapshot;
  killSwitch?: boolean;
}

export interface ExecutionTick {
  timestamp: number;
  optionQuote?: OptionQuote;
  feature?: FeatureSnapshot;
  regime?: RegimeDecision;
  killSwitch?: boolean;
  brokerStateReliable?: boolean;
  recoveryProbability?: number;
  continuationLcbDollars?: number;
  trendProbability?: number;
  optionSnapshot?: OptionSnapshot;
  optionMicrostructure?: OptionMicrostructureSnapshot;
}

export interface EntryExecutionResult {
  submitted: boolean;
  reasons: string[];
  risk?: RiskDecision;
  brokerOrder?: BrokerOrder;
}

export interface LiveExecutionSnapshot {
  halted: boolean;
  haltReason?: string;
  lifecycle: TradeLifecycleState;
  safeMode: boolean;
  position?: PositionState;
  exitIntent?: {
    id: string;
    createdAt: number;
    reason: ExitReason;
    triggers: ExitTrigger[];
    urgency: number;
    attempts: number;
  };
  pending?: {
    purpose: ExecutionPurpose;
    brokerOrderId: string;
    exitReason?: ExitReason;
    exitIntentId?: string;
    order: OrderState;
  };
}

export interface LiveOrderManagerOptions {
  config: EngineConfig;
  client: TradingRestClient;
  recorder?: AuditRecorder;
  onCompletedExit?: (exit: CompletedLiveExit) => void;
  restoredPosition?: PositionState;
  knownClientOrderIds?: ReadonlySet<string>;
  restoredRiskState?: DailyRiskState;
  portfolioRisk?: PortfolioRiskCoordinator;
  portfolioReservationId?: string;
  riskManager?: RiskManager;
}

export interface CompletedLiveExit {
  timestamp: number;
  entryTimestamp: number;
  direction: TradeSignal["direction"];
  reason: ExitReason;
  realizedPnl: number;
}

const ACTIVE_BROKER_STATUSES = new Set([
  "accepted", "accepted_for_bidding", "new", "pending_new", "partially_filled", "pending_cancel", "pending_replace", "stopped",
]);
const CANCELED_BROKER_STATUSES = new Set(["canceled", "expired", "done_for_day", "replaced", "calculated"]);

/**
 * Broker-backed, serialized lifecycle coordinator for long 0DTE options on one configured underlying.
 * It never infers a fill from a timeout: cumulative broker state is authoritative.
 */
export class LiveOrderManager {
  readonly #config: EngineConfig;
  readonly #client: TradingRestClient;
  readonly #recorder: AuditRecorder;
  readonly #orders: OrderExecutor;
  readonly #risk: RiskManager;
  readonly #exits: ExitManager;
  readonly #knownClientOrderIds: Set<string>;
  readonly #onCompletedExit: ((exit: CompletedLiveExit) => void) | undefined;
  readonly #portfolioRisk: PortfolioRiskCoordinator | undefined;
  readonly #portfolioReservationId: string | undefined;
  #position: PositionState | undefined;
  #pending: PendingBrokerExecution | undefined;
  #exitIntent: LogicalExitIntent | undefined;
  #lifecycle: TradeLifecycleState = "FLAT";
  #safeMode = false;
  readonly #lastOptionQuotes = new Map<string, OptionQuote>();
  readonly #lastOptionMicrostructures = new Map<string, OptionMicrostructureSnapshot>();
  readonly #executionQualityProbes: ExecutionQualityProbe[] = [];
  #lastAuditedManagementState: DashboardOrderManagement | undefined;
  #halted = false;
  #haltReason: string | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: LiveOrderManagerOptions) {
    this.#config = options.config;
    this.#client = options.client;
    this.#recorder = options.recorder ?? new MemoryRecorder();
    this.#orders = new OrderExecutor(options.config);
    this.#risk = options.riskManager ?? new RiskManager(options.config);
    this.#exits = new ExitManager(options.config);
    this.#onCompletedExit = options.onCompletedExit;
    this.#portfolioRisk = options.portfolioRisk;
    this.#portfolioReservationId = options.portfolioReservationId;
    if (options.restoredRiskState) {
      this.#risk.restoreState(options.restoredRiskState);
    }
    this.#position = options.restoredPosition
      ? validatedUnifiedPosition(options.restoredPosition)
      : undefined;
    if (this.#position) this.#lifecycle = this.#position.tradeState;
    this.#knownClientOrderIds = new Set(options.knownClientOrderIds ?? []);
  }

  initialize(timestamp: number): Promise<LiveExecutionSnapshot> {
    return this.#serialize(async () => {
      this.#assertOperational();
      const reconciliation = await reconcileBrokerState(this.#client, this.#position, this.#knownClientOrderIds);
      await this.#audit(timestamp, "broker_reconciliation", { reconciliation });
      if (!this.#position &&
          reconciliation.brokerPositions.length === 1 &&
          reconciliation.openOrders.length === 0) {
        const brokerPosition = reconciliation.brokerPositions[0]!;
        this.#position = this.#risk.createFilledPosition(
          brokerPosition.symbol,
          brokerPosition.direction,
          brokerPosition.quantity,
          brokerPosition.averageEntryPrice,
          timestamp,
          brokerPosition.underlyingEntryPrice,
        );
        this.#safeMode = true;
        this.#lifecycle = "SAFE_MODE";
        this.#createExitIntent(timestamp, {
          exit: true,
          reason: "BROKER_OR_POSITION_RISK",
          triggers: ["BROKER_OR_POSITION_RISK"],
          updatedPosition: this.#position,
        });
        await this.#audit(timestamp, "broker_position_adopted_safe_mode", {
          brokerPosition,
          exitIntent: this.#exitIntent,
        });
        await this.#adoptPortfolioExposure(timestamp);
        return this.snapshot();
      }
      if (!reconciliation.matched || reconciliation.openOrders.length > 0) {
        const reasons = [...reconciliation.reasons];
        if (reconciliation.openOrders.length > 0) reasons.push("OPEN_ORDERS_REQUIRE_RESTORED_LOCAL_STATE");
        await this.#halt(timestamp, `BROKER_RECONCILIATION_FAILED:${[...new Set(reasons)].join(",")}`);
      }
      this.#lifecycle = this.#position ? this.#position.tradeState : "FLAT";
      if (this.#position) await this.#adoptPortfolioExposure(timestamp);
      return this.snapshot();
    });
  }

  submitEntry(request: EntryExecutionRequest): Promise<EntryExecutionResult> {
    return this.#serialize(async () => {
      this.#assertOperational();
      const reasons: string[] = [];
      if (this.#pending) reasons.push("ORDER_ALREADY_PENDING");
      if (this.#position) reasons.push("POSITION_ALREADY_OPEN");
      if (this.#exitIntent) reasons.push("EXIT_RECONCILIATION_PENDING");
      if (this.#safeMode) reasons.push("SAFE_MODE");
      if (!request.candidate.eligible) reasons.push("CANDIDATE_NOT_ELIGIBLE");
      if (!request.candidate.contract) reasons.push("MISSING_OPTION_CONTRACT");
      if (request.candidate.symbol !== request.quote.symbol) reasons.push("CANDIDATE_QUOTE_SYMBOL_MISMATCH");
      if (request.optionSnapshot && request.optionSnapshot.symbol !== request.candidate.symbol) {
        reasons.push("CANDIDATE_SNAPSHOT_SYMBOL_MISMATCH");
      }
      if (request.candidate.symbol === this.#config.symbol) reasons.push("UNDERLYING_ORDER_FORBIDDEN");

      const profileQuoteAgeLimitMs = activeSignalEntryGuard(this.#config, request.signal)
        ?.maxEntryQuoteAgeMs;
      const entryQuoteAgeLimitMs = profileQuoteAgeLimitMs ??
        this.#config.execution.maxEntryQuoteAgeMs;
      const initialQuoteAgeLimitMs = profileQuoteAgeLimitMs ??
        this.#config.dataQuality.maxOptionQuoteAgeMs;

      const clock = await this.#client.getMarketClock();
      if (!clock.isOpen) reasons.push("MARKET_CLOSED");
      if (request.candidate.contract) {
        reasons.push(...sameDayOptionContractReasons(
          request.candidate.contract, clock.timestamp, this.#config.timeZone, this.#config.symbol,
        ));
      }
      const quoteValidation = validateOptionQuote(request.quote, clock.timestamp, {
        ...this.#config.dataQuality,
        maxOptionQuoteAgeMs: initialQuoteAgeLimitMs,
      });
      if (!quoteValidation.usable) reasons.push(...quoteValidation.reasons.map((reason) => `QUOTE_${reason}`));
      if (clock.timestamp - request.signal.timestamp > this.#config.execution.entrySignalTtlMs) {
        reasons.push("SIGNAL_TTL_EXPIRED");
      }
      if (reasons.length > 0) {
        await this.#audit(clock.timestamp, "entry_blocked", { signalId: request.signal.id, reasons });
        return { submitted: false, reasons: [...new Set(reasons)] };
      }
      this.#rememberQuote(request.quote);
      const entryMicrostructure = request.optionMicrostructure ?? request.candidate.optionMicrostructure;
      this.#rememberMicrostructure(entryMicrostructure);

      const account = await this.#client.getAccount();
      const guardedAccount: AccountState = { ...account, killSwitch: account.killSwitch || request.killSwitch === true };
      const optionMid = (request.quote.bidPrice + request.quote.askPrice) / 2;
      const riskRequest = {
        timestamp: clock.timestamp,
        optionMid,
        account: guardedAccount,
        hasOpenPosition: this.#position !== undefined,
      };
      const risk = this.#risk.evaluate(riskRequest);
      await this.#audit(clock.timestamp, "risk_decision", {
        signalId: request.signal.id,
        risk,
      });
      if (!risk.allowed) return { submitted: false, reasons: risk.reasons, risk };

      if (this.#portfolioRisk) {
        const portfolio = await this.#portfolioRisk.reserveEntry({
          underlying: this.#config.symbol,
          ...(this.#portfolioReservationId
            ? { reservationId: this.#portfolioReservationId }
            : {}),
          timestamp: clock.timestamp,
          riskDollars: risk.maxLossPerContract * risk.quantity,
          premiumDollars: 100 * optionMid * risk.quantity,
          optionBuyingPowerDollars: guardedAccount.optionBuyingPower,
        });
        await this.#audit(clock.timestamp, "portfolio_risk_decision", {
          signalId: request.signal.id,
          portfolio,
        });
        if (!portfolio.allowed) {
          return { submitted: false, reasons: portfolio.reasons, risk };
        }
      }

      const submissionClock = await this.#client.getMarketClock();
      const submissionReasons: string[] = [];
      const entryQuoteAgeMs = submissionClock.timestamp - request.quote.timestamp;
      if (!submissionClock.isOpen) submissionReasons.push("MARKET_CLOSED");
      if (entryQuoteAgeMs < 0) submissionReasons.push("ENTRY_QUOTE_FUTURE");
      if (entryQuoteAgeMs > entryQuoteAgeLimitMs) {
        submissionReasons.push("ENTRY_QUOTE_TOO_OLD");
      }
      if (submissionClock.timestamp - request.signal.timestamp > this.#config.execution.entrySignalTtlMs) {
        submissionReasons.push("SIGNAL_TTL_EXPIRED");
      }
      if (submissionReasons.length > 0) {
        await this.#portfolioRisk?.releaseExposure(this.#config.symbol, this.#portfolioReservationId);
        await this.#audit(submissionClock.timestamp, "entry_blocked", {
          signalId: request.signal.id,
          stage: "PRE_SUBMISSION",
          quoteTimestamp: request.quote.timestamp,
          quoteAgeMs: entryQuoteAgeMs,
          maxEntryQuoteAgeMs: entryQuoteAgeLimitMs,
          reasons: submissionReasons,
        });
        return { submitted: false, reasons: [...new Set(submissionReasons)], risk };
      }

      const clientOrderId = this.#clientOrderId("entry", request.signal.id, submissionClock.timestamp);
      let state = this.#orders.propose({
        clientOrderId,
        symbol: request.candidate.symbol,
        side: "buy",
        quantity: risk.quantity,
        timestamp: submissionClock.timestamp,
        quote: request.quote,
        spreadFraction: entryAggressionFromMicrostructure(this.#config, entryMicrostructure),
        actionTtlMs: entryReplaceTtlFromMicrostructure(this.#config, entryMicrostructure),
        urgency: Math.max(0, entryMicrostructure?.confirmationScore ?? 0),
        priceCollar: maximumEntryPremium(request.candidate, request.quote, this.#config),
      });
      state = this.#orders.submit(state, submissionClock.timestamp);
      await this.#audit(submissionClock.timestamp, "broker_order_request", {
        purpose: "ENTRY", signalId: request.signal.id, order: state,
      });
      const brokerOrder = await this.#submitOrRecover(state, submissionClock.timestamp);
      this.#knownClientOrderIds.add(clientOrderId);
      this.#pending = {
        purpose: "ENTRY",
        brokerOrderId: brokerOrder.id,
        state,
        direction: request.signal.direction,
        signalId: request.signal.id,
        underlyingEntryPrice: request.signal.featureSnapshot.price,
        signalTimestamp: request.signal.timestamp,
        maxEntryPremium: state.priceCollar,
        ...(request.candidate.impliedVolatility !== undefined
          ? { entryImpliedVolatility: request.candidate.impliedVolatility }
          : request.optionSnapshot?.impliedVolatility !== undefined
            ? { entryImpliedVolatility: request.optionSnapshot.impliedVolatility }
            : {}),
        ...(request.optionSnapshot?.timestamp !== undefined
            ? { entrySnapshotTimestamp: request.optionSnapshot.timestamp }
            : {}),
        arrivalMid: optionMid,
        ...(entryMicrostructure
          ? { entryMicrostructureScore: entryMicrostructure.confirmationScore } : {}),
        lastPolledAt: submissionClock.timestamp,
      };
      this.#lifecycle = "ENTRY_PENDING";
      await this.#synchronizeBrokerOrder(brokerOrder, submissionClock.timestamp);
      return { submitted: true, reasons: [], risk, brokerOrder };
    });
  }

  tick(request: ExecutionTick): Promise<LiveExecutionSnapshot> {
    return this.#serialize(async () => {
      this.#assertOperational();
      this.#rememberQuote(request.optionQuote);
      this.#rememberMicrostructure(request.optionMicrostructure);
      await this.#evaluateExecutionQualityProbes(request.timestamp);

      if (this.#pending && request.timestamp - this.#pending.lastPolledAt >= this.#config.execution.orderPollMs) {
        const brokerOrder = await this.#client.getOrder(this.#pending.brokerOrderId);
        await this.#synchronizeBrokerOrder(brokerOrder, request.timestamp);
      }

      if (this.#pending?.purpose === "ENTRY" && this.#position) {
        const exit = await this.#evaluateExit(request);
        if (exit.exit) {
          this.#createExitIntent(request.timestamp, exit);
          await this.#audit(request.timestamp, "partial_entry_exit_requested", {
            reason: exit.reason,
            triggers: exit.triggers,
            position: this.#position,
            exitIntent: this.#exitIntent,
          });
          await this.#requestCancel(request.timestamp);
          if (!this.#pending && this.#position) await this.#submitExitAttempt(request.timestamp);
          return this.snapshot();
        }
      }

      if (this.#pending?.purpose === "ENTRY") {
        const cancellationReasons = this.#entryCancellationReasons(request);
        if (cancellationReasons.length > 0) {
          await this.#audit(request.timestamp, "entry_cancel_decision", {
            reasons: cancellationReasons,
            brokerOrderId: this.#pending.brokerOrderId,
            order: this.#pending.state,
          });
          await this.#requestCancel(request.timestamp);
          return this.snapshot();
        }
      }

      if (this.#pending) {
        await this.#managePendingTimer(request);
        return this.snapshot();
      }

      if (this.#exitIntent && this.#position) {
        await this.#submitExitAttempt(request.timestamp);
        return this.snapshot();
      }

      if (this.#position) {
        const exit = await this.#evaluateExit(request);
        if (exit.exit) {
          this.#createExitIntent(request.timestamp, exit);
          await this.#submitExitAttempt(request.timestamp);
        }
      }
      return this.snapshot();
    });
  }

  snapshot(): LiveExecutionSnapshot {
    return {
      halted: this.#halted,
      lifecycle: this.#lifecycle,
      safeMode: this.#safeMode,
      ...(this.#haltReason ? { haltReason: this.#haltReason } : {}),
      ...(this.#position ? { position: { ...this.#position } } : {}),
      ...(this.#exitIntent ? { exitIntent: {
        id: this.#exitIntent.id,
        createdAt: this.#exitIntent.createdAt,
        reason: this.#exitIntent.reason,
        triggers: [...this.#exitIntent.triggers],
        urgency: this.#exitIntent.urgency,
        attempts: this.#exitIntent.attempts,
      } } : {}),
      ...(this.#pending ? { pending: {
        purpose: this.#pending.purpose,
        brokerOrderId: this.#pending.brokerOrderId,
        ...(this.#pending.exitReason ? { exitReason: this.#pending.exitReason } : {}),
        ...(this.#pending.exitIntentId ? { exitIntentId: this.#pending.exitIntentId } : {}),
        order: { ...this.#pending.state, events: [...this.#pending.state.events] },
      } } : {}),
    };
  }

  async #evaluateExit(request: ExecutionTick): Promise<ReturnType<ExitManager["evaluate"]>> {
    if (!this.#position) throw new Error("Cannot evaluate exit without a position");
    const quote = this.#quoteFor(this.#position.symbol, request.optionQuote);
    const position = { ...this.#position };
    const context = {
      timestamp: request.timestamp,
      position,
      ...(quote ? { optionQuote: quote } : {}),
      ...(request.feature ? { feature: request.feature } : {}),
      ...(request.regime ? { regime: request.regime } : {}),
      killSwitch: request.killSwitch === true,
      ...(request.brokerStateReliable !== undefined
        ? { brokerStateReliable: request.brokerStateReliable }
        : {}),
      dailyRealizedPnl: this.#risk.state(request.timestamp).realizedPnl,
      ...(request.recoveryProbability !== undefined
        ? { recoveryProbability: request.recoveryProbability }
        : {}),
      ...(request.continuationLcbDollars !== undefined
        ? { continuationLcbDollars: request.continuationLcbDollars }
        : {}),
      ...(request.trendProbability !== undefined
        ? { trendProbability: request.trendProbability }
        : {}),
      ...(request.optionSnapshot ? { optionSnapshot: request.optionSnapshot } : {}),
    };
    const decision = this.#exits.evaluate(context);
    this.#position = decision.updatedPosition;
    if (!this.#exitIntent) this.#lifecycle = decision.updatedPosition.tradeState;
    const managementState: DashboardOrderManagement = {
      lifecycle: decision.exit
        ? "EXIT_PENDING"
        : decision.updatedPosition.tradeState,
      tradeState: decision.updatedPosition.tradeState,
      managementDecision: decision.exit ? "EXIT" : "HOLD",
      ...(decision.reason ? { managementReason: decision.reason } : {}),
      ...(decision.triggers?.length ? { exitTriggers: [...decision.triggers] } : {}),
      ...(decision.liquidationPrice !== undefined
        ? { liquidationPrice: decision.liquidationPrice }
        : {}),
      ...(decision.executablePnl !== undefined
        ? { executablePnl: decision.executablePnl }
        : {}),
      ...(decision.protectedFloorPnl !== undefined
        ? { protectedFloorPnl: decision.protectedFloorPnl }
        : {}),
      ...(decision.executablePnl !== undefined && decision.protectedFloorPnl !== undefined
        ? { floorBufferDollars: decision.executablePnl - decision.protectedFloorPnl }
        : {}),
      highWaterPnl: decision.updatedPosition.highWaterPnl,
      lowWaterPnl: decision.updatedPosition.lowWaterPnl,
      ...(decision.recoveryProbability !== undefined
        ? { recoveryProbability: decision.recoveryProbability }
        : {}),
      ...(decision.continuationLcbDollars !== undefined
        ? { continuationLcbDollars: decision.continuationLcbDollars }
        : {}),
      reversalCusum: decision.updatedPosition.reversalCusum,
      zeroCrossings: decision.updatedPosition.zeroCrossings,
      pnlObservationCount: decision.updatedPosition.pnlObservationCount,
      ...(decision.updatedPosition.oppositeRegimeSince !== undefined
        ? { oppositeRegimeSince: decision.updatedPosition.oppositeRegimeSince }
        : {}),
      ...(decision.updatedPosition.oppositeRegimeObservationCount !== undefined
        ? {
            oppositeRegimeObservationCount:
              decision.updatedPosition.oppositeRegimeObservationCount,
          }
        : {}),
      ...(decision.updatedPosition.optionContinuation
        ? { optionContinuation: { ...decision.updatedPosition.optionContinuation } }
        : {}),
    };
    const materialChange = !this.#lastAuditedManagementState ||
      !sameMaterialOrderManagement(this.#lastAuditedManagementState, managementState);
    if (materialChange) await this.#audit(request.timestamp, "order_management_state", {
      symbol: decision.updatedPosition.symbol,
      direction: decision.updatedPosition.direction,
      entryTimestamp: decision.updatedPosition.entryTimestamp,
      lifecycle: managementState.lifecycle,
      tradeState: managementState.tradeState,
      decision: managementState.managementDecision,
      reason: managementState.managementReason ?? null,
      triggers: managementState.exitTriggers ?? [],
      markPrice: decision.markPrice ?? null,
      liquidationPrice: managementState.liquidationPrice ?? null,
      executablePnl: managementState.executablePnl ?? null,
      protectedFloorPnl: managementState.protectedFloorPnl ?? null,
      floorBufferDollars: managementState.floorBufferDollars ?? null,
      highWaterPnl: managementState.highWaterPnl,
      lowWaterPnl: managementState.lowWaterPnl,
      recoveryProbability: managementState.recoveryProbability ?? null,
      continuationLcbDollars: managementState.continuationLcbDollars ?? null,
      reversalCusum: managementState.reversalCusum,
      zeroCrossings: managementState.zeroCrossings,
      pnlObservationCount: managementState.pnlObservationCount,
      oppositeRegimeSince: managementState.oppositeRegimeSince ?? null,
      oppositeRegimeObservationCount:
        managementState.oppositeRegimeObservationCount ?? null,
      optionContinuation: managementState.optionContinuation ?? null,
    });
    if (materialChange) {
      this.#lastAuditedManagementState = {
        ...managementState,
        ...(managementState.exitTriggers
          ? { exitTriggers: [...managementState.exitTriggers] }
          : {}),
        ...(managementState.optionContinuation
          ? { optionContinuation: { ...managementState.optionContinuation } }
          : {}),
      };
    } else if (!this.#recorder.healthy()) {
      await this.#halt(request.timestamp, "AUDIT_RECORDER_FAILURE", {
        skippedType: "order_management_state",
      });
    }
    return decision;
  }

  async #submitExitAttempt(timestamp: number): Promise<void> {
    if (!this.#position) return;
    const intent = this.#exitIntent;
    if (!intent) throw new Error("Cannot submit an exit order without a logical exit intent");
    const quote = this.#quoteFor(this.#position.symbol);
    if (!quote) {
      this.#safeMode = true;
      this.#lifecycle = "SAFE_MODE";
      await this.#audit(timestamp, "exit_quote_missing", {
        reason: intent.reason,
        intentId: intent.id,
        action: "EXIT_INTENT_PERSISTED",
      });
      return;
    }
    intent.attempts += 1;
    const marketable = true;
    const microstructure = this.#microstructureFor(this.#position.symbol);
    const dynamicUrgency = exitUrgencyFromMicrostructure(
      this.#config,
      intent.urgency,
      microstructure,
    );
    const clientOrderId = this.#clientOrderId(
      "exit",
      `${intent.id}-attempt-${intent.attempts}`,
      timestamp,
    );
    const priceCollar = Math.max(
      this.#config.execution.optionTickSize,
      quote.bidPrice * (1 - this.#config.execution.exitPriceCollarPct),
    );
    let state = this.#orders.propose({
      clientOrderId,
      symbol: this.#position.symbol,
      side: "sell",
      quantity: this.#position.quantity,
      timestamp,
      quote,
      marketable,
      urgency: dynamicUrgency,
      priceCollar,
      intentId: intent.id,
    });
    state = this.#orders.submit(state, timestamp);
    await this.#audit(timestamp, "broker_order_request", {
      purpose: "EXIT",
      reason: intent.reason,
      triggers: intent.triggers,
      exitIntentId: intent.id,
      attempt: intent.attempts,
      urgency: dynamicUrgency,
      marketable,
      tradeState: this.#position.tradeState,
      executablePnl: this.#position.executablePnl,
      protectedFloorPnl: this.#position.protectedFloorPnl,
      estimatedRecoveryProbability: this.#position.estimatedRecoveryProbability,
      optionContinuation: this.#position.optionContinuation,
      order: state,
    });
    const brokerOrder = await this.#submitOrRecover(state, timestamp);
    this.#knownClientOrderIds.add(clientOrderId);
    this.#pending = {
      purpose: "EXIT",
      brokerOrderId: brokerOrder.id,
      state,
      direction: this.#position.direction,
      exitReason: intent.reason,
      exitIntentId: intent.id,
      lastPolledAt: timestamp,
      arrivalMid: (quote.bidPrice + quote.askPrice) / 2,
    };
    this.#lifecycle = "EXIT_PENDING";
    await this.#synchronizeBrokerOrder(brokerOrder, timestamp);
  }

  async #submitOrRecover(state: OrderState, timestamp: number): Promise<BrokerOrder> {
    try {
      return await this.#client.submitOrder({
        clientOrderId: state.clientOrderId,
        symbol: state.symbol,
        side: state.side,
        quantity: state.requestedQuantity,
        limitPrice: state.limitPrice,
        timeInForce: "day",
      });
    } catch (submissionError) {
      try {
        const recovered = await this.#client.getOrderByClientOrderId(state.clientOrderId);
        await this.#audit(timestamp, "broker_submission_recovered", { order: recovered });
        return recovered;
      } catch (recoveryError) {
        return await this.#halt(timestamp, "AMBIGUOUS_ORDER_SUBMISSION", { submissionError, recoveryError });
      }
    }
  }

  async #synchronizeBrokerOrder(broker: BrokerOrder, timestamp: number): Promise<void> {
    const pending = this.#pending;
    if (!pending) return;
    pending.lastPolledAt = timestamp;
    if (broker.symbol !== pending.state.symbol) await this.#halt(timestamp, "BROKER_ORDER_SYMBOL_MISMATCH", { broker, pending });
    const totalFilled = broker.filledQuantity;
    if (!Number.isInteger(totalFilled) || totalFilled < pending.state.filledQuantity || totalFilled > pending.state.requestedQuantity) {
      await this.#halt(timestamp, "INVALID_BROKER_FILL_QUANTITY", { broker, pending });
    }
    const incrementalQuantity = totalFilled - pending.state.filledQuantity;
    if (incrementalQuantity > 0) {
      if (!(broker.averageFillPrice !== undefined && broker.averageFillPrice > 0)) {
        await this.#halt(timestamp, "MISSING_BROKER_AVERAGE_FILL_PRICE", { broker });
      }
      const oldNotional = pending.state.averageFillPrice * pending.state.filledQuantity;
      const newNotional = broker.averageFillPrice! * totalFilled;
      const incrementalPrice = (newNotional - oldNotional) / incrementalQuantity;
      this.#orders.recordFill(pending.state, timestamp, incrementalQuantity, incrementalPrice);
      await this.#scheduleExecutionQualityProbes(
        pending,
        timestamp,
        incrementalPrice,
        incrementalQuantity,
      );
      if (pending.purpose === "ENTRY") {
        const firstFill = this.#position === undefined;
        this.#position = reconcileEntryExposure(
          pending.state, pending.direction, timestamp, this.#risk, this.#position, pending.underlyingEntryPrice,
        );
        if (this.#position && firstFill) {
          if (pending.entryImpliedVolatility !== undefined) {
            this.#position.entryImpliedVolatility = pending.entryImpliedVolatility;
            this.#position.lastImpliedVolatility = pending.entryImpliedVolatility;
            this.#position.lastOptionSnapshotTimestamp =
              pending.entrySnapshotTimestamp ?? timestamp;
          }
        }
        if (firstFill) {
          this.#risk.recordEntry(timestamp);
          this.#lastAuditedManagementState = undefined;
        }
        this.#lifecycle = this.#position?.tradeState ?? "FLAT";
        await this.#audit(timestamp, "entry_fill", {
          signalId: pending.signalId,
          incrementalQuantity, incrementalPrice, cumulativeQuantity: totalFilled, position: this.#position,
        });
      } else if (this.#position) {
        const exitingPosition = { ...this.#position };
        const quantityBeforeFill = exitingPosition.quantity;
        const realizedPnl = 100 * incrementalQuantity * (incrementalPrice - exitingPosition.averageEntryPrice);
        this.#risk.recordRealizedPnl(timestamp, realizedPnl);
        this.#position.quantity -= incrementalQuantity;
        if (this.#position.quantity > 0 && quantityBeforeFill > 0) {
          const remainingFraction = this.#position.quantity / quantityBeforeFill;
          for (const key of [
            "executablePnl",
            "highWaterPnl",
            "lowWaterPnl",
            "protectedFloorPnl",
            "previousExecutablePnl",
          ] as const) {
            const value = this.#position[key];
            if (value !== undefined) this.#position[key] = value * remainingFraction;
          }
        }
        await this.#audit(timestamp, "exit_fill", {
          reason: pending.exitReason, incrementalQuantity, incrementalPrice, realizedPnl,
          exitIntentId: pending.exitIntentId,
          exitTriggers: this.#exitIntent?.triggers ?? [],
          symbol: exitingPosition.symbol, direction: exitingPosition.direction,
          entryTimestamp: exitingPosition.entryTimestamp, averageEntryPrice: exitingPosition.averageEntryPrice,
          highWaterPnl: exitingPosition.highWaterPnl,
          lowWaterPnl: exitingPosition.lowWaterPnl,
          executablePnl: exitingPosition.executablePnl,
          protectedFloorPnl: exitingPosition.protectedFloorPnl ?? null,
          estimatedRecoveryProbability: exitingPosition.estimatedRecoveryProbability ?? null,
          optionContinuation: exitingPosition.optionContinuation ?? null,
          tradeState: exitingPosition.tradeState,
          remainingQuantity: this.#position.quantity,
        });
        if (this.#position.quantity === 0) {
          await this.#portfolioRisk?.recordCompletedExit(
            this.#config.symbol, timestamp, realizedPnl, this.#portfolioReservationId,
          );
          this.#onCompletedExit?.({
            timestamp,
            entryTimestamp: exitingPosition.entryTimestamp,
            direction: exitingPosition.direction,
            reason: pending.exitReason ?? "BROKER_OR_POSITION_RISK",
            realizedPnl,
          });
          this.#position = undefined;
          this.#lastAuditedManagementState = undefined;
          this.#exitIntent = undefined;
          this.#lifecycle = "CLOSED";
          this.#safeMode = false;
        }
      }
    }

    const status = broker.status.toLowerCase();
    await this.#audit(timestamp, "broker_order_state", { purpose: pending.purpose, broker, localOrder: pending.state });
    if (pending.state.filledQuantity === pending.state.requestedQuantity || status === "filled") {
      if (pending.state.filledQuantity !== pending.state.requestedQuantity) {
        await this.#halt(timestamp, "BROKER_FILLED_STATUS_WITH_INCOMPLETE_QUANTITY", { broker, pending });
      }
      this.#pending = undefined;
      if (pending.purpose === "ENTRY" && !this.#position) {
        await this.#portfolioRisk?.releaseExposure(this.#config.symbol, this.#portfolioReservationId);
        this.#lifecycle = "FLAT";
      }
      return;
    }
    if (status === "rejected") {
      this.#orders.reject(pending.state, timestamp, "broker rejected order");
      this.#pending = undefined;
      await this.#reconcilePositionTruth(timestamp, `${pending.purpose}_ORDER_REJECTED`);
      if (pending.purpose === "ENTRY") {
        if (!this.#position) {
          await this.#portfolioRisk?.releaseExposure(this.#config.symbol, this.#portfolioReservationId);
        }
        this.#lifecycle = this.#position?.tradeState ?? "FLAT";
      } else if (this.#position) {
        this.#lifecycle = this.#safeMode ? "SAFE_MODE" : "EXIT_PENDING";
        await this.#audit(timestamp, "exit_attempt_failed", {
          exitIntentId: pending.exitIntentId,
          reason: pending.exitReason,
          brokerStatus: status,
          action: "RETRY_EXIT_INTENT",
        });
      }
      return;
    }
    if (CANCELED_BROKER_STATUSES.has(status)) {
      this.#orders.confirmCancel(pending.state, timestamp);
      this.#pending = undefined;
      await this.#reconcilePositionTruth(timestamp, `${pending.purpose}_ORDER_CANCELED`);
      if (pending.purpose === "ENTRY") {
        if (!this.#position) {
          await this.#portfolioRisk?.releaseExposure(this.#config.symbol, this.#portfolioReservationId);
        }
        this.#lifecycle = this.#position?.tradeState ?? "FLAT";
      } else if (this.#position) {
        this.#lifecycle = this.#safeMode ? "SAFE_MODE" : "EXIT_PENDING";
        await this.#audit(timestamp, "exit_attempt_canceled", {
          exitIntentId: pending.exitIntentId,
          reason: pending.exitReason,
          brokerStatus: status,
          action: "REPRICE_REMAINING_POSITION",
        });
      }
      return;
    }
    if (!ACTIVE_BROKER_STATUSES.has(status)) {
      await this.#halt(timestamp, `UNKNOWN_BROKER_ORDER_STATUS:${status}`, { broker });
    }
  }

  async #managePendingTimer(request: ExecutionTick): Promise<void> {
    const timestamp = request.timestamp;
    const pending = this.#pending;
    if (!pending || pending.state.status === "CANCEL_PENDING") return;
    const quote = this.#quoteFor(pending.state.symbol);
    const beforeReplacements = pending.state.replacements;
    const beforeLimit = pending.state.limitPrice;
    const microstructure = this.#microstructureFor(pending.state.symbol, request.optionMicrostructure);
    if (pending.purpose === "ENTRY") {
      pending.state.initialAggression = entryAggressionFromMicrostructure(
        this.#config,
        microstructure,
      );
      pending.state.actionTtlMs = entryReplaceTtlFromMicrostructure(
        this.#config,
        microstructure,
      );
    } else {
      pending.state.urgency = exitUrgencyFromMicrostructure(
        this.#config,
        this.#exitIntent?.urgency ?? pending.state.urgency,
        microstructure,
      );
      pending.state.actionTtlMs = urgencyTtl(
        pending.state.urgency,
        this.#config.execution.exitTtlMinMs,
        this.#config.execution.exitTtlMaxMs,
      );
    }
    this.#orders.onTimer(pending.state, timestamp, quote);
    if ((pending.state.status as string) === "CANCEL_PENDING") {
      await this.#requestCancel(timestamp);
      return;
    }
    if (pending.state.replacements !== beforeReplacements || pending.state.limitPrice !== beforeLimit) {
      try {
        const replacement = await this.#client.replaceOrder(pending.brokerOrderId, pending.state.limitPrice);
        pending.brokerOrderId = replacement.id;
        await this.#audit(timestamp, "broker_order_replaced", { purpose: pending.purpose, replacement, localOrder: pending.state });
        await this.#synchronizeBrokerOrder(replacement, timestamp);
      } catch (replaceError) {
        const current = await this.#client.getOrder(pending.brokerOrderId);
        await this.#synchronizeBrokerOrder(current, timestamp);
        if (this.#pending) await this.#halt(timestamp, "AMBIGUOUS_ORDER_REPLACEMENT", { replaceError, current });
      }
    }
  }

  async #requestCancel(timestamp: number): Promise<void> {
    const pending = this.#pending;
    if (!pending) return;
    if (pending.cancelRequested) return;
    this.#orders.requestCancel(pending.state, timestamp);
    pending.cancelRequested = true;
    try {
      await this.#client.cancelOrder(pending.brokerOrderId);
    } catch (cancelError) {
      const current = await this.#client.getOrder(pending.brokerOrderId);
      await this.#synchronizeBrokerOrder(current, timestamp);
      if (this.#pending && !["pending_cancel"].includes(current.status.toLowerCase())) {
        await this.#halt(timestamp, "AMBIGUOUS_ORDER_CANCEL", { cancelError, current });
      }
      return;
    }
    const current = await this.#client.getOrder(pending.brokerOrderId);
    await this.#synchronizeBrokerOrder(current, timestamp);
  }

  async #reconcilePositionTruth(timestamp: number, cause: string): Promise<void> {
    let brokerPositions: BrokerPosition[];
    try {
      brokerPositions = await this.#client.listPositions();
    } catch (error) {
      this.#safeMode = true;
      this.#lifecycle = "SAFE_MODE";
      await this.#audit(timestamp, "broker_position_reconciliation_unavailable", {
        cause,
        error: error instanceof Error ? error.message : String(error),
        action: "PERSIST_EXISTING_EXIT_INTENT",
      });
      return;
    }
    await this.#audit(timestamp, "broker_position_reconciliation", {
      cause,
      localPosition: this.#position ?? null,
      brokerPositions,
    });
    if (brokerPositions.length > 1) {
      await this.#halt(timestamp, "DUPLICATE_OR_UNEXPECTED_POSITIONS_AFTER_ORDER_TERMINAL", {
        cause,
        brokerPositions,
      });
    }
    const brokerPosition = brokerPositions[0];
    if (!brokerPosition) {
      if (this.#position) {
        await this.#audit(timestamp, "broker_flat_overrides_local_position", {
          cause,
          localPosition: this.#position,
        });
      }
      this.#position = undefined;
      await this.#portfolioRisk?.releaseExposure(this.#config.symbol, this.#portfolioReservationId);
      this.#lastAuditedManagementState = undefined;
      this.#exitIntent = undefined;
      this.#safeMode = false;
      this.#lifecycle = "CLOSED";
      return;
    }
    if (this.#position &&
        (this.#position.symbol !== brokerPosition.symbol ||
         this.#position.direction !== brokerPosition.direction)) {
      await this.#halt(timestamp, "BROKER_POSITION_IDENTITY_MISMATCH_AFTER_ORDER_TERMINAL", {
        cause,
        localPosition: this.#position,
        brokerPosition,
      });
    }
    if (!this.#position) {
      this.#position = this.#risk.createFilledPosition(
        brokerPosition.symbol,
        brokerPosition.direction,
        brokerPosition.quantity,
        brokerPosition.averageEntryPrice,
        timestamp,
        brokerPosition.underlyingEntryPrice,
      );
      this.#safeMode = true;
      this.#createExitIntent(timestamp, {
        exit: true,
        reason: "BROKER_OR_POSITION_RISK",
        triggers: ["BROKER_OR_POSITION_RISK"],
        updatedPosition: this.#position,
      });
      await this.#adoptPortfolioExposure(timestamp);
      return;
    }
    if (this.#position.quantity !== brokerPosition.quantity ||
        this.#position.averageEntryPrice !== brokerPosition.averageEntryPrice) {
      const prior = this.#position;
      this.#position = {
        ...prior,
        quantity: brokerPosition.quantity,
        averageEntryPrice: brokerPosition.averageEntryPrice,
        stopPrice: Math.max(
          this.#config.execution.optionTickSize,
          brokerPosition.averageEntryPrice * (1 - this.#config.risk.hardOptionStopPct),
        ),
      };
      this.#safeMode = true;
      if (this.#exitIntent) {
        this.#lifecycle = "SAFE_MODE";
      } else {
        this.#createExitIntent(timestamp, {
          exit: true,
          reason: "BROKER_OR_POSITION_RISK",
          triggers: ["BROKER_OR_POSITION_RISK"],
          updatedPosition: this.#position,
        });
      }
      await this.#audit(timestamp, "broker_position_quantity_overrode_local_state", {
        cause,
        prior,
        brokerPosition,
        updatedPosition: this.#position,
      });
      await this.#adoptPortfolioExposure(timestamp);
    }
  }

  async #adoptPortfolioExposure(timestamp: number): Promise<void> {
    if (!this.#portfolioRisk || !this.#position) return;
    await this.#portfolioRisk.adoptExposure(
      this.#config.symbol,
      100 * this.#position.quantity * this.#position.averageEntryPrice * this.#config.risk.hardOptionStopPct,
      100 * this.#position.quantity * this.#position.averageEntryPrice,
      timestamp,
      this.#portfolioReservationId,
    );
  }

  #createExitIntent(timestamp: number, decision: ExitDecision): void {
    if (!this.#position || !decision.exit || !decision.reason) return;
    const triggers = decision.triggers ?? [];
    const urgency = exitUrgency(triggers);
    if (this.#exitIntent) {
      for (const trigger of triggers) {
        if (!this.#exitIntent.triggers.includes(trigger)) this.#exitIntent.triggers.push(trigger);
      }
      this.#exitIntent.urgency = Math.max(this.#exitIntent.urgency, urgency);
      this.#lifecycle = this.#safeMode ? "SAFE_MODE" : "EXIT_PENDING";
      return;
    }
    this.#exitIntent = {
      id: `exit-${this.#position.entryTimestamp}-${this.#position.symbol}`,
      createdAt: timestamp,
      reason: decision.reason,
      triggers: [...triggers],
      urgency,
      attempts: 0,
    };
    this.#lifecycle = this.#safeMode ? "SAFE_MODE" : "EXIT_PENDING";
  }

  #entryCancellationReasons(request: ExecutionTick): string[] {
    const pending = this.#pending;
    if (!pending || pending.purpose !== "ENTRY") return [];
    const reasons: string[] = [];
    if (request.killSwitch) reasons.push("KILL_SWITCH");
    if (pending.signalTimestamp !== undefined &&
        request.timestamp - pending.signalTimestamp >= this.#config.execution.entrySignalTtlMs) {
      reasons.push("SIGNAL_TTL_EXPIRED");
    }
    const quote = this.#quoteFor(pending.state.symbol, request.optionQuote);
    if (!quote) {
      reasons.push("OPTION_QUOTE_UNAVAILABLE");
    } else {
      const validation = validateOptionQuote(quote, request.timestamp, this.#config.dataQuality);
      if (!validation.usable) {
        reasons.push(...validation.reasons.map((reason) => `QUOTE_${reason}`));
      }
      if (pending.maxEntryPremium !== undefined &&
          quote.bidPrice > pending.maxEntryPremium) {
        reasons.push("MAXIMUM_ENTRY_PREMIUM_EXCEEDED");
      }
    }
    if (request.regime &&
        isOppositeDirectionRegime(pending.direction, request.regime.regime)) {
      reasons.push("SIGNAL_DIRECTION_INVALIDATED");
    }
    const microstructure = this.#microstructureFor(
      pending.state.symbol,
      request.optionMicrostructure,
    );
    if (microstructure) {
      if (microstructure.confirmationScore <
          this.#config.execution.entryMicrostructureCancelScore) {
        reasons.push("OPTION_MICROSTRUCTURE_REVERSED");
      }
      if (microstructure.spreadExpansionRatio >
          this.#config.execution.entrySpreadExpansionCancelRatio) {
        reasons.push("OPTION_SPREAD_EXPANSION_CANCEL");
      }
    }
    return [...new Set(reasons)];
  }

  #rememberQuote(quote: OptionQuote | undefined): void {
    if (!quote) return;
    const previous = this.#lastOptionQuotes.get(quote.symbol);
    if (!previous || quote.timestamp >= previous.timestamp) this.#lastOptionQuotes.set(quote.symbol, quote);
  }

  #rememberMicrostructure(snapshot: OptionMicrostructureSnapshot | undefined): void {
    if (!snapshot) return;
    const previous = this.#lastOptionMicrostructures.get(snapshot.symbol);
    if (!previous || snapshot.timestamp >= previous.timestamp) {
      this.#lastOptionMicrostructures.set(snapshot.symbol, snapshot);
    }
  }

  #microstructureFor(
    symbol: string,
    preferred?: OptionMicrostructureSnapshot,
  ): OptionMicrostructureSnapshot | undefined {
    if (preferred?.symbol === symbol) return preferred;
    return this.#lastOptionMicrostructures.get(symbol);
  }

  async #scheduleExecutionQualityProbes(
    pending: PendingBrokerExecution,
    timestamp: number,
    fillPrice: number,
    quantity: number,
  ): Promise<void> {
    const arrivalMid = pending.arrivalMid;
    const immediateSlippagePerShare = arrivalMid === undefined
      ? undefined
      : pending.state.side === "buy"
        ? fillPrice - arrivalMid
        : arrivalMid - fillPrice;
    await this.#audit(timestamp, "execution_quality_fill", {
      purpose: pending.purpose,
      symbol: pending.state.symbol,
      side: pending.state.side,
      fillPrice,
      quantity,
      arrivalMid: arrivalMid ?? null,
      immediateSlippagePerShare: immediateSlippagePerShare ?? null,
      immediateSlippageDollars: immediateSlippagePerShare === undefined
        ? null : immediateSlippagePerShare * 100 * quantity,
      entryMicrostructureScore: pending.entryMicrostructureScore ?? null,
    });
    for (const horizonSec of this.#config.execution.executionQualityProbeSec) {
      this.#executionQualityProbes.push({
        symbol: pending.state.symbol,
        side: pending.state.side,
        purpose: pending.purpose,
        fillTimestamp: timestamp,
        fillPrice,
        quantity,
        horizonSec,
      });
    }
  }

  async #evaluateExecutionQualityProbes(timestamp: number): Promise<void> {
    for (let index = this.#executionQualityProbes.length - 1; index >= 0; index -= 1) {
      const probe = this.#executionQualityProbes[index]!;
      if (timestamp < probe.fillTimestamp + probe.horizonSec * 1_000) continue;
      const quote = this.#quoteFor(probe.symbol);
      if (!quote || quote.timestamp < probe.fillTimestamp + probe.horizonSec * 1_000) continue;
      const mid = (quote.bidPrice + quote.askPrice) / 2;
      const adverseSelectionPerShare = probe.side === "buy"
        ? probe.fillPrice - mid
        : mid - probe.fillPrice;
      await this.#audit(timestamp, "execution_quality_probe", {
        purpose: probe.purpose,
        symbol: probe.symbol,
        side: probe.side,
        fillTimestamp: probe.fillTimestamp,
        fillPrice: probe.fillPrice,
        quantity: probe.quantity,
        horizonSec: probe.horizonSec,
        observedQuoteTimestamp: quote.timestamp,
        observedMid: mid,
        adverseSelectionPerShare,
        adverseSelectionDollars: adverseSelectionPerShare * 100 * probe.quantity,
      });
      this.#executionQualityProbes.splice(index, 1);
    }
  }

  #quoteFor(symbol: string, preferred?: OptionQuote): OptionQuote | undefined {
    if (preferred?.symbol === symbol) return preferred;
    return this.#lastOptionQuotes.get(symbol);
  }

  #clientOrderId(purpose: "entry" | "exit", discriminator: string, timestamp: number): string {
    const safe = discriminator.replace(/[^A-Za-z0-9_-]/g, "-");
    return `${this.#config.symbol.toLowerCase()}0dte-${purpose}-${timestamp}-${safe}`.slice(0, 128);
  }

  async #audit(timestamp: number, type: string, data: Record<string, unknown>): Promise<void> {
    try {
      await this.#recorder.record({
        timestamp,
        marketDate: marketDate(timestamp, this.#config.timeZone),
        type,
        configVersion: this.#config.version,
        data: { underlying: this.#config.symbol, ...data },
      });
      if (!this.#recorder.healthy()) throw new Error("audit recorder unhealthy");
    } catch (error) {
      this.#halted = true;
      this.#haltReason = "AUDIT_RECORDER_FAILURE";
      this.#safeMode = true;
      this.#lifecycle = "SAFE_MODE";
      throw error;
    }
  }

  async #halt(timestamp: number, reason: string, detail: Record<string, unknown> = {}): Promise<never> {
    this.#halted = true;
    this.#haltReason = reason;
    this.#safeMode = true;
    this.#lifecycle = "SAFE_MODE";
    try {
      await this.#recorder.record({
        timestamp,
        marketDate: marketDate(timestamp, this.#config.timeZone),
        type: "execution_halted",
        configVersion: this.#config.version,
        data: { underlying: this.#config.symbol, reason, ...detail },
      });
    } catch {
      // Preserve the first operational failure even when the recorder is also unavailable.
    }
    throw new Error(`Execution halted: ${reason}`);
  }

  #assertOperational(): void {
    if (this.#halted) throw new Error(`Execution manager halted: ${this.#haltReason ?? "UNKNOWN"}`);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function maximumEntryPremium(
  candidate: OptionCandidateEvaluation,
  quote: OptionQuote,
  config: EngineConfig,
): number {
  const midpoint = (quote.bidPrice + quote.askPrice) / 2;
  const projectedMove = candidate.gammaAwareProjectedOptionMove;
  const roundTripCost = candidate.roundTripCostPerShare;
  if (projectedMove !== undefined && projectedMove > 0 &&
      roundTripCost !== undefined && roundTripCost >= 0) {
    const predictedFuturePremium = midpoint + projectedMove;
    return Math.max(
      config.execution.optionTickSize,
      predictedFuturePremium - config.signals.costMultiplier * roundTripCost,
    );
  }
  // Without a calibrated premium forecast, never chase beyond the signal-time ask.
  return quote.askPrice;
}

function validatedUnifiedPosition(position: PositionState): PositionState {
  if (![
    "OPEN_UNPROTECTED",
    "PROTECTED_SOFT",
    "PROTECTED_WINNER",
    "PROTECTED_RECOVERED",
  ].includes(position.tradeState) ||
      ![
        position.executablePnl,
        position.highWaterPnl,
        position.lowWaterPnl,
        position.lastPnlTimestamp,
        position.lastHighTimestamp,
        position.previousExecutablePnl,
        position.pnlEwmaDriftPerSec,
        position.pnlEwmaVariancePerSec,
        position.reversalCusum,
        position.zeroCrossings,
        position.pnlObservationCount,
      ].every(Number.isFinite)) {
    throw new Error("Restored position does not contain a complete unified order-management state");
  }
  if ((position.softProtectionCandidateObservationCount !== undefined &&
       !(Number.isInteger(position.softProtectionCandidateObservationCount) &&
         position.softProtectionCandidateObservationCount >= 0)) ||
      (position.softProtectionActivatedAt !== undefined &&
       !Number.isFinite(position.softProtectionActivatedAt)) ||
      (position.softFloorBreachStartedAt !== undefined &&
       !Number.isFinite(position.softFloorBreachStartedAt)) ||
      (position.softFloorBreachCandidateObservationCount !== undefined &&
       !(Number.isInteger(position.softFloorBreachCandidateObservationCount) &&
         position.softFloorBreachCandidateObservationCount >= 0 &&
         position.softFloorBreachCandidateObservationCount <=
           position.pnlObservationCount)) ||
      ((position.softFloorBreachStartedAt === undefined) !==
       (position.softFloorBreachCandidateObservationCount === undefined))) {
    throw new Error("Restored position contains an invalid soft-protection state");
  }
  const oppositeRegimeState = [
    position.oppositeRegimeSince,
    position.oppositeRegimeObservationCount,
    position.lastOppositeRegimeFeatureTimestamp,
  ];
  const hasAnyOppositeRegimeState = oppositeRegimeState.some(
    (value) => value !== undefined,
  );
  const hasCompleteOppositeRegimeState = oppositeRegimeState.every(
    (value) => value !== undefined,
  );
  if (hasAnyOppositeRegimeState && (
    !hasCompleteOppositeRegimeState ||
    !Number.isFinite(position.oppositeRegimeSince) ||
    !(Number.isInteger(position.oppositeRegimeObservationCount) &&
      position.oppositeRegimeObservationCount! >= 1) ||
    !Number.isFinite(position.lastOppositeRegimeFeatureTimestamp) ||
    position.lastOppositeRegimeFeatureTimestamp! < position.oppositeRegimeSince!
  )) {
    throw new Error("Restored position contains an invalid opposite-regime confirmation state");
  }
  return { ...position };
}

function exitUrgency(triggers: readonly ExitTrigger[]): number {
  if (triggers.some((trigger) =>
    trigger === "BROKER_OR_POSITION_RISK" ||
    trigger === "FORCED_TIME_EXIT" ||
    trigger === "HARD_LOSS_BOUNDARY" ||
    trigger === "DAILY_RISK_SHUTDOWN")) return 1;
  if (triggers.some((trigger) =>
    trigger === "PROFIT_FLOOR_BREACH" ||
    trigger === "REVERSAL_CUSUM")) return 0.85;
  if (triggers.some((trigger) => trigger === "STRUCTURAL_INVALIDATION")) return 0.75;
  if (triggers.length > 0) return 0.65;
  return 0.75;
}

function isOppositeDirectionRegime(
  direction: TradeSignal["direction"],
  regime: RegimeDecision["regime"],
): boolean {
  const down = new Set(["STRONG_DOWN", "GRIND_DOWN", "GAP_AND_GO_DOWN", "REVERSAL_DOWN"]);
  const up = new Set(["STRONG_UP", "GRIND_UP", "GAP_AND_GO_UP", "REVERSAL_UP"]);
  return direction === "BULLISH" ? down.has(regime) : up.has(regime);
}
