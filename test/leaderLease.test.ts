import test from "node:test";
import assert from "node:assert/strict";
import {
  PostgresLeaderLease,
  type LeaderLockClient,
} from "../src/ops/leaderLease.js";

test("PostgreSQL advisory lease acquires, heartbeats, and explicitly releases leadership", async () => {
  const client = new FakeLeaderClient(true);
  const lease = new PostgresLeaderLease({
    connectionString: "postgresql://unused",
    lockKey: "test-engine",
    heartbeatMs: 60_000,
    clientFactory: () => client,
  });
  assert.equal(await lease.acquire(), true);
  assert.equal(lease.active, true);
  await lease.release();
  assert.equal(lease.active, false);
  assert.ok(client.queries.some((query) => query.includes("pg_try_advisory_lock")));
  assert.ok(client.queries.some((query) => query.includes("pg_advisory_unlock")));
  assert.equal(client.endCalls, 1);
});

test("PostgreSQL advisory lease refuses a second active engine and reports session loss", async () => {
  const deniedClient = new FakeLeaderClient(false);
  const denied = new PostgresLeaderLease({
    connectionString: "postgresql://unused",
    lockKey: "test-engine",
    clientFactory: () => deniedClient,
  });
  assert.equal(await denied.acquire(), false);
  assert.equal(denied.active, false);

  const activeClient = new FakeLeaderClient(true);
  const losses: string[] = [];
  const active = new PostgresLeaderLease({
    connectionString: "postgresql://unused",
    lockKey: "test-engine",
    heartbeatMs: 60_000,
    clientFactory: () => activeClient,
    onLost: (error) => losses.push(error.message),
  });
  assert.equal(await active.acquire(), true);
  activeClient.emit("error", new Error("database link lost"));
  assert.equal(active.active, false);
  assert.deepEqual(losses, ["database link lost"]);
  await active.release();
});

class FakeLeaderClient implements LeaderLockClient {
  readonly queries: string[] = [];
  readonly #acquired: boolean;
  readonly #listeners = new Map<string, Array<(error?: Error) => void>>();
  endCalls = 0;

  constructor(acquired: boolean) { this.#acquired = acquired; }
  async connect(): Promise<void> {}
  async query<T extends Record<string, unknown> = Record<string, unknown>>(text: string): Promise<{ rows: T[] }> {
    this.queries.push(text);
    const rows = text.includes("pg_try_advisory_lock") ? [{ acquired: this.#acquired }] : [];
    return { rows: rows as unknown as T[] };
  }
  async end(): Promise<void> { this.endCalls += 1; }
  on(event: "error" | "end", listener: (error?: Error) => void): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }
  emit(event: "error" | "end", error?: Error): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(error);
  }
}
