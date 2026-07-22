import type { AuditEvent } from "../ops/recorder.js";

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
  healthy(): boolean;
}

export interface HistoryStore extends MarketHistorySink {
  initialize(): Promise<void>;
  record(event: AuditEvent): void | Promise<void>;
  loadAuditEvents(limit?: number): Promise<AuditEvent[]>;
  loadReplayEvents(marketDate: string): Promise<Array<{
    type: Exclude<HistoricalMarketEventType, "feature_snapshot">;
    timestamp: number;
    data: Record<string, unknown>;
  }>>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
