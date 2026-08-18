import type { AuditEvent } from "../ops/recorder.js";
import type {
  DashboardOrderCard,
  DashboardOrderQuote,
  OrderCardPersistence,
} from "../ops/orderCards.js";
import type { FeatureSnapshot, UnderlyingSymbol } from "../types.js";

export type HistoricalMarketEventType =
  | "stock_quote"
  | "stock_trade"
  | "option_contract"
  | "option_quote"
  | "option_snapshot"
  | "feature_snapshot";

export interface HistoricalMarketEvent {
  type: HistoricalMarketEventType;
  providerTimestamp: number;
  receivedTimestamp: number;
  marketDate: string;
  symbol: string;
  data: Record<string, unknown>;
}

export interface MarketHistorySink {
  recordMarketEvent(event: HistoricalMarketEvent): void;
  recordMarketEvents?(events: readonly HistoricalMarketEvent[]): void;
  setPrioritySymbols?(symbols: ReadonlySet<string>): void;
  healthy(): boolean;
}

/** Fan-out sink used to feed both durable history and live read models. */
export class CompositeMarketHistorySink implements MarketHistorySink {
  readonly #sinks: readonly MarketHistorySink[];

  constructor(sinks: readonly MarketHistorySink[]) { this.#sinks = sinks; }

  recordMarketEvent(event: HistoricalMarketEvent): void {
    for (const sink of this.#sinks) sink.recordMarketEvent(event);
  }

  recordMarketEvents(events: readonly HistoricalMarketEvent[]): void {
    for (const sink of this.#sinks) {
      if (sink.recordMarketEvents) sink.recordMarketEvents(events);
      else for (const event of events) sink.recordMarketEvent(event);
    }
  }

  setPrioritySymbols(symbols: ReadonlySet<string>): void {
    for (const sink of this.#sinks) sink.setPrioritySymbols?.(symbols);
  }

  healthy(): boolean { return this.#sinks.every((sink) => sink.healthy()); }
}

/** Unions per-runtime priority sets so one symbol cannot de-prioritize another's open option. */
export class SharedPriorityMarketHistoryHub {
  readonly #sink: MarketHistorySink;
  readonly #priorities = new Map<UnderlyingSymbol, Set<string>>();

  constructor(sink: MarketHistorySink, underlyings: readonly UnderlyingSymbol[]) {
    this.#sink = sink;
    for (const underlying of underlyings) this.#priorities.set(underlying, new Set());
  }

  channel(underlying: UnderlyingSymbol): MarketHistorySink {
    if (!this.#priorities.has(underlying)) throw new Error(`${underlying} has no market-history channel`);
    return {
      recordMarketEvent: (event) => this.#sink.recordMarketEvent(event),
      ...(this.#sink.recordMarketEvents
        ? { recordMarketEvents: (events: readonly HistoricalMarketEvent[]) => this.#sink.recordMarketEvents!(events) }
        : {}),
      setPrioritySymbols: (symbols) => {
        this.#priorities.set(underlying, new Set(symbols));
        const union = new Set<string>();
        for (const values of this.#priorities.values()) for (const symbol of values) union.add(symbol);
        this.#sink.setPrioritySymbols?.(union);
      },
      healthy: () => this.#sink.healthy(),
    };
  }
}

export interface HistoryStore extends MarketHistorySink, OrderCardPersistence {
  initialize(): Promise<void>;
  record(event: AuditEvent): void | Promise<void>;
  loadAuditEvents(limit?: number, preserveMarketDate?: string): Promise<AuditEvent[]>;
  loadOrderCards(limit?: number): Promise<DashboardOrderCard[]>;
  loadOrderCardQuotes(cards: readonly DashboardOrderCard[]): Promise<Map<string, DashboardOrderQuote[]>>;
  loadReplayEvents(marketDate: string, underlying?: UnderlyingSymbol): Promise<Array<{
    type: Exclude<HistoricalMarketEventType, "feature_snapshot">;
    timestamp: number;
    data: Record<string, unknown>;
  }>>;
  streamStockEvents(
    marketDate: string, startReceivedTimestamp: number, endReceivedTimestamp: number,
    quoteStartReceivedTimestamp?: number,
  ): AsyncIterable<readonly HistoricalMarketEvent[]>;
  loadLatestRecoveredFeature(
    marketDate: string, underlying?: UnderlyingSymbol,
  ): Promise<FeatureSnapshot | undefined>;
  clearAllData(): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
