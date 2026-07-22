import type { EngineConfig } from "../config.js";
import type {
  AccountState, ExitReason, FeatureSnapshot, OptionCandidateEvaluation, OptionQuote, PositionState,
  RegimeDecision, RiskDecision, TradeSignal,
} from "../types.js";
import type { BrokerOrder, TradingRestClient } from "../alpaca/restClient.js";
import { reconcileBrokerState } from "../alpaca/restClient.js";
import { validateOptionQuote } from "../features/quoteSanitizer.js";
import { sameDaySpyOptionContractReasons } from "../options/tradingInvariants.js";
import { ExitManager } from "../risk/exitManager.js";
import { RiskManager } from "../risk/riskManager.js";
import type { AuditRecorder } from "../ops/recorder.js";
import { MemoryRecorder } from "../ops/recorder.js";
import { marketDate } from "../utils/time.js";
import { OrderExecutor, reconcileEntryExposure, type OrderState } from "./orderExecutor.js";

type ExecutionPurpose = "ENTRY" | "EXIT";

interface PendingBrokerExecution {
  purpose: ExecutionPurpose;
  brokerOrderId: string;
  state: OrderState;
  direction: TradeSignal["direction"];
  signalId?: string;
  exitReason?: ExitReason;
  cancelRequested?: boolean;
  lastPolledAt: number;
}

export interface EntryExecutionRequest {
  timestamp: number;
  signal: TradeSignal;
  candidate: OptionCandidateEvaluation;
  quote: OptionQuote;
  killSwitch?: boolean;
}

export interface ExecutionTick {
  timestamp: number;
  optionQuote?: OptionQuote;
  feature?: FeatureSnapshot;
  regime?: RegimeDecision;
  killSwitch?: boolean;
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
  position?: PositionState;
  pending?: {
    purpose: ExecutionPurpose;
    brokerOrderId: string;
    exitReason?: ExitReason;
    order: OrderState;
  };
}

export interface LiveOrderManagerOptions {
  config: EngineConfig;
  client: TradingRestClient;
  recorder?: AuditRecorder;
  restoredPosition?: PositionState;
  knownClientOrderIds?: ReadonlySet<string>;
}

const ACTIVE_BROKER_STATUSES = new Set([
  "accepted", "accepted_for_bidding", "new", "pending_new", "partially_filled", "pending_cancel", "pending_replace", "stopped",
]);
const CANCELED_BROKER_STATUSES = new Set(["canceled", "expired", "done_for_day", "replaced", "calculated"]);

