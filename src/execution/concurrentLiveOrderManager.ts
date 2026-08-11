import type { EngineConfig } from "../config.js";
import type {
  OptionQuote, OptionSnapshot, PositionState,
} from "../types.js";
import type {
  BrokerOrder, BrokerOrderRequest, BrokerPosition, TradingRestClient,
} from "../alpaca/restClient.js";
import { RiskManager } from "../risk/riskManager.js";
import {
  LiveOrderManager,
  type EntryExecutionRequest,
  type EntryExecutionResult,
  type ExecutionTick,
  type LiveExecutionSnapshot,
  type LiveOrderManagerOptions,
  type TradeLifecycleState,
} from "./liveOrderManager.js";

type PendingSnapshot = NonNullable<LiveExecutionSnapshot["pending"]>;
type ExitIntentSnapshot = NonNullable<LiveExecutionSnapshot["exitIntent"]>;

export interface ConcurrentExecutionTick extends ExecutionTick {
  optionQuotes?: readonly OptionQuote[];
  optionSnapshots?: readonly OptionSnapshot[];
}

export interface ConcurrentLiveExecutionSnapshot extends LiveExecutionSnapshot {
  positions: PositionState[];
  pendingOrders: PendingSnapshot[];
  exitIntents: ExitIntentSnapshot[];
  positionCount: number;
  maxPositions: number;
}

export type ConcurrentLiveOrderManagerOptions = Omit<
  LiveOrderManagerOptions,
  "portfolioReservationId" | "riskManager"
>;

interface PositionSlot {
  id: string;
  client: PositionSlotRestClient;
  manager: LiveOrderManager;
}

/**
 * Coordinates independent one-position lifecycles for a single underlying. A slot is bound to
 * one OCC symbol while exposure exists, which keeps broker reconciliation exact and prevents
 * Alpaca's same-symbol position aggregation from collapsing independent local lifecycles.
 */
export class ConcurrentLiveOrderManager {
  readonly #config: EngineConfig;
  readonly #maxPositions: number;
  readonly #client: TradingRestClient;
  readonly #slots: PositionSlot[];
  #tail: Promise<void> = Promise.resolve();
  #initialized = false;

  constructor(options: ConcurrentLiveOrderManagerOptions) {
    const { restoredPosition, restoredRiskState, ...slotOptions } = options;
    this.#config = options.config;
    this.#client = options.client;
    this.#maxPositions = options.config.risk.maxPositionsPerUnderlying;
    const sharedRisk = new RiskManager(options.config);
    if (restoredRiskState) sharedRisk.restoreState(restoredRiskState);
    this.#slots = Array.from({ length: this.#maxPositions }, (_, index) => {
      const id = `${options.config.symbol}:position:${index + 1}`;
      const client = new PositionSlotRestClient(options.client);
      if (index === 0 && restoredPosition) client.bind(restoredPosition.symbol);
      const manager = new LiveOrderManager({
        ...slotOptions,
        client,
        riskManager: sharedRisk,
        portfolioReservationId: id,
        ...(index === 0 && restoredPosition ? { restoredPosition } : {}),
      });
      return { id, client, manager };
    });
  }

  initialize(timestamp: number): Promise<ConcurrentLiveExecutionSnapshot> {
    return this.#serialize(async () => {
      const [positions, orders] = await Promise.all([
        this.#client.listPositions(),
        this.#client.listOpenOrders(),
      ]);
      const brokerSymbols = [...new Set([
        ...positions.map((position) => position.symbol),
        ...orders.map((order) => order.symbol),
      ])];
      if (brokerSymbols.length > this.#maxPositions) {
        throw new Error(
          `${this.#config.symbol} broker has ${brokerSymbols.length} option positions/orders; maximum is ${this.#maxPositions}`,
        );
      }
      for (const symbol of brokerSymbols) {
        if (this.#slots.some((slot) => slot.client.symbol === symbol)) continue;
        const slot = this.#slots.find((candidate) => candidate.client.symbol === undefined);
        if (!slot) throw new Error(`${this.#config.symbol} has no reconciliation slot for ${symbol}`);
        slot.client.bind(symbol);
      }
      for (const slot of this.#slots) await slot.manager.initialize(timestamp);
      this.#initialized = true;
      return this.snapshot();
    });
  }

  submitEntry(request: EntryExecutionRequest): Promise<EntryExecutionResult> {
    return this.#serialize(async () => {
      this.#assertInitialized();
      const snapshot = this.snapshot();
      if (snapshot.pendingOrders.length > 0) {
        return { submitted: false, reasons: ["ORDER_ALREADY_PENDING"] };
      }
      if (snapshot.positions.some((position) => position.symbol === request.candidate.symbol)) {
        return { submitted: false, reasons: ["POSITION_SYMBOL_ALREADY_OPEN"] };
      }
      if (snapshot.positionCount >= this.#maxPositions) {
        return { submitted: false, reasons: ["MAX_POSITIONS_PER_UNDERLYING"] };
      }
      const slot = this.#slots.find((candidate) => {
        const state = candidate.manager.snapshot();
        return !state.position && !state.pending && !state.exitIntent && !state.halted;
      });
      if (!slot) return { submitted: false, reasons: ["NO_POSITION_SLOT_AVAILABLE"] };
      slot.client.bind(request.candidate.symbol);
      const result = await slot.manager.submitEntry(request);
      this.#releaseFlatSlot(slot);
      return result;
    });
  }

  tick(request: ConcurrentExecutionTick): Promise<ConcurrentLiveExecutionSnapshot> {
    return this.#serialize(async () => {
      this.#assertInitialized();
      const {
        optionQuotes, optionSnapshots, optionQuote: singleQuote,
        optionSnapshot: singleSnapshot, ...tick
      } = request;
      for (const slot of this.#slots) {
        const state = slot.manager.snapshot();
        const symbol = state.position?.symbol ?? state.pending?.order.symbol ?? slot.client.symbol;
        const optionQuote = optionQuotes?.find((quote) => quote.symbol === symbol) ??
          (singleQuote?.symbol === symbol ? singleQuote : undefined);
        const optionSnapshot = optionSnapshots?.find((snapshot) => snapshot.symbol === symbol) ??
          (singleSnapshot?.symbol === symbol ? singleSnapshot : undefined);
        await slot.manager.tick({
          ...tick,
          ...(optionQuote ? { optionQuote } : {}),
          ...(optionSnapshot ? { optionSnapshot } : {}),
        });
        this.#releaseFlatSlot(slot);
      }
      return this.snapshot();
    });
  }

  snapshot(): ConcurrentLiveExecutionSnapshot {
    const states = this.#slots.map((slot) => slot.manager.snapshot());
    const positions = states.flatMap((state) => state.position ? [{ ...state.position }] : []);
    const pendingOrders = states.flatMap((state) => state.pending ? [clonePending(state.pending)] : []);
    const exitIntents = states.flatMap((state) => state.exitIntent ? [{
      ...state.exitIntent,
      triggers: [...state.exitIntent.triggers],
    }] : []);
    const haltedState = states.find((state) => state.halted);
    const safeMode = states.some((state) => state.safeMode);
    const lifecycle = aggregateLifecycle(states.map((state) => state.lifecycle), safeMode);
    return {
      halted: haltedState !== undefined,
      ...(haltedState?.haltReason ? { haltReason: haltedState.haltReason } : {}),
      lifecycle,
      safeMode,
      positions,
      pendingOrders,
      exitIntents,
      positionCount: positions.length,
      maxPositions: this.#maxPositions,
      ...(positions[0] ? { position: { ...positions[0] } } : {}),
      ...(pendingOrders[0] ? { pending: clonePending(pendingOrders[0]) } : {}),
      ...(exitIntents[0] ? { exitIntent: {
        ...exitIntents[0], triggers: [...exitIntents[0].triggers],
      } } : {}),
    };
  }

  #releaseFlatSlot(slot: PositionSlot): void {
    const state = slot.manager.snapshot();
    if (!state.position && !state.pending && !state.exitIntent && !state.halted) slot.client.release();
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error(`${this.#config.symbol} concurrent order manager is not initialized`);
  }

  #serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

