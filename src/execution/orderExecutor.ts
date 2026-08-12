import type { EngineConfig } from "../config.js";
import type { OptionMicrostructureSnapshot, OptionQuote } from "../types.js";
import type { Direction, PositionState } from "../types.js";
import type { RiskManager } from "../risk/riskManager.js";
import { assertSameDayOptionOrder } from "../options/tradingInvariants.js";

export type OrderSide = "buy" | "sell";
export type OrderStatus = "PROPOSED" | "SUBMITTED" | "PARTIAL" | "REPLACE_PENDING" | "CANCEL_PENDING" | "FILLED" | "CANCELED" | "REJECTED";

export interface OrderState {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  requestedQuantity: number;
  filledQuantity: number;
  averageFillPrice: number;
  limitPrice: number;
  status: OrderStatus;
  submittedAt: number;
  lastActionAt: number;
  replacements: number;
  marketable: boolean;
  urgency: number;
  actionTtlMs: number;
  priceCollar: number;
  initialAggression?: number;
  intentId?: string;
  events: Array<{ timestamp: number; status: OrderStatus; detail: string }>;
}

export interface OrderProposal {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  timestamp: number;
  quote: OptionQuote;
  marketable?: boolean;
  urgency?: number;
  actionTtlMs?: number;
  priceCollar?: number;
  intentId?: string;
  spreadFraction?: number;
}

export function aggressionAtReplacement(initial: number, replacement: number, maximumReplacements: number): number {
  return Math.min(1, initial + replacement * (1 - initial) / Math.max(1, maximumReplacements));
}

export function limitInsideSpread(
  bid: number, ask: number, side: OrderSide, aggression: number, tickSize = 0.01,
): number {
  const raw = side === "buy" ? bid + aggression * (ask - bid) : ask - aggression * (ask - bid);
  const ticks = raw / tickSize;
  return side === "buy" ? Math.ceil(ticks - 1e-10) * tickSize : Math.floor(ticks + 1e-10) * tickSize;
}

export function urgencyTtl(
  urgency: number,
  minimumMs: number,
  maximumMs: number,
): number {
  const bounded = Math.min(1, Math.max(0, urgency));
  return Math.round((1 - bounded) * maximumMs + bounded * minimumMs);
}

export function entryAggressionFromMicrostructure(
  config: EngineConfig,
  microstructure: OptionMicrostructureSnapshot | undefined,
): number {
  const adjustment = config.execution.entryMicrostructureAggressionAdjustment *
    (microstructure?.confirmationScore ?? 0);
  return clamp(config.execution.entryLimitSpreadFraction + adjustment, 0.05, 1);
}

export function entryReplaceTtlFromMicrostructure(
  config: EngineConfig,
  microstructure: OptionMicrostructureSnapshot | undefined,
): number {
  const positivePressure = clamp(microstructure?.confirmationScore ?? 0, 0, 1);
  return urgencyTtl(
    positivePressure,
    config.execution.entryReplaceMinMs,
    config.execution.replaceAfterMs,
  );
}

export function exitUrgencyFromMicrostructure(
  config: EngineConfig,
  baseUrgency: number,
  microstructure: OptionMicrostructureSnapshot | undefined,
): number {
  const adversePressure = clamp(-(microstructure?.confirmationScore ?? 0), 0, 1);
  const spreadPressure = clamp((microstructure?.spreadExpansionRatio ?? 1) - 1, 0, 1);
  return clamp(
    baseUrgency + config.execution.exitMicrostructureUrgencyAdjustment *
      Math.max(adversePressure, spreadPressure),
    0,
    1,
  );
}

