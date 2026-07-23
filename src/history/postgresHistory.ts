import { Pool, type QueryResult, type QueryResultRow } from "pg";
import type { AuditEvent, AuditRecorder } from "../ops/recorder.js";
import type { DashboardOrderCard, DashboardOrderDynamicsUpdate } from "../ops/orderCards.js";
import type { FeatureSnapshot } from "../types.js";
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
  quoteSampleIntervalMs?: number;
  retentionDays?: number;
  retentionCleanupIntervalMs?: number;
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

interface StockHistoryRow extends QueryResultRow {
  id: string | number;
  event_type: "stock_quote" | "stock_trade";
  received_timestamp: string | number;
  provider_timestamp: string | number;
  market_date: string | Date;
  symbol: string;
  data: Record<string, unknown>;
}

interface FeatureRow extends QueryResultRow { data: FeatureSnapshot }
interface OrderCardRow extends QueryResultRow { card_id: string; data: DashboardOrderCard }
interface OrderCardUpdateRow extends QueryResultRow {
  card_id: string;
  sequence_index: string | number;
  data: DashboardOrderDynamicsUpdate;
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
CREATE INDEX IF NOT EXISTS market_events_quote_retention_idx
  ON market_events (market_date, id)
  WHERE event_type IN ('stock_quote', 'option_quote');

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

CREATE TABLE IF NOT EXISTS order_lifecycle (
  client_order_id TEXT PRIMARY KEY,
  broker_order_id TEXT,
  purpose TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  requested_quantity INTEGER NOT NULL,
  filled_quantity INTEGER NOT NULL,
  average_fill_price DOUBLE PRECISION,
  limit_price DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL,
  replacements INTEGER NOT NULL,
  exit_reason TEXT,
  first_seen_timestamp BIGINT NOT NULL,
  updated_timestamp BIGINT NOT NULL,
  market_date DATE,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS order_lifecycle_symbol_updated_idx
  ON order_lifecycle (symbol, updated_timestamp DESC);
CREATE INDEX IF NOT EXISTS order_lifecycle_status_updated_idx
  ON order_lifecycle (status, updated_timestamp DESC);

CREATE TABLE IF NOT EXISTS order_lifecycle_events (
  id BIGSERIAL PRIMARY KEY,
  event_timestamp BIGINT NOT NULL,
  market_date DATE,
  event_type TEXT NOT NULL,
  client_order_id TEXT NOT NULL,
  broker_order_id TEXT,
  purpose TEXT NOT NULL,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL,
  filled_quantity INTEGER NOT NULL,
  average_fill_price DOUBLE PRECISION,
  limit_price DOUBLE PRECISION NOT NULL,
  replacements INTEGER NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS order_lifecycle_events_client_timestamp_idx
  ON order_lifecycle_events (client_order_id, event_timestamp, id);
CREATE INDEX IF NOT EXISTS order_lifecycle_events_symbol_timestamp_idx
  ON order_lifecycle_events (symbol, event_timestamp DESC);

CREATE TABLE IF NOT EXISTS order_cards (
  card_id TEXT PRIMARY KEY,
  signal_id TEXT,
  symbol TEXT NOT NULL,
  direction TEXT,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  realized_pnl DOUBLE PRECISION NOT NULL,
  entry_timestamp BIGINT,
  exit_timestamp BIGINT,
  exit_reason TEXT,
  updated_timestamp BIGINT NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS order_cards_updated_idx
  ON order_cards (updated_timestamp DESC);
CREATE INDEX IF NOT EXISTS order_cards_symbol_updated_idx
  ON order_cards (symbol, updated_timestamp DESC);

CREATE TABLE IF NOT EXISTS order_card_updates (
  card_id TEXT NOT NULL REFERENCES order_cards(card_id) ON DELETE CASCADE,
  sequence_index INTEGER NOT NULL,
  event_timestamp BIGINT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  total_pnl DOUBLE PRECISION,
  pnl_change DOUBLE PRECISION,
  data JSONB NOT NULL,
  PRIMARY KEY (card_id, sequence_index)
);
CREATE INDEX IF NOT EXISTS order_card_updates_timestamp_idx
  ON order_card_updates (card_id, event_timestamp, sequence_index);
`;

interface NormalizedOrderLifecycle {
  clientOrderId: string;
  brokerOrderId?: string;
  purpose: "ENTRY" | "EXIT";
  symbol: string;
  side: string;
  requestedQuantity: number;
  filledQuantity: number;
  averageFillPrice?: number;
  limitPrice: number;
  status: string;
  replacements: number;
  exitReason?: string;
  firstSeenTimestamp: number;
}

/** Persistent, batched market history plus synchronous execution audit storage. */
export class PostgresHistoryStore implements HistoryStore, AuditRecorder {
  readonly #client: DatabaseClient;
  readonly #ownsClient: boolean;
  readonly #batchSize: number;
  readonly #flushIntervalMs: number;
  readonly #maxQueuedEvents: number;
  readonly #quoteSampleIntervalMs: number;
  readonly #retentionDays: number;
  readonly #retentionCleanupIntervalMs: number;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #lastPersistedQuoteTimestamp = new Map<string, number>();
  #prioritySymbols = new Set<string>();
  #queue: HistoricalMarketEvent[] = [];
  #flushTimer: ReturnType<typeof setInterval> | undefined;
  #retentionTimer: ReturnType<typeof setInterval> | undefined;
  #retentionRunning = false;
  #retentionTail: Promise<void> = Promise.resolve();
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
    this.#quoteSampleIntervalMs = options.quoteSampleIntervalMs ?? 250;
    this.#retentionDays = options.retentionDays ?? 7;
    this.#retentionCleanupIntervalMs = options.retentionCleanupIntervalMs ?? 60_000;
    this.#onError = options.onError;
  }

  async initialize(): Promise<void> {
    await this.#client.query(SCHEMA_SQL);
    this.#marketHealthy = true;
    this.#auditHealthy = true;
    this.#flushTimer = setInterval(() => {
      void this.flush().catch((error: unknown) => this.#recordError(error, "market"));
    }, this.#flushIntervalMs);
    if (this.#retentionDays > 0) {
      await this.#runRetentionCleanup();
      this.#retentionTimer = setInterval(() => {
        void this.#runRetentionCleanup().catch((error: unknown) => this.#recordError(error, "market"));
      }, this.#retentionCleanupIntervalMs);
    }
  }

  recordMarketEvent(event: HistoricalMarketEvent): void {
    if (this.#closed) throw new Error("Cannot record market history after the database store is closed");
    if (!this.#shouldPersistMarketEvent(event)) return;
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

  setPrioritySymbols(symbols: ReadonlySet<string>): void {
    this.#prioritySymbols = new Set(symbols);
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
      const lifecycle = normalizedOrderLifecycle(event);
      if (lifecycle) await this.#recordOrderLifecycle(event, lifecycle);
      this.#auditHealthy = true;
    } catch (error) {
      this.#recordError(error, "audit");
      throw error;
    }
  }

  async #recordOrderLifecycle(event: AuditEvent, order: NormalizedOrderLifecycle): Promise<void> {
    const values = [
      event.timestamp,
      event.marketDate ?? null,
      event.type,
      order.clientOrderId,
      order.brokerOrderId ?? null,
      order.purpose,
      order.symbol,
      order.status,
      order.filledQuantity,
      order.averageFillPrice ?? null,
      order.limitPrice,
      order.replacements,
      JSON.stringify(event.data),
    ];
    await this.#client.query(
      `INSERT INTO order_lifecycle_events
        (event_timestamp, market_date, event_type, client_order_id, broker_order_id, purpose, symbol,
         status, filled_quantity, average_fill_price, limit_price, replacements, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      values,
    );
    await this.#client.query(
      `INSERT INTO order_lifecycle
        (client_order_id, broker_order_id, purpose, symbol, side, requested_quantity, filled_quantity,
         average_fill_price, limit_price, status, replacements, exit_reason, first_seen_timestamp,
         updated_timestamp, market_date, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
       ON CONFLICT (client_order_id) DO UPDATE SET
         broker_order_id = COALESCE(EXCLUDED.broker_order_id, order_lifecycle.broker_order_id),
         purpose = EXCLUDED.purpose,
         symbol = EXCLUDED.symbol,
         side = EXCLUDED.side,
         requested_quantity = EXCLUDED.requested_quantity,
         filled_quantity = EXCLUDED.filled_quantity,
         average_fill_price = COALESCE(EXCLUDED.average_fill_price, order_lifecycle.average_fill_price),
         limit_price = EXCLUDED.limit_price,
         status = EXCLUDED.status,
         replacements = EXCLUDED.replacements,
         exit_reason = COALESCE(EXCLUDED.exit_reason, order_lifecycle.exit_reason),
         first_seen_timestamp = LEAST(EXCLUDED.first_seen_timestamp, order_lifecycle.first_seen_timestamp),
         updated_timestamp = EXCLUDED.updated_timestamp,
         market_date = COALESCE(EXCLUDED.market_date, order_lifecycle.market_date),
         data = EXCLUDED.data
       WHERE order_lifecycle.updated_timestamp <= EXCLUDED.updated_timestamp`,
      [
        order.clientOrderId,
        order.brokerOrderId ?? null,
        order.purpose,
        order.symbol,
        order.side,
        order.requestedQuantity,
        order.filledQuantity,
        order.averageFillPrice ?? null,
        order.limitPrice,
        order.status,
        order.replacements,
        order.exitReason ?? null,
        order.firstSeenTimestamp,
        event.timestamp,
        event.marketDate ?? null,
        JSON.stringify(event.data),
      ],
    );
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

  async saveOrderCard(card: DashboardOrderCard): Promise<void> {
    const { updates } = card;
    const updatedTimestamp = updates.at(-1)?.timestamp ?? card.exitTimestamp ?? card.entryTimestamp ?? Date.now();
    try {
      await this.#client.query(
        `INSERT INTO order_cards
          (card_id, signal_id, symbol, direction, stage, status, quantity, realized_pnl,
           entry_timestamp, exit_timestamp, exit_reason, updated_timestamp, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
         ON CONFLICT (card_id) DO UPDATE SET
           signal_id = COALESCE(EXCLUDED.signal_id, order_cards.signal_id),
           symbol = EXCLUDED.symbol,
           direction = COALESCE(EXCLUDED.direction, order_cards.direction),
           stage = EXCLUDED.stage,
           status = EXCLUDED.status,
           quantity = EXCLUDED.quantity,
           realized_pnl = EXCLUDED.realized_pnl,
           entry_timestamp = COALESCE(EXCLUDED.entry_timestamp, order_cards.entry_timestamp),
           exit_timestamp = COALESCE(EXCLUDED.exit_timestamp, order_cards.exit_timestamp),
           exit_reason = COALESCE(EXCLUDED.exit_reason, order_cards.exit_reason),
           updated_timestamp = GREATEST(EXCLUDED.updated_timestamp, order_cards.updated_timestamp),
           data = EXCLUDED.data`,
        [
          card.id,
          card.signalId ?? null,
          card.symbol,
          card.direction ?? null,
          card.stage,
          card.status,
          card.quantity,
          card.realizedPnl,
          card.entryTimestamp ?? null,
          card.exitTimestamp ?? null,
          card.exitReason ?? null,
          updatedTimestamp,
          JSON.stringify(card),
        ],
      );
      const chunkSize = 1_000;
      for (let start = 0; start < updates.length; start += chunkSize) {
        const chunk = updates.slice(start, start + chunkSize);
        const values: unknown[] = [];
        const placeholders = chunk.map((update, offset) => {
          const index = start + offset;
          const parameter = offset * 8;
          values.push(
            card.id,
            index,
            update.timestamp,
            update.stage,
            update.status,
            update.totalPnl ?? null,
            update.pnlChange ?? null,
            JSON.stringify(update),
          );
          return `($${parameter + 1},$${parameter + 2},$${parameter + 3},$${parameter + 4},` +
            `$${parameter + 5},$${parameter + 6},$${parameter + 7},$${parameter + 8}::jsonb)`;
        });
        await this.#client.query(
          `INSERT INTO order_card_updates
            (card_id, sequence_index, event_timestamp, stage, status, total_pnl, pnl_change, data)
           VALUES ${placeholders.join(",")}
           ON CONFLICT (card_id, sequence_index) DO UPDATE SET
             event_timestamp = EXCLUDED.event_timestamp,
             stage = EXCLUDED.stage,
             status = EXCLUDED.status,
             total_pnl = EXCLUDED.total_pnl,
             pnl_change = EXCLUDED.pnl_change,
             data = EXCLUDED.data`,
          values,
        );
      }
      this.#auditHealthy = true;
    } catch (error) {
      this.#recordError(error, "audit");
      throw error;
    }
  }

