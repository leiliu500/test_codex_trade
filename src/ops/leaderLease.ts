import { Client } from "pg";
import { createHash } from "node:crypto";

export interface LeaderLockClient {
  connect(): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
  on(event: "error" | "end", listener: (error?: Error) => void): this;
}

export interface PostgresLeaderLeaseOptions {
  connectionString: string;
  lockKey: string;
  heartbeatMs?: number;
  clientFactory?: () => LeaderLockClient;
  onLost?: (error: Error) => void;
}

/** A session advisory lock fences Alpaca connections and order submission to one process. */
export class PostgresLeaderLease {
  readonly #lockId: string;
  readonly #heartbeatMs: number;
  readonly #clientFactory: () => LeaderLockClient;
  readonly #onLost: ((error: Error) => void) | undefined;
  #client: LeaderLockClient | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #active = false;
  #releasing = false;
  #lossReported = false;

  constructor(options: PostgresLeaderLeaseOptions) {
    if (!options.connectionString) throw new Error("Leader lease requires a PostgreSQL connection string");
    if (!options.lockKey.trim()) throw new Error("Leader lease lockKey cannot be empty");
    const heartbeatMs = options.heartbeatMs ?? 5_000;
    if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1) {
      throw new Error("Leader lease heartbeatMs must be a positive integer");
    }
    this.#lockId = advisoryLockId(options.lockKey);
    this.#heartbeatMs = heartbeatMs;
    this.#clientFactory = options.clientFactory ?? (() => new Client({
      connectionString: options.connectionString,
      application_name: "alpaca-options-engine-leader",
    }) as unknown as LeaderLockClient);
    this.#onLost = options.onLost;
  }

  async acquire(): Promise<boolean> {
    if (this.#client) throw new Error("Leader lease has already been acquired or attempted");
    const client = this.#clientFactory();
    this.#client = client;
    client.on("error", (error) => this.#lose(error ?? new Error("PostgreSQL leader session failed")));
    client.on("end", () => this.#lose(new Error("PostgreSQL leader session ended")));
    try {
      await client.connect();
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [this.#lockId],
      );
      this.#active = result.rows[0]?.acquired === true;
      if (!this.#active) {
        this.#releasing = true;
        await client.end();
        this.#client = undefined;
        this.#releasing = false;
        return false;
      }
      this.#heartbeat = setInterval(() => {
        void client.query("SELECT 1").catch((error: unknown) => {
          this.#lose(error instanceof Error ? error : new Error(String(error)));
        });
      }, this.#heartbeatMs);
      this.#heartbeat.unref();
      return true;
    } catch (error) {
      this.#active = false;
      this.#client = undefined;
      this.#releasing = true;
      await client.end().catch(() => undefined);
      this.#releasing = false;
      throw error;
    }
  }

  async release(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    this.#releasing = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    if (this.#active) {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [this.#lockId]).catch(() => undefined);
    }
    this.#active = false;
    this.#client = undefined;
    await client.end().catch(() => undefined);
    this.#releasing = false;
  }

  get active(): boolean { return this.#active; }

  #lose(error: Error): void {
    if (this.#releasing || this.#lossReported) return;
    this.#lossReported = true;
    this.#active = false;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#onLost?.(error);
  }
}

function advisoryLockId(key: string): string {
  const bytes = createHash("sha256").update(`alpaca-options-engine:${key}`).digest().subarray(0, 8);
  return bytes.readBigInt64BE().toString();
}
