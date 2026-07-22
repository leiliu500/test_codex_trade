import { Pool, type QueryResult, type QueryResultRow } from "pg";
import type { AuditEvent, AuditRecorder } from "../ops/recorder.js";
import type { HistoricalMarketEvent, HistoryStore } from "./types.js";

export interface DatabaseClient {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
  end?(): Promise<void>;
}

export interface PostgresHistoryStoreOptions {
  connectionString: string;
  client?: DatabaseClient;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueuedEvents?: number;
  onError?: (error: unknown) => void;
}

interface AuditRow extends QueryResultRow {
  event_timestamp: string | number;
  market_date: string | Date | null;
  event_type: string;
  config_version: string;
  calibration_version: string | null;
  data: Record<string, unknown>;
}

interface ReplayRow extends QueryResultRow {
  event_type: "stock_quote" | "stock_trade" | "option_contract" | "option_quote" | "option_snapshot";
  received_timestamp: string | number;
  data: Record<string, unknown>;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS market_events (
  id BIGSERIAL PRIMARY KEY,
  received_timestamp BIGINT NOT NULL,
  provider_timestamp BIGINT NOT NULL,
  market_date DATE NOT NULL,
  event_type TEXT NOT NULL,
  symbol TEXT NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS market_events_date_type_id_idx
  ON market_events (market_date, event_type, id);
CREATE INDEX IF NOT EXISTS market_events_symbol_provider_idx
  ON market_events (symbol, provider_timestamp);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  event_timestamp BIGINT NOT NULL,
  market_date DATE,
  event_type TEXT NOT NULL,
  config_version TEXT NOT NULL,
  calibration_version TEXT,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_date_type_id_idx
  ON audit_events (market_date, event_type, id);
CREATE INDEX IF NOT EXISTS audit_events_timestamp_idx
  ON audit_events (event_timestamp, id);
`;

/** Persistent, batched market history plus synchronous execution audit storage. */
export class PostgresHistoryStore implements HistoryStore, AuditRecorder {
  readonly #client: DatabaseClient;
  readonly #ownsClient: boolean;
  readonly #batchSize: number;
  readonly #flushIntervalMs: number;
  readonly #maxQueuedEvents: number;
  readonly #onError: ((error: unknown) => void) | undefined;
  #queue: HistoricalMarketEvent[] = [];
  #flushTimer: ReturnType<typeof setInterval> | undefined;
  #flushTail: Promise<void> = Promise.resolve();
  #marketHealthy = false;
  #auditHealthy = false;
  #closed = false;

  constructor(options: PostgresHistoryStoreOptions) {
    this.#client = options.client ?? new Pool({ connectionString: options.connectionString, max: 8 });
    this.#ownsClient = options.client === undefined;
    this.#batchSize = options.batchSize ?? 500;
    this.#flushIntervalMs = options.flushIntervalMs ?? 250;
    this.#maxQueuedEvents = options.maxQueuedEvents ?? 250_000;
    this.#onError = options.onError;
  }

  async initialize(): Promise<void> {
    await this.#client.query(SCHEMA_SQL);
    this.#marketHealthy = true;
    this.#auditHealthy = true;
    this.#flushTimer = setInterval(() => {
      void this.flush().catch((error: unknown) => this.#recordError(error, "market"));
    }, this.#flushIntervalMs);
  }

  recordMarketEvent(event: HistoricalMarketEvent): void {
    if (this.#closed) throw new Error("Cannot record market history after the database store is closed");
    if (this.#queue.length >= this.#maxQueuedEvents) {
      const error = new Error(`Market history queue exceeded ${this.#maxQueuedEvents} events`);
      this.#recordError(error, "market");
      throw error;
    }
    this.#queue.push(event);
    if (this.#queue.length >= this.#batchSize) {
      void this.flush().catch((error: unknown) => this.#recordError(error, "market"));
    }
  }

  async record(event: AuditEvent): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO audit_events
          (event_timestamp, market_date, event_type, config_version, calibration_version, data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [event.timestamp, event.marketDate ?? null, event.type, event.configVersion,
          event.calibrationVersion ?? null, JSON.stringify(event.data)],
      );
      this.#auditHealthy = true;
    } catch (error) {
      this.#recordError(error, "audit");
      throw error;
    }
  }

  healthy(): boolean { return this.#marketHealthy && this.#auditHealthy && !this.#closed; }

  flush(): Promise<void> {
    const result = this.#flushTail.then(() => this.#flushNextBatch());
    this.#flushTail = result.catch(() => undefined);
    return result;
  }

  async loadAuditEvents(limit = 50_000): Promise<AuditEvent[]> {
    const boundedLimit = Math.max(1, Math.min(250_000, Math.floor(limit)));
    const result = await this.#client.query<AuditRow>(
      `SELECT event_timestamp, market_date, event_type, config_version, calibration_version, data
       FROM (
         SELECT id, event_timestamp, market_date, event_type, config_version, calibration_version, data
         FROM audit_events ORDER BY id DESC LIMIT $1
       ) recent ORDER BY id ASC`,
      [boundedLimit],
    );
    return result.rows.map((row) => ({
      timestamp: Number(row.event_timestamp),
      ...(row.market_date ? { marketDate: formatDatabaseDate(row.market_date) } : {}),
      type: row.event_type,
      configVersion: row.config_version,
      ...(row.calibration_version ? { calibrationVersion: row.calibration_version } : {}),
      data: row.data,
    }));
  }

  async loadReplayEvents(marketDate: string): Promise<Array<{
    type: ReplayRow["event_type"];
    timestamp: number;
    data: Record<string, unknown>;
  }>> {
    const result = await this.#client.query<ReplayRow>(
      `SELECT event_type, received_timestamp, data
       FROM market_events
       WHERE market_date = $1
         AND event_type IN ('stock_quote','stock_trade','option_contract','option_quote','option_snapshot')
       ORDER BY id ASC`,
      [marketDate],
    );
    return result.rows.map((row) => ({
      type: row.event_type,
      timestamp: Number(row.received_timestamp),
      data: row.data,
    }));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#flushTimer) clearInterval(this.#flushTimer);
    this.#flushTimer = undefined;
    while (this.#queue.length > 0) await this.flush();
    await this.#flushTail;
    this.#closed = true;
    this.#marketHealthy = false;
    this.#auditHealthy = false;
    if (this.#ownsClient) await this.#client.end?.();
  }

  async #flushNextBatch(): Promise<void> {
    if (this.#queue.length === 0) return;
    const batch = this.#queue.splice(0, this.#batchSize);
    const values: unknown[] = [];
    const placeholders = batch.map((event, index) => {
      const offset = index * 6;
      values.push(
        event.receivedTimestamp,
        event.providerTimestamp,
        event.marketDate,
        event.type,
        event.symbol,
        JSON.stringify(event.data),
      );
      return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6}::jsonb)`;
    });
    try {
      await this.#client.query(
        `INSERT INTO market_events
          (received_timestamp, provider_timestamp, market_date, event_type, symbol, data)
         VALUES ${placeholders.join(",")}`,
        values,
      );
      this.#marketHealthy = true;
    } catch (error) {
      this.#queue = batch.concat(this.#queue);
      this.#recordError(error, "market");
      throw error;
    }
  }

  #recordError(error: unknown, channel: "market" | "audit"): void {
    if (channel === "market") this.#marketHealthy = false;
    else this.#auditHealthy = false;
    this.#onError?.(error);
  }
}

function formatDatabaseDate(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}
