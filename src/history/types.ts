import type { AuditEvent } from "../ops/recorder.js";
import type { DashboardOrderCard, OrderCardPersistence } from "../ops/orderCards.js";
import type { FeatureSnapshot } from "../types.js";

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

  setPrioritySymbols(symbols: ReadonlySet<string>): void {
    for (const sink of this.#sinks) sink.setPrioritySymbols?.(symbols);
  }

  healthy(): boolean { return this.#sinks.every((sink) => sink.healthy()); }
}

export interface HistoryStore extends MarketHistorySink, OrderCardPersistence {
  initialize(): Promise<void>;
  record(event: AuditEvent): void | Promise<void>;
  loadAuditEvents(limit?: number): Promise<AuditEvent[]>;
  loadOrderCards(limit?: number): Promise<DashboardOrderCard[]>;
  loadReplayEvents(marketDate: string): Promise<Array<{
    type: Exclude<HistoricalMarketEventType, "feature_snapshot">;
    timestamp: number;
    data: Record<string, unknown>;
  }>>;
  streamStockEvents(
    marketDate: string, startReceivedTimestamp: number, endReceivedTimestamp: number,
    quoteStartReceivedTimestamp?: number,
  ): AsyncIterable<readonly HistoricalMarketEvent[]>;
  loadLatestRecoveredFeature(marketDate: string): Promise<FeatureSnapshot | undefined>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
