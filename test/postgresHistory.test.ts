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
  await store.record({
    timestamp: 15, marketDate: "2026-07-22", type: "broker_order_request", configVersion: "test",
    data: {
      purpose: "ENTRY",
      order: {
        clientOrderId: "entry-1", symbol: "SPY260722C00500000", side: "buy",
        requestedQuantity: 2, filledQuantity: 0, averageFillPrice: 0, limitPrice: 2.01,
        status: "SUBMITTED", submittedAt: 15, replacements: 0,
      },
    },
  });
  assert.ok(client.queries.some((query) => query.text.includes("CREATE TABLE IF NOT EXISTS market_events")));
  assert.ok(client.queries.some((query) => query.text.includes("CREATE TABLE IF NOT EXISTS order_lifecycle_events")));
  const marketInsert = client.queries.find((query) => query.text.includes("INSERT INTO market_events"));
  assert.equal(marketInsert?.values.length, 12);
  assert.ok(client.queries.some((query) => query.text.includes("INSERT INTO audit_events")));
  const lifecycleEvent = client.queries.find((query) => query.text.includes("INSERT INTO order_lifecycle_events"));
  assert.equal(lifecycleEvent?.values[3], "entry-1");
  assert.equal(lifecycleEvent?.values[5], "ENTRY");
  const lifecycleCurrent = client.queries.find((query) => query.text.includes("INSERT INTO order_lifecycle\n"));
  assert.equal(lifecycleCurrent?.values[0], "entry-1");
  assert.equal(lifecycleCurrent?.values[9], "SUBMITTED");
  assert.equal(store.healthy(), true);
  await store.close();
});