  async loadOrderCards(limit = 250): Promise<DashboardOrderCard[]> {
    const boundedLimit = Math.max(1, Math.min(2_000, Math.floor(limit)));
    const cards = await this.#client.query<OrderCardRow>(
      `SELECT card_id, data
       FROM order_cards
       ORDER BY updated_timestamp DESC
       LIMIT $1`,
      [boundedLimit],
    );
    if (cards.rows.length === 0) return [];
    const ids = cards.rows.map((row) => row.card_id);
    const updates = await this.#client.query<OrderCardUpdateRow>(
      `SELECT card_id, sequence_index, data
       FROM order_card_updates
       WHERE card_id = ANY($1::text[])
       ORDER BY card_id, sequence_index`,
      [ids],
    );
    const updatesByCard = new Map<string, DashboardOrderDynamicsUpdate[]>();
    for (const row of updates.rows) {
      const list = updatesByCard.get(row.card_id) ?? [];
      list.push(row.data);
      updatesByCard.set(row.card_id, list);
    }
    return cards.rows.map((row) => ({
      ...row.data,
      id: row.card_id,
      updates: updatesByCard.get(row.card_id) ?? row.data.updates ?? [],
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

  async *streamStockEvents(
    marketDate: string,
    startReceivedTimestamp: number,
    endReceivedTimestamp: number,
    quoteStartReceivedTimestamp?: number,
    batchSize = 20_000,
  ): AsyncIterable<readonly HistoricalMarketEvent[]> {
    if (!(endReceivedTimestamp >= startReceivedTimestamp)) return;
    const boundedBatchSize = Math.max(100, Math.min(50_000, Math.floor(batchSize)));
    let afterId = 0;
    while (true) {
      const quoteFilter = quoteStartReceivedTimestamp === undefined
        ? "" : "AND (event_type = 'stock_trade' OR received_timestamp >= $6)";
      const result = await this.#client.query<StockHistoryRow>(
        `SELECT id, event_type, received_timestamp, provider_timestamp, market_date, symbol, data
         FROM market_events
         WHERE market_date = $1
           AND event_type IN ('stock_quote','stock_trade')
           AND received_timestamp >= $2
           AND received_timestamp <= $3
           AND id > $4
           ${quoteFilter}
         ORDER BY id ASC
         LIMIT $5`,
        [marketDate, startReceivedTimestamp, endReceivedTimestamp, afterId, boundedBatchSize,
          ...(quoteStartReceivedTimestamp !== undefined ? [quoteStartReceivedTimestamp] : [])],
      );
      if (result.rows.length === 0) return;
      const events = result.rows.map((row) => {
        afterId = Number(row.id);
        return {
          type: row.event_type,
          providerTimestamp: Number(row.provider_timestamp),
          receivedTimestamp: Number(row.received_timestamp),
          marketDate: formatDatabaseDate(row.market_date),
          symbol: row.symbol,
          data: row.data,
        } satisfies HistoricalMarketEvent;
      });
      yield events;
      if (result.rows.length < boundedBatchSize) return;
    }
  }

  async loadLatestRecoveredFeature(marketDate: string): Promise<FeatureSnapshot | undefined> {
    const result = await this.#client.query<FeatureRow>(
      `WITH recovery AS (
         SELECT MAX(event_timestamp) AS recovered_at
         FROM audit_events
         WHERE market_date = $1
           AND event_type = 'strategy_state_recovery'
           AND data->>'ready' = 'true'
       )
       SELECT market_events.data
       FROM market_events CROSS JOIN recovery
       WHERE market_events.market_date = $1
         AND market_events.event_type = 'feature_snapshot'
         AND recovery.recovered_at IS NOT NULL
         AND market_events.received_timestamp >= recovery.recovered_at
       ORDER BY market_events.id DESC
       LIMIT 1`,
      [marketDate],
    );
    return result.rows[0]?.data;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#flushTimer) clearInterval(this.#flushTimer);
    if (this.#retentionTimer) clearInterval(this.#retentionTimer);
    this.#flushTimer = undefined;
    this.#retentionTimer = undefined;
    await this.#retentionTail;
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

  #shouldPersistMarketEvent(event: HistoricalMarketEvent): boolean {
    if (event.type !== "stock_quote" && event.type !== "option_quote") return true;
    const key = `${event.type}:${event.symbol}`;
    const previous = this.#lastPersistedQuoteTimestamp.get(key);
    if (this.#quoteSampleIntervalMs === 0 || this.#prioritySymbols.has(event.symbol) || previous === undefined ||
        event.providerTimestamp - previous >= this.#quoteSampleIntervalMs) {
      this.#lastPersistedQuoteTimestamp.set(key, Math.max(previous ?? -Infinity, event.providerTimestamp));
      return true;
    }
    return false;
  }

  async #cleanupExpiredQuotes(): Promise<void> {
    await this.#client.query(
      `WITH latest AS (
         SELECT max(market_date) AS market_date FROM market_events
       ), expired AS (
         SELECT id FROM market_events, latest
         WHERE latest.market_date IS NOT NULL
           AND market_events.market_date < latest.market_date - $1::integer
           AND event_type IN ('stock_quote', 'option_quote')
         ORDER BY id ASC
         LIMIT 100000
       )
       DELETE FROM market_events USING expired
       WHERE market_events.id = expired.id`,
      [this.#retentionDays],
    );
  }

  #runRetentionCleanup(): Promise<void> {
    if (this.#retentionRunning) return this.#retentionTail;
    this.#retentionRunning = true;
    const cleanup = this.#cleanupExpiredQuotes();
    this.#retentionTail = cleanup
      .catch(() => undefined)
      .finally(() => { this.#retentionRunning = false; });
    return cleanup;
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

function normalizedOrderLifecycle(event: AuditEvent): NormalizedOrderLifecycle | undefined {
  if (!["broker_order_request", "broker_order_state", "broker_order_replaced"].includes(event.type)) return undefined;
  const local = event.type === "broker_order_request"
    ? objectValue(event.data.order) : objectValue(event.data.localOrder);
  const broker = event.type === "broker_order_state"
    ? objectValue(event.data.broker) : event.type === "broker_order_replaced"
      ? objectValue(event.data.replacement) : {};
  const clientOrderId = textValue(local.clientOrderId) ?? textValue(broker.clientOrderId);
  if (!clientOrderId) return undefined;
  const averageFillPrice = finiteNumber(broker.averageFillPrice) ?? finiteNumber(local.averageFillPrice);
  const brokerOrderId = textValue(broker.id);
  const exitReason = textValue(event.data.reason);
  return {
    clientOrderId,
    ...(brokerOrderId ? { brokerOrderId } : {}),
    purpose: event.data.purpose === "EXIT" ? "EXIT" : "ENTRY",
    symbol: textValue(local.symbol) ?? textValue(broker.symbol) ?? "UNKNOWN",
    side: textValue(local.side) ?? "UNKNOWN",
    requestedQuantity: finiteNumber(local.requestedQuantity) ?? 0,
    filledQuantity: finiteNumber(broker.filledQuantity) ?? finiteNumber(local.filledQuantity) ?? 0,
    ...(averageFillPrice !== undefined && averageFillPrice > 0 ? { averageFillPrice } : {}),
    limitPrice: finiteNumber(local.limitPrice) ?? 0,
    status: textValue(broker.status) ?? textValue(local.status) ?? "UNKNOWN",
    replacements: finiteNumber(local.replacements) ?? 0,
    ...(exitReason ? { exitReason } : {}),
    firstSeenTimestamp: finiteNumber(local.submittedAt) ?? event.timestamp,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