/**
 * Broker-backed, serialized lifecycle coordinator for long 0DTE SPY options.
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
  #position: PositionState | undefined;
  #pending: PendingBrokerExecution | undefined;
  readonly #lastOptionQuotes = new Map<string, OptionQuote>();
  #halted = false;
  #haltReason: string | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: LiveOrderManagerOptions) {
    this.#config = options.config;
    this.#client = options.client;
    this.#recorder = options.recorder ?? new MemoryRecorder();
    this.#orders = new OrderExecutor(options.config);
    this.#risk = new RiskManager(options.config);
    this.#exits = new ExitManager(options.config);
    this.#position = options.restoredPosition ? { ...options.restoredPosition } : undefined;
    this.#knownClientOrderIds = new Set(options.knownClientOrderIds ?? []);
  }

  initialize(timestamp: number): Promise<LiveExecutionSnapshot> {
    return this.#serialize(async () => {
      this.#assertOperational();
      const reconciliation = await reconcileBrokerState(this.#client, this.#position, this.#knownClientOrderIds);
      await this.#audit(timestamp, "broker_reconciliation", { reconciliation });
      if (!reconciliation.matched || reconciliation.openOrders.length > 0) {
        const reasons = [...reconciliation.reasons];
        if (reconciliation.openOrders.length > 0) reasons.push("OPEN_ORDERS_REQUIRE_RESTORED_LOCAL_STATE");
        await this.#halt(timestamp, `BROKER_RECONCILIATION_FAILED:${[...new Set(reasons)].join(",")}`);
      }
      return this.snapshot();
    });
  }

  submitEntry(request: EntryExecutionRequest): Promise<EntryExecutionResult> {
    return this.#serialize(async () => {
      this.#assertOperational();
      const reasons: string[] = [];
      if (this.#pending) reasons.push("ORDER_ALREADY_PENDING");
      if (this.#position) reasons.push("POSITION_ALREADY_OPEN");
      if (!request.candidate.eligible) reasons.push("CANDIDATE_NOT_ELIGIBLE");
      if (!request.candidate.contract) reasons.push("MISSING_OPTION_CONTRACT");
      if (request.candidate.symbol !== request.quote.symbol) reasons.push("CANDIDATE_QUOTE_SYMBOL_MISMATCH");
      if (request.candidate.symbol === "SPY") reasons.push("UNDERLYING_ORDER_FORBIDDEN");

      const clock = await this.#client.getMarketClock();
      if (!clock.isOpen) reasons.push("MARKET_CLOSED");
      if (request.candidate.contract) {
        reasons.push(...sameDaySpyOptionContractReasons(request.candidate.contract, clock.timestamp, this.#config.timeZone));
      }
      const quoteValidation = validateOptionQuote(request.quote, clock.timestamp, this.#config.dataQuality);
      if (!quoteValidation.usable) reasons.push(...quoteValidation.reasons.map((reason) => `QUOTE_${reason}`));
      if (reasons.length > 0) {
        await this.#audit(clock.timestamp, "entry_blocked", { signalId: request.signal.id, reasons });
        return { submitted: false, reasons: [...new Set(reasons)] };
      }
      this.#rememberQuote(request.quote);

      const account = await this.#client.getAccount();
      const guardedAccount: AccountState = { ...account, killSwitch: account.killSwitch || request.killSwitch === true };
      const optionMid = (request.quote.bidPrice + request.quote.askPrice) / 2;
      const risk = this.#risk.evaluate({
        timestamp: clock.timestamp,
        optionMid,
        account: guardedAccount,
        hasOpenPosition: this.#position !== undefined,
      });
      await this.#audit(clock.timestamp, "risk_decision", { signalId: request.signal.id, risk });
      if (!risk.allowed) return { submitted: false, reasons: risk.reasons, risk };

      const clientOrderId = this.#clientOrderId("entry", request.signal.id, clock.timestamp);
      let state = this.#orders.propose({
        clientOrderId,
        symbol: request.candidate.symbol,
        side: "buy",
        quantity: risk.quantity,
        timestamp: clock.timestamp,
        quote: request.quote,
      });
      state = this.#orders.submit(state, clock.timestamp);
      await this.#audit(clock.timestamp, "broker_order_request", {
        purpose: "ENTRY", signalId: request.signal.id, order: state,
      });
      const brokerOrder = await this.#submitOrRecover(state, clock.timestamp);
      this.#knownClientOrderIds.add(clientOrderId);
      this.#pending = {
        purpose: "ENTRY",
        brokerOrderId: brokerOrder.id,
        state,
        direction: request.signal.direction,
        signalId: request.signal.id,
        lastPolledAt: clock.timestamp,
      };
      await this.#synchronizeBrokerOrder(brokerOrder, clock.timestamp);
      return { submitted: true, reasons: [], risk, brokerOrder };
    });
  }

  tick(request: ExecutionTick): Promise<LiveExecutionSnapshot> {
    return this.#serialize(async () => {
      this.#assertOperational();
      this.#rememberQuote(request.optionQuote);

      if (this.#pending && request.timestamp - this.#pending.lastPolledAt >= this.#config.execution.orderPollMs) {
        const brokerOrder = await this.#client.getOrder(this.#pending.brokerOrderId);
        await this.#synchronizeBrokerOrder(brokerOrder, request.timestamp);
      }

      if (this.#pending?.purpose === "ENTRY" && this.#position) {
        const exit = this.#evaluateExit(request);
        if (exit.exit) {
          await this.#audit(request.timestamp, "partial_entry_exit_requested", { reason: exit.reason, position: this.#position });
          await this.#requestCancel(request.timestamp);
          if (!this.#pending && this.#position) await this.#submitExit(request.timestamp, exit.reason!);
          return this.snapshot();
        }
      }

      if (this.#pending) {
        await this.#managePendingTimer(request.timestamp);
        return this.snapshot();
      }

      if (this.#position) {
        const exit = this.#evaluateExit(request);
        if (exit.exit) await this.#submitExit(request.timestamp, exit.reason!);
      }
      return this.snapshot();
    });
  }

  snapshot(): LiveExecutionSnapshot {
    return {
      halted: this.#halted,
      ...(this.#haltReason ? { haltReason: this.#haltReason } : {}),
      ...(this.#position ? { position: { ...this.#position } } : {}),
      ...(this.#pending ? { pending: {
        purpose: this.#pending.purpose,
        brokerOrderId: this.#pending.brokerOrderId,
        ...(this.#pending.exitReason ? { exitReason: this.#pending.exitReason } : {}),
        order: { ...this.#pending.state, events: [...this.#pending.state.events] },
      } } : {}),
    };
  }

  #evaluateExit(request: ExecutionTick): ReturnType<ExitManager["evaluate"]> {
    if (!this.#position) throw new Error("Cannot evaluate exit without a position");
    const quote = this.#quoteFor(this.#position.symbol, request.optionQuote);
    const decision = this.#exits.evaluate({
      timestamp: request.timestamp,
      position: this.#position,
      ...(quote ? { optionQuote: quote } : {}),
      ...(request.feature ? { feature: request.feature } : {}),
      ...(request.regime ? { regime: request.regime } : {}),
      killSwitch: request.killSwitch === true,
    });
    this.#position = decision.updatedPosition;
    return decision;
  }

  async #submitExit(timestamp: number, reason: ExitReason): Promise<void> {
    if (!this.#position) return;
    const quote = this.#quoteFor(this.#position.symbol);
    if (!quote) {
      const reconciliation = await reconcileBrokerState(this.#client, this.#position, this.#knownClientOrderIds);
      await this.#audit(timestamp, "exit_quote_missing", { reason, reconciliation });
      await this.#halt(timestamp, `CANNOT_PRICE_EXIT:${reason}`);
    }
    const marketable = reason !== "PROFIT_TARGET";
    const clientOrderId = this.#clientOrderId("exit", reason, timestamp);
    let state = this.#orders.propose({
      clientOrderId,
      symbol: this.#position.symbol,
      side: "sell",
      quantity: this.#position.quantity,
      timestamp,
      quote: quote!,
      marketable,
    });
    state = this.#orders.submit(state, timestamp);
    await this.#audit(timestamp, "broker_order_request", { purpose: "EXIT", reason, marketable, order: state });
    const brokerOrder = await this.#submitOrRecover(state, timestamp);
    this.#knownClientOrderIds.add(clientOrderId);
    this.#pending = {
      purpose: "EXIT",
      brokerOrderId: brokerOrder.id,
      state,
      direction: this.#position.direction,
      exitReason: reason,
      lastPolledAt: timestamp,
    };
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
      if (pending.purpose === "ENTRY") {
        const firstFill = this.#position === undefined;
        this.#position = reconcileEntryExposure(pending.state, pending.direction, timestamp, this.#risk, this.#position);
        if (firstFill) this.#risk.recordEntry(timestamp);
        await this.#audit(timestamp, "entry_fill", {
          signalId: pending.signalId,
          incrementalQuantity, incrementalPrice, cumulativeQuantity: totalFilled, position: this.#position,
        });
      } else if (this.#position) {
        const exitingPosition = { ...this.#position };
        const realizedPnl = 100 * incrementalQuantity * (incrementalPrice - exitingPosition.averageEntryPrice);
        this.#risk.recordRealizedPnl(timestamp, realizedPnl);
        this.#position.quantity -= incrementalQuantity;
        await this.#audit(timestamp, "exit_fill", {
          reason: pending.exitReason, incrementalQuantity, incrementalPrice, realizedPnl,
          symbol: exitingPosition.symbol, direction: exitingPosition.direction,
          entryTimestamp: exitingPosition.entryTimestamp, averageEntryPrice: exitingPosition.averageEntryPrice,
          highWaterMark: exitingPosition.highWaterMark, lowWaterMark: exitingPosition.lowWaterMark,
          remainingQuantity: this.#position.quantity,
        });
        if (this.#position.quantity === 0) this.#position = undefined;
      }
    }

    const status = broker.status.toLowerCase();
    await this.#audit(timestamp, "broker_order_state", { purpose: pending.purpose, broker, localOrder: pending.state });
    if (pending.state.filledQuantity === pending.state.requestedQuantity || status === "filled") {
      if (pending.state.filledQuantity !== pending.state.requestedQuantity) {
        await this.#halt(timestamp, "BROKER_FILLED_STATUS_WITH_INCOMPLETE_QUANTITY", { broker, pending });
      }
      this.#pending = undefined;
      return;
    }
    if (status === "rejected") {
      this.#orders.reject(pending.state, timestamp, "broker rejected order");
      this.#pending = undefined;
      return;
    }
    if (CANCELED_BROKER_STATUSES.has(status)) {
      this.#orders.confirmCancel(pending.state, timestamp);
      this.#pending = undefined;
      return;
    }
    if (!ACTIVE_BROKER_STATUSES.has(status)) {
      await this.#halt(timestamp, `UNKNOWN_BROKER_ORDER_STATUS:${status}`, { broker });
    }
  }

  async #managePendingTimer(timestamp: number): Promise<void> {
    const pending = this.#pending;
    if (!pending || pending.state.status === "CANCEL_PENDING") return;
    const quote = this.#quoteFor(pending.state.symbol);
    const beforeReplacements = pending.state.replacements;
    const beforeLimit = pending.state.limitPrice;
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

  #rememberQuote(quote: OptionQuote | undefined): void {
    if (!quote) return;
    const previous = this.#lastOptionQuotes.get(quote.symbol);
    if (!previous || quote.timestamp >= previous.timestamp) this.#lastOptionQuotes.set(quote.symbol, quote);
  }

  #quoteFor(symbol: string, preferred?: OptionQuote): OptionQuote | undefined {
    if (preferred?.symbol === symbol) return preferred;
    return this.#lastOptionQuotes.get(symbol);
  }

  #clientOrderId(purpose: "entry" | "exit", discriminator: string, timestamp: number): string {
    const safe = discriminator.replace(/[^A-Za-z0-9_-]/g, "-");
    return `spy0dte-${purpose}-${timestamp}-${safe}`.slice(0, 128);
  }

  async #audit(timestamp: number, type: string, data: Record<string, unknown>): Promise<void> {
    try {
      await this.#recorder.record({
        timestamp,
        marketDate: marketDate(timestamp, this.#config.timeZone),
        type,
        configVersion: this.#config.version,
        data,
      });
      if (!this.#recorder.healthy()) throw new Error("audit recorder unhealthy");
    } catch (error) {
      this.#halted = true;
      this.#haltReason = "AUDIT_RECORDER_FAILURE";
      throw error;
    }
  }

  async #halt(timestamp: number, reason: string, detail: Record<string, unknown> = {}): Promise<never> {
    this.#halted = true;
    this.#haltReason = reason;
    try {
      await this.#recorder.record({
        timestamp,
        marketDate: marketDate(timestamp, this.#config.timeZone),
        type: "execution_halted",
        configVersion: this.#config.version,
        data: { reason, ...detail },
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
