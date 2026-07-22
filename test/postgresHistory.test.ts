import test from "node:test";
import assert from "node:assert/strict";
import type { QueryResult, QueryResultRow } from "pg";
import { PostgresHistoryStore, type DatabaseClient } from "../src/history/postgresHistory.js";

class FakeDatabaseClient implements DatabaseClient {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];
  async query<R extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<R>> {
    this.queries.push({ text, values });
    return { command: "", rowCount: 0, oid: 0, fields: [], rows: [] } as QueryResult<R>;
  }
}

test("PostgreSQL history creates schema, batches market data, and durably inserts audit events", async () => {
  const client = new FakeDatabaseClient();
  const store = new PostgresHistoryStore({
    connectionString: "postgresql://unused", client, batchSize: 2, flushIntervalMs: 60_000,
  });
  await store.initialize();
  store.recordMarketEvent({
    type: "stock_quote", providerTimestamp: 10, receivedTimestamp: 11, marketDate: "2026-07-22",
    symbol: "SPY", data: { symbol: "SPY", bidPrice: 500, askPrice: 500.01 },
  });
  store.recordMarketEvent({
    type: "option_quote", providerTimestamp: 12, receivedTimestamp: 13, marketDate: "2026-07-22",
    symbol: "SPY260722C00500000", data: { bidPrice: 2, askPrice: 2.01 },
  });
  await store.flush();
  await store.record({
    timestamp: 14, marketDate: "2026-07-22", type: "entry_fill", configVersion: "test", data: { quantity: 1 },
  });
  assert.ok(client.queries.some((query) => query.text.includes("CREATE TABLE IF NOT EXISTS market_events")));
  const marketInsert = client.queries.find((query) => query.text.includes("INSERT INTO market_events"));
  assert.equal(marketInsert?.values.length, 12);
  assert.ok(client.queries.some((query) => query.text.includes("INSERT INTO audit_events")));
  assert.equal(store.healthy(), true);
  await store.close();
});