class PositionSlotRestClient implements TradingRestClient {
  readonly #client: TradingRestClient;
  #symbol: string | undefined;

  constructor(client: TradingRestClient) { this.#client = client; }
  get symbol(): string | undefined { return this.#symbol; }

  bind(symbol: string): void {
    if (this.#symbol && this.#symbol !== symbol) {
      throw new Error(`Position slot for ${this.#symbol} cannot bind ${symbol}`);
    }
    this.#symbol = symbol;
  }

  release(): void { this.#symbol = undefined; }
  getAccount() { return this.#client.getAccount(); }
  getMarketClock() { return this.#client.getMarketClock(); }
  listOptionContracts(...args: Parameters<TradingRestClient["listOptionContracts"]>) {
    return this.#client.listOptionContracts(...args);
  }
  getOptionSnapshots(symbols: readonly string[]) { return this.#client.getOptionSnapshots(symbols); }
  getLatestOptionQuotes(symbols: readonly string[]) {
    return this.#client.getLatestOptionQuotes?.(symbols) ?? Promise.resolve([]);
  }

  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder> {
    this.bind(request.symbol);
    return this.#assertOrder(await this.#client.submitOrder(request));
  }

  async getOrder(orderId: string): Promise<BrokerOrder> {
    return this.#assertOrder(await this.#client.getOrder(orderId));
  }

  async getOrderByClientOrderId(clientOrderId: string): Promise<BrokerOrder> {
    return this.#assertOrder(await this.#client.getOrderByClientOrderId(clientOrderId));
  }

  async replaceOrder(orderId: string, limitPrice: number): Promise<BrokerOrder> {
    return this.#assertOrder(await this.#client.replaceOrder(orderId, limitPrice));
  }

  cancelOrder(orderId: string): Promise<void> { return this.#client.cancelOrder(orderId); }

  async listOpenOrders(): Promise<BrokerOrder[]> {
    if (!this.#symbol) return [];
    return (await this.#client.listOpenOrders()).filter((order) => order.symbol === this.#symbol);
  }

  async listPositions(): Promise<BrokerPosition[]> {
    if (!this.#symbol) return [];
    return (await this.#client.listPositions()).filter((position) => position.symbol === this.#symbol);
  }

  #assertOrder(order: BrokerOrder): BrokerOrder {
    if (!this.#symbol || order.symbol !== this.#symbol) {
      throw new Error(`Position slot rejected broker order for ${order.symbol}; expected ${this.#symbol ?? "unbound"}`);
    }
    return order;
  }
}

function clonePending(pending: PendingSnapshot): PendingSnapshot {
  return {
    ...pending,
    order: { ...pending.order, events: [...pending.order.events] },
  };
}

function aggregateLifecycle(
  lifecycles: readonly TradeLifecycleState[], safeMode: boolean,
): TradeLifecycleState {
  if (safeMode) return "SAFE_MODE";
  for (const lifecycle of ["EXIT_PENDING", "ENTRY_PENDING", "OPEN_UNPROTECTED",
    "PROTECTED_SOFT", "PROTECTED_WINNER", "PROTECTED_RECOVERED"] as const) {
    if (lifecycles.includes(lifecycle)) return lifecycle;
  }
  return lifecycles.includes("CLOSED") ? "CLOSED" : "FLAT";
}
