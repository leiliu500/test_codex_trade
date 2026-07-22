import type { EngineConfig } from "../config.js";
import type { OptionQuote } from "../types.js";
import type { Direction, PositionState } from "../types.js";
import type { RiskManager } from "../risk/riskManager.js";
import { assertSameDaySpyOptionOrder } from "../options/tradingInvariants.js";

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

/** Deterministic state machine used by replay and broker adapters. */
export class OrderExecutor {
  readonly #config: EngineConfig;
  constructor(config: EngineConfig) { this.#config = config; }

  propose(proposal: OrderProposal): OrderState {
    assertSameDaySpyOptionOrder(proposal.symbol, proposal.side, proposal.timestamp, this.#config);
    if (proposal.quote.symbol !== proposal.symbol) throw new Error("Option-only order rejected: quote symbol mismatch");
    if (!Number.isInteger(proposal.quantity) || proposal.quantity < 1) throw new Error("Option quantity must be a positive whole number");
    const fraction = proposal.marketable ? 1 : proposal.side === "buy"
      ? this.#config.execution.entryLimitSpreadFraction
      : this.#config.execution.exitLimitSpreadFraction;
    const limit = limitInsideSpread(
      proposal.quote.bidPrice, proposal.quote.askPrice, proposal.side, fraction, this.#config.execution.optionTickSize,
    );
    return {
      clientOrderId: proposal.clientOrderId,
      symbol: proposal.symbol,
      side: proposal.side,
      requestedQuantity: proposal.quantity,
      filledQuantity: 0,
      averageFillPrice: 0,
      limitPrice: limit,
      status: "PROPOSED",
      submittedAt: proposal.timestamp,
      lastActionAt: proposal.timestamp,
      replacements: 0,
      marketable: proposal.marketable ?? false,
      events: [{ timestamp: proposal.timestamp, status: "PROPOSED", detail: `limit=${limit}` }],
    };
  }

  submit(state: OrderState, timestamp: number): OrderState {
    assertSameDaySpyOptionOrder(state.symbol, state.side, timestamp, this.#config);
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
    if (timestamp - state.submittedAt >= this.#config.execution.cancelAfterMs) {
      if (state.marketable) {
        if (freshQuote && timestamp - state.lastActionAt >= this.#config.execution.replaceAfterMs &&
            timestamp - freshQuote.timestamp <= this.#config.dataQuality.maxOptionQuoteAgeMs) {
          state.replacements += 1;
          state.limitPrice = limitInsideSpread(
            freshQuote.bidPrice, freshQuote.askPrice, state.side, 1, this.#config.execution.optionTickSize,
          );
          return this.#transition(state, "SUBMITTED", timestamp, `marketable replacement ${state.replacements} limit=${state.limitPrice}`);
        }
        return state;
      }
      return this.#transition(state, "CANCEL_PENDING", timestamp, "cancel deadline reached");
    }
    if (timestamp - state.lastActionAt >= this.#config.execution.replaceAfterMs &&
        state.replacements < this.#config.execution.maxReplaces && freshQuote &&
        timestamp - freshQuote.timestamp <= this.#config.dataQuality.maxOptionQuoteAgeMs) {
      state.replacements += 1;
      const initial = state.marketable ? 1 : state.side === "buy"
        ? this.#config.execution.entryLimitSpreadFraction : this.#config.execution.exitLimitSpreadFraction;
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

/**
 * Call after every entry fill, including a partial one. It immediately creates
 * authoritative exposure, reprices stop/target from the actual average fill,
 * and prevents another entry while the remainder is working.
 */
export function reconcileEntryExposure(
  state: OrderState,
  direction: Direction,
  timestamp: number,
  riskManager: RiskManager,
  existing?: PositionState,
): PositionState | undefined {
  if (state.filledQuantity < 1) return existing;
  if (existing && existing.symbol !== state.symbol) throw new Error("Partial fill conflicts with authoritative position");
  return riskManager.createFilledPosition(
    state.symbol, direction, state.filledQuantity, state.averageFillPrice,
    existing?.entryTimestamp ?? timestamp,
  );
}
