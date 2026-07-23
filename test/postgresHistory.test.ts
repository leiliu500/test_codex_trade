import test from "node:test";
import assert from "node:assert/strict";
import type { QueryResult, QueryResultRow } from "pg";
import { PostgresHistoryStore, type DatabaseClient } from "../src/history/postgresHistory.js";
import type { DashboardOrderCard } from "../src/ops/orderCards.js";

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
  assert.ok(client.queries.some((query) => query.text.includes("CREATE TABLE IF NOT EXISTS order_card_updates")));
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

test("PostgreSQL history saves completed order cards with their full dynamics list", async () => {
  const client = new FakeDatabaseClient();
  const store = new PostgresHistoryStore({
    connectionString: "postgresql://unused", client, retentionDays: 0,
  });
  await store.initialize();
  const card: DashboardOrderCard = {
    id: "entry-1",
    signalId: "signal-1",
    symbol: "SPY260722C00500000",
    direction: "BULLISH",
    active: false,
    stage: "CLOSED",
    status: "filled",
    quantity: 1,
    remainingQuantity: 0,
    entryPrice: 2,
    exitPrice: 2.2,
    realizedPnl: 20,
    unrealizedPnl: 0,
    totalPnl: 20,
    entryTimestamp: 1_000,
    exitTimestamp: 2_000,
    exitReason: "PROFIT_TARGET",
    updates: [{
      timestamp: 1_100, stage: "POSITION_OPEN", status: "OPEN", remainingQuantity: 1,
      realizedPnl: 0, currentBid: 2.1, unrealizedPnl: 10, totalPnl: 10,
    }, {
      timestamp: 2_000, stage: "CLOSED", status: "filled", remainingQuantity: 0,
      realizedPnl: 20, unrealizedPnl: 0, totalPnl: 20, pnlChange: 10,
    }],
  };

  await store.saveOrderCard(card);

  const summary = client.queries.find((query) => query.text.includes("INSERT INTO order_cards\n"));
  assert.equal(summary?.values[0], "entry-1");
  assert.equal(summary?.values[4], "CLOSED");
  assert.equal(summary?.values[7], 20);
  assert.match(String(summary?.values[12]), /"updates":\[/);
  const dynamics = client.queries.find((query) => query.text.includes("INSERT INTO order_card_updates"));
  assert.equal(dynamics?.values.length, 16);
  assert.equal(dynamics?.values[0], "entry-1");
  assert.equal(dynamics?.values[8], "entry-1");
  assert.match(String(dynamics?.values[15]), /"pnlChange":10/);
  await store.close();
});

test("PostgreSQL history restores completed cards and ordered dynamics for dashboard review", async () => {
  const client: DatabaseClient = {
    async query<R extends QueryResultRow = QueryResultRow>(text: string) {
      const rows = text.includes("FROM order_cards")
        ? [{
          card_id: "entry-1",
          data: {
            id: "entry-1", symbol: "SPY260722C00500000", active: false, stage: "CLOSED",
            status: "filled", quantity: 1, remainingQuantity: 0, realizedPnl: 20, updates: [],
          },
        }]
        : text.includes("FROM order_card_updates")
          ? [{
            card_id: "entry-1", sequence_index: 0,
            data: {
              timestamp: 2_000, stage: "CLOSED", status: "filled",
              remainingQuantity: 0, realizedPnl: 20, totalPnl: 20,
            },
          }]
          : [];
      return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows: rows as unknown as R[] };
    },
  };
  const store = new PostgresHistoryStore({ connectionString: "postgresql://unused", client });
  const cards = await store.loadOrderCards();

  assert.equal(cards[0]?.id, "entry-1");
  assert.equal(cards[0]?.updates[0]?.stage, "CLOSED");
  assert.equal(cards[0]?.updates[0]?.totalPnl, 20);
});