/** Deterministic state machine used by replay and broker adapters. */
export class OrderExecutor {
  readonly #config: EngineConfig;
  constructor(config: EngineConfig) { this.#config = config; }

  propose(proposal: OrderProposal): OrderState {
    assertSameDayOptionOrder(proposal.symbol, proposal.side, proposal.timestamp, this.#config);
    if (proposal.quote.symbol !== proposal.symbol) throw new Error("Option-only order rejected: quote symbol mismatch");
    if (!Number.isInteger(proposal.quantity) || proposal.quantity < 1) throw new Error("Option quantity must be a positive whole number");
    const configuredFraction = proposal.side === "buy"
      ? this.#config.execution.entryLimitSpreadFraction
      : this.#config.execution.exitLimitSpreadFraction;
    const fraction = proposal.marketable ? 1 : clamp(
      proposal.spreadFraction ?? configuredFraction,
      0,
      1,
    );
    const limit = limitInsideSpread(
      proposal.quote.bidPrice, proposal.quote.askPrice, proposal.side, fraction, this.#config.execution.optionTickSize,
    );
    const urgency = Math.min(1, Math.max(0, proposal.urgency ?? (proposal.marketable ? 1 : 0)));
    const defaultCollar = proposal.side === "buy"
      ? proposal.quote.askPrice * (1 + this.#config.execution.exitPriceCollarPct)
      : Math.max(
          this.#config.execution.optionTickSize,
          proposal.quote.bidPrice * (1 - this.#config.execution.exitPriceCollarPct),
        );
    const priceCollar = proposal.priceCollar ?? defaultCollar;
    const boundedLimit = proposal.side === "buy"
      ? Math.min(limit, priceCollar)
      : Math.max(limit, priceCollar);
    return {
      clientOrderId: proposal.clientOrderId,
      symbol: proposal.symbol,
      side: proposal.side,
      requestedQuantity: proposal.quantity,
      filledQuantity: 0,
      averageFillPrice: 0,
      limitPrice: boundedLimit,
      status: "PROPOSED",
      submittedAt: proposal.timestamp,
      lastActionAt: proposal.timestamp,
      replacements: 0,
      marketable: proposal.marketable ?? false,
      urgency,
      actionTtlMs: proposal.actionTtlMs ?? (
        proposal.marketable
          ? urgencyTtl(
              urgency,
              this.#config.execution.exitTtlMinMs,
              this.#config.execution.exitTtlMaxMs,
            )
          : this.#config.execution.replaceAfterMs
      ),
      priceCollar,
      initialAggression: fraction,
      ...(proposal.intentId ? { intentId: proposal.intentId } : {}),
      events: [{
        timestamp: proposal.timestamp,
        status: "PROPOSED",
        detail: `limit=${boundedLimit} urgency=${urgency.toFixed(2)} ttl=${proposal.actionTtlMs ?? this.#config.execution.replaceAfterMs}`,
      }],
    };
  }

  submit(state: OrderState, timestamp: number): OrderState {
    assertSameDayOptionOrder(state.symbol, state.side, timestamp, this.#config);
    return this.#transition(state, "SUBMITTED", timestamp, "accepted for submission");
  }

  reject(state: OrderState, timestamp: number, reason: string): OrderState {
    return this.#transition(state, "REJECTED", timestamp, reason);
  }

  recordFill(state: OrderState, timestamp: number, quantity: number, price: number): OrderState {
    if (quantity <= 0 || state.filledQuantity + quantity > state.requestedQuantity) throw new Error("Invalid fill quantity");
    const notional = state.averageFillPrice * state.filledQuantity + price * quantity;
    state.filledQuantity += quantity;
    state.averageFillPrice = notional / state.filledQuantity;
    const status = state.filledQuantity === state.requestedQuantity ? "FILLED" : "PARTIAL";
    return this.#transition(state, status, timestamp, `fill ${quantity}@${price}`);
  }

  onTimer(state: OrderState, timestamp: number, freshQuote?: OptionQuote): OrderState {
    if (!["SUBMITTED", "PARTIAL"].includes(state.status)) return state;
    if (state.marketable) {
      if (freshQuote && timestamp - state.lastActionAt >= state.actionTtlMs &&
          timestamp - freshQuote.timestamp <= this.#config.dataQuality.maxOptionQuoteAgeMs) {
        state.replacements += 1;
        const extraTicks = Math.ceil(
          state.urgency * this.#config.execution.exitMarketableOffsetTicks *
          Math.max(1, state.replacements),
        );
        const rawLimit = state.side === "sell"
          ? freshQuote.bidPrice - extraTicks * this.#config.execution.optionTickSize
          : freshQuote.askPrice + extraTicks * this.#config.execution.optionTickSize;
        const ticks = rawLimit / this.#config.execution.optionTickSize;
        const rounded = state.side === "sell"
          ? Math.floor(ticks + 1e-10) * this.#config.execution.optionTickSize
          : Math.ceil(ticks - 1e-10) * this.#config.execution.optionTickSize;
        state.limitPrice = state.side === "sell"
          ? Math.max(state.priceCollar, rounded)
          : Math.min(state.priceCollar, rounded);
        return this.#transition(
          state,
          "SUBMITTED",
          timestamp,
          `marketable replacement ${state.replacements} limit=${state.limitPrice}`,
        );
      }
      return state;
    }
    if (timestamp - state.submittedAt >= this.#config.execution.cancelAfterMs) {
      return this.#transition(state, "CANCEL_PENDING", timestamp, "cancel deadline reached");
    }
    if (timestamp - state.lastActionAt >= state.actionTtlMs &&
        state.replacements < this.#config.execution.maxReplaces && freshQuote &&
        timestamp - freshQuote.timestamp <= this.#config.dataQuality.maxOptionQuoteAgeMs) {
      state.replacements += 1;
      const initial = state.initialAggression ?? (state.marketable ? 1 : state.side === "buy"
        ? this.#config.execution.entryLimitSpreadFraction : this.#config.execution.exitLimitSpreadFraction);
      const aggression = aggressionAtReplacement(initial, state.replacements, this.#config.execution.maxReplaces);
      state.limitPrice = limitInsideSpread(
        freshQuote.bidPrice, freshQuote.askPrice, state.side, aggression, this.#config.execution.optionTickSize,
      );
      return this.#transition(state, "SUBMITTED", timestamp, `replacement ${state.replacements} limit=${state.limitPrice}`);
    }
    return state;
  }

  confirmCancel(state: OrderState, timestamp: number): OrderState {
    return this.#transition(state, "CANCELED", timestamp, `remainder=${state.requestedQuantity - state.filledQuantity}`);
  }

  requestCancel(state: OrderState, timestamp: number, detail = "cancel requested"): OrderState {
    if (!["SUBMITTED", "PARTIAL"].includes(state.status)) return state;
    return this.#transition(state, "CANCEL_PENDING", timestamp, detail);
  }

  /** Optimistic baseline dry-run: fills at limit when it reaches midpoint. */
  simulateMidpointFill(state: OrderState, quote: OptionQuote, timestamp: number, maxQuantity?: number): OrderState {
    if (!["SUBMITTED", "PARTIAL"].includes(state.status)) return state;
    const midpoint = (quote.bidPrice + quote.askPrice) / 2;
    const touches = state.side === "buy" ? state.limitPrice >= midpoint : state.limitPrice <= midpoint;
    if (!touches) return state;
    const remaining = state.requestedQuantity - state.filledQuantity;
    const quantity = Math.min(remaining, maxQuantity ?? remaining);
    return this.recordFill(state, timestamp, quantity, state.limitPrice);
  }

  #transition(state: OrderState, status: OrderStatus, timestamp: number, detail: string): OrderState {
    state.status = status;
    state.lastActionAt = timestamp;
    state.events.push({ timestamp, status, detail });
    return state;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Call after every entry fill, including a partial one. It immediately creates
 * authoritative exposure, reprices the hard stop from the actual average fill,
 * and prevents another entry while the remainder is working.
 */
export function reconcileEntryExposure(
  state: OrderState,
  direction: Direction,
  timestamp: number,
  riskManager: RiskManager,
  existing?: PositionState,
  underlyingEntryPrice?: number,
): PositionState | undefined {
  if (state.filledQuantity < 1) return existing;
  if (existing && existing.symbol !== state.symbol) throw new Error("Partial fill conflicts with authoritative position");
  return riskManager.createFilledPosition(
    state.symbol, direction, state.filledQuantity, state.averageFillPrice,
    existing?.entryTimestamp ?? timestamp, existing?.underlyingEntryPrice ?? underlyingEntryPrice,
  );
}