test("PostgreSQL history samples quote baselines but preserves priority option quotes at full resolution", async () => {
  const client = new FakeDatabaseClient();
  const store = new PostgresHistoryStore({
    connectionString: "postgresql://unused", client, batchSize: 100, flushIntervalMs: 60_000,
    quoteSampleIntervalMs: 250, retentionDays: 0,
  });
  await store.initialize();
  const quote = (providerTimestamp: number) => ({
    type: "option_quote" as const,
    providerTimestamp,
    receivedTimestamp: providerTimestamp + 1,
    marketDate: "2026-07-22",
    symbol: "SPY260722C00500000",
    data: { bidPrice: 2, askPrice: 2.01 },
  });
  store.recordMarketEvent(quote(1_000));
  store.recordMarketEvent(quote(1_100));
  store.recordMarketEvent(quote(1_249));
  store.recordMarketEvent(quote(1_250));
  store.setPrioritySymbols(new Set(["SPY260722C00500000"]));
  store.recordMarketEvent(quote(1_251));
  store.recordMarketEvent(quote(1_252));
  store.setPrioritySymbols(new Set());
  store.recordMarketEvent(quote(1_300));
  store.recordMarketEvent({
    type: "stock_trade", providerTimestamp: 1_301, receivedTimestamp: 1_302, marketDate: "2026-07-22",
    symbol: "SPY", data: { price: 500, size: 10 },
  });
  await store.flush();

  const marketInsert = client.queries.find((query) => query.text.includes("INSERT INTO market_events"));
  assert.equal(marketInsert?.values.length, 30);
  assert.deepEqual(
    marketInsert?.values.filter((_value, index) => index % 6 === 1),
    [1_000, 1_250, 1_251, 1_252, 1_301],
  );
  await store.close();
});

test("PostgreSQL history applies bounded age cleanup only when retention is enabled", async () => {
  const enabledClient = new FakeDatabaseClient();
  const enabled = new PostgresHistoryStore({
    connectionString: "postgresql://unused", client: enabledClient, retentionDays: 7,
    retentionCleanupIntervalMs: 60_000,
  });
  await enabled.initialize();
  const cleanup = enabledClient.queries.find((query) => query.text.includes("DELETE FROM market_events"));
  assert.deepEqual(cleanup?.values, [7]);
  assert.match(cleanup?.text ?? "", /LIMIT 100000/);
  await enabled.close();

  const disabledClient = new FakeDatabaseClient();
  const disabled = new PostgresHistoryStore({
    connectionString: "postgresql://unused", client: disabledClient, retentionDays: 0,
  });
  await disabled.initialize();
  assert.equal(disabledClient.queries.some((query) => query.text.includes("DELETE FROM market_events")), false);
  await disabled.close();
});

test("PostgreSQL history streams current-session SIP events in bounded pages", async () => {
  let page = 0;
  const rows = Array.from({ length: 101 }, (_unused, index) => ({
    id: index + 1,
    event_type: index % 2 === 0 ? "stock_quote" : "stock_trade",
    received_timestamp: 1_000 + index,
    provider_timestamp: 900 + index,
    market_date: "2026-07-22",
    symbol: "SPY",
    data: index % 2 === 0
      ? { symbol: "SPY", timestamp: 900 + index, bidPrice: 500, askPrice: 500.01, bidSize: 1, askSize: 1 }
      : { symbol: "SPY", timestamp: 900 + index, price: 500, size: 1 },
  }));
  const client: DatabaseClient = {
    async query<R extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []) {
      assert.match(text, /received_timestamp >= \$2/);
      assert.deepEqual(values.slice(0, 3), ["2026-07-22", 1_000, 2_000]);
      const resultRows = page++ === 0 ? rows.slice(0, 100) : rows.slice(100);
      return { command: "SELECT", rowCount: resultRows.length, oid: 0, fields: [], rows: resultRows as unknown as R[] };
    },
  };
  const store = new PostgresHistoryStore({ connectionString: "postgresql://unused", client });
  const streamed = [];
  for await (const batch of store.streamStockEvents("2026-07-22", 1_000, 2_000, undefined, 100)) streamed.push(...batch);
  assert.equal(streamed.length, 101);
  assert.equal(page, 2);
  assert.equal(streamed[0]?.providerTimestamp, 900);
  assert.equal(streamed.at(-1)?.type, "stock_quote");
});
