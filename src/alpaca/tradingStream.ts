import { performance } from "node:perf_hooks";
import WebSocket, { type RawData } from "ws";
import type { MarketStreamTelemetry } from "../marketData/streamTelemetry.js";
import { parseOccSymbol } from "../options/occSymbol.js";
import { isUnderlyingSymbol, type UnderlyingSymbol } from "../types.js";
import { parseRfc3339ToMs } from "../marketData/opraQuoteHealth.js";
import { adaptAlpacaBrokerOrder, type BrokerOrder } from "./restClient.js";

export interface AlpacaTradeUpdate {
  event: string;
  timestamp: number;
  order: BrokerOrder;
}

export interface TradeUpdateStreamHandlers {
  onUpdate(update: AlpacaTradeUpdate): void;
  onState?(connected: boolean): void;
  onError?(error: unknown): void;
}

export interface TradeUpdateStream {
  connect(handlers: TradeUpdateStreamHandlers): Promise<void>;
  close(): Promise<void>;
}

export interface AlpacaTradeUpdateStreamConfig {
  apiKey: string;
  apiSecret: string;
  paper?: boolean;
  url?: string;
  connectTimeoutMs?: number;
  now?: () => number;
}

/** One physical account stream. Reconnect and consumer isolation are owned by the coordinator below. */
export class AlpacaTradeUpdateWebSocket implements TradeUpdateStream {
  readonly #config: {
    apiKey: string;
    apiSecret: string;
    url: string;
    connectTimeoutMs: number;
    now: () => number;
  };
  #socket: WebSocket | undefined;

  constructor(config: AlpacaTradeUpdateStreamConfig) {
    const paper = config.paper ?? true;
    this.#config = {
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      url: config.url ?? (paper
        ? "wss://paper-api.alpaca.markets/stream"
        : "wss://api.alpaca.markets/stream"),
      connectTimeoutMs: config.connectTimeoutMs ?? 10_000,
      now: config.now ?? Date.now,
    };
  }

  connect(handlers: TradeUpdateStreamHandlers): Promise<void> {
    if (this.#socket) throw new Error("Trade-update stream is already connected");
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.#config.url);
      this.#socket = socket;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error("Timed out authenticating Alpaca trade-update stream"));
      }, this.#config.connectTimeoutMs);
      const resolveOnce = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        handlers.onState?.(true);
        resolve();
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      socket.on("open", () => socket.send(JSON.stringify({
        action: "auth",
        key: this.#config.apiKey,
        secret: this.#config.apiSecret,
      })));
      socket.on("message", (data: RawData) => {
        try {
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          const stream = message.stream;
          const payload = message.data;
          if (stream === "authorization" && payload && typeof payload === "object") {
            const status = (payload as Record<string, unknown>).status;
            if (status !== "authorized") throw new Error("Alpaca trade-update authorization failed");
            socket.send(JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } }));
          } else if (stream === "listening" && payload && typeof payload === "object") {
            const streams = (payload as Record<string, unknown>).streams;
            if (!Array.isArray(streams) || !streams.includes("trade_updates")) {
              throw new Error("Alpaca did not acknowledge the trade_updates subscription");
            }
            resolveOnce();
          } else if (stream === "trade_updates" && payload && typeof payload === "object") {
            handlers.onUpdate(adaptAlpacaTradeUpdate(payload as Record<string, unknown>, this.#config.now()));
          } else if (stream === "error") {
            throw new Error(`Alpaca trade-update stream error: ${JSON.stringify(payload)}`);
          }
        } catch (error) {
          handlers.onError?.(error);
          rejectOnce(error);
          socket.close();
        }
      });
      socket.on("error", (error) => {
        handlers.onError?.(error);
        rejectOnce(error);
      });
      socket.on("close", () => {
        clearTimeout(timeout);
        this.#socket = undefined;
        handlers.onState?.(false);
        rejectOnce(new Error("Alpaca trade-update stream closed before subscription"));
      });
    });
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
  }
}

export function adaptAlpacaTradeUpdate(raw: Record<string, unknown>, fallbackTimestamp = Date.now()): AlpacaTradeUpdate {
  if (typeof raw.event !== "string" || !raw.order || typeof raw.order !== "object") {
    throw new Error("Invalid Alpaca trade-update payload");
  }
  const timestampValue = raw.timestamp ?? raw.at;
  const timestamp = typeof timestampValue === "string"
    ? parseRfc3339ToMs(timestampValue)
    : fallbackTimestamp;
  return {
    event: raw.event,
    timestamp: Number.isFinite(timestamp) ? timestamp : fallbackTimestamp,
    order: adaptAlpacaBrokerOrder(raw.order as Record<string, unknown>),
  };
}

export interface TradeUpdateConsumer {
  onUpdate(update: AlpacaTradeUpdate): void | Promise<void>;
  onReconcile(timestamp: number): void | Promise<void>;
  onState?(connected: boolean): void;
  onError?(error: unknown): void;
}

export interface AccountTradeUpdateCoordinatorOptions {
  reconnectBaseMs?: number;
  reconnectMaximumMs?: number;
  maxPendingEventsPerUnderlying?: number;
  maxConsumerLagMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
}

interface TradeUpdateConsumerState {
  consumer: TradeUpdateConsumer;
  pending: Array<{ update: AlpacaTradeUpdate; enqueuedAt: number }>;
  dispatching: boolean;
  dispatchTail: Promise<void>;
  lastConsumerLagMs: number;
  failed: boolean;
}

/** Reconnects one account stream and routes broker updates through bounded per-underlying queues. */
export class AccountTradeUpdateCoordinator {
  readonly #physical: TradeUpdateStream;
  readonly #consumers = new Map<UnderlyingSymbol, TradeUpdateConsumerState>();
  readonly #reconnectBaseMs: number;
  readonly #reconnectMaximumMs: number;
  readonly #maxPendingEvents: number;
  readonly #maxConsumerLagMs: number;
  readonly #now: () => number;
  readonly #monotonicNow: () => number;
  #connected = false;
  #ready = false;
  #connection: Promise<void> | undefined;
  #stopOperation: Promise<void> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectAttempt = 0;
  #generation = 0;
  #started = false;
  #fatal = false;

  constructor(
    physical: TradeUpdateStream,
    consumers: Readonly<Partial<Record<UnderlyingSymbol, TradeUpdateConsumer>>>,
    options: AccountTradeUpdateCoordinatorOptions = {},
  ) {
    this.#physical = physical;
    this.#reconnectBaseMs = positiveInteger(options.reconnectBaseMs ?? 1_000, "trade-update reconnectBaseMs");
    this.#reconnectMaximumMs = positiveInteger(options.reconnectMaximumMs ?? 30_000, "trade-update reconnectMaximumMs");
    this.#maxPendingEvents = positiveInteger(
      options.maxPendingEventsPerUnderlying ?? 10_000,
      "trade-update maxPendingEventsPerUnderlying",
    );
    this.#maxConsumerLagMs = positiveInteger(options.maxConsumerLagMs ?? 1_000, "trade-update maxConsumerLagMs");
    this.#now = options.now ?? Date.now;
    this.#monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
    for (const [underlying, consumer] of Object.entries(consumers) as Array<[UnderlyingSymbol, TradeUpdateConsumer]>) {
      this.#consumers.set(underlying, {
        consumer,
        pending: [],
        dispatching: false,
        dispatchTail: Promise.resolve(),
        lastConsumerLagMs: 0,
        failed: false,
      });
    }
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("Account trade-update coordinator is already started");
    this.#started = true;
    this.#fatal = false;
    for (const state of this.#consumers.values()) state.consumer.onState?.(false);
    try {
      await this.#ensureConnected();
    } catch (error) {
      this.#scheduleReconnect();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#started = false;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    await this.#stopPhysical();
    await Promise.all([...this.#consumers.values()].map((state) => state.dispatchTail.catch(() => undefined)));
  }

  telemetry(underlying: UnderlyingSymbol): MarketStreamTelemetry {
    const state = this.#consumers.get(underlying);
    if (!state) throw new Error(`${underlying} is not registered with the trade-update coordinator`);
    const oldestAge = state.pending[0]
      ? Math.max(0, this.#monotonicNow() - state.pending[0].enqueuedAt)
      : 0;
    return {
      pendingEvents: state.pending.length,
      maximumPendingEvents: this.#maxPendingEvents,
      consumerLagMs: Math.max(oldestAge, state.lastConsumerLagMs),
      maximumConsumerLagMs: this.#maxConsumerLagMs,
      coalescedEvents: 0,
      overloaded: state.failed || Math.max(oldestAge, state.lastConsumerLagMs) > this.#maxConsumerLagMs,
      reconnectAttempt: this.#reconnectAttempt,
    };
  }

  get ready(): boolean { return this.#ready; }

  async #ensureConnected(): Promise<void> {
    if (this.#fatal) throw new Error("Account trade-update coordinator is halted");
    if (this.#ready) return;
    if (this.#connection) return this.#connection;
    const generation = ++this.#generation;
    const connection = (async () => {
      await Promise.all([...this.#consumers.values()].map((state) => state.dispatchTail.catch(() => undefined)));
      if (generation !== this.#generation) throw new Error("Trade-update connection was superseded");
      for (const state of this.#consumers.values()) {
        state.failed = false;
        state.pending.length = 0;
      }
      await this.#physical.connect({
        onUpdate: (update) => this.#enqueue(update),
        onState: (connected) => {
          if (generation !== this.#generation) return;
          this.#connected = connected;
          if (!connected) {
            this.#ready = false;
            this.#connection = undefined;
            for (const state of this.#consumers.values()) {
              state.pending.length = 0;
              state.consumer.onState?.(false);
            }
            this.#scheduleReconnect();
          }
        },
        onError: (error) => this.#broadcastError(error),
      });
      if (generation !== this.#generation) throw new Error("Trade-update connection was superseded");
      await Promise.all([...this.#consumers.values()].map((state) => state.consumer.onReconcile(this.#now())));
      if (generation !== this.#generation) throw new Error("Trade-update reconciliation was superseded");
      await Promise.all([...this.#consumers.values()].map((state) => this.#drainReconciliationBuffer(state)));
      if (generation !== this.#generation) throw new Error("Trade-update reconciliation was superseded");
      this.#ready = true;
      this.#reconnectAttempt = 0;
      for (const state of this.#consumers.values()) {
        state.consumer.onState?.(true);
        this.#scheduleDrain(state);
      }
    })();
    this.#connection = connection;
    try {
      await connection;
    } catch (error) {
      if (generation === this.#generation) {
        this.#generation += 1;
        this.#connection = undefined;
        this.#connected = false;
        this.#ready = false;
        for (const state of this.#consumers.values()) {
          state.pending.length = 0;
          state.consumer.onState?.(false);
        }
        await this.#physical.close().catch((closeError: unknown) => this.#broadcastError(closeError));
      }
      throw error;
    }
  }

  #enqueue(update: AlpacaTradeUpdate): void {
    const parsed = parseOccSymbol(update.order.symbol);
    const underlying = parsed?.underlying;
    if (!isUnderlyingSymbol(underlying) || !this.#consumers.has(underlying)) {
      const error = new Error(`Trade update contains disabled or invalid option ${update.order.symbol}`);
      this.#haltAccountStream(error);
      return;
    }
    const state = this.#consumers.get(underlying)!;
    if (state.pending.length + 1 > this.#maxPendingEvents) {
      state.failed = true;
      state.pending.length = 0;
      const error = new Error(
        `${underlying} trade-update pending-event limit exceeded; account stream failed closed`,
      );
      state.consumer.onError?.(error);
      void this.#stopPhysical().finally(() => this.#scheduleReconnect());
      return;
    }
    state.pending.push({ update, enqueuedAt: this.#monotonicNow() });
    if (this.#ready) this.#scheduleDrain(state);
  }

  async #drainReconciliationBuffer(state: TradeUpdateConsumerState): Promise<void> {
    try {
      while (!state.failed && state.pending.length > 0) {
        const pending = state.pending.shift()!;
        state.lastConsumerLagMs = Math.max(0, this.#monotonicNow() - pending.enqueuedAt);
        await state.consumer.onUpdate(pending.update);
      }
    } catch (error) {
      state.failed = true;
      state.pending.length = 0;
      state.consumer.onError?.(error);
      throw error;
    }
  }

  #scheduleDrain(state: TradeUpdateConsumerState): void {
    if (state.dispatching || state.failed || !this.#ready || state.pending.length === 0) return;
    state.dispatching = true;
    state.dispatchTail = this.#drain(state);
  }

  async #drain(state: TradeUpdateConsumerState): Promise<void> {
    try {
      while (!state.failed && state.pending.length > 0) {
        const pending = state.pending.shift()!;
        state.lastConsumerLagMs = Math.max(0, this.#monotonicNow() - pending.enqueuedAt);
        await state.consumer.onUpdate(pending.update);
      }
    } catch (error) {
      state.failed = true;
      state.pending.length = 0;
      state.consumer.onError?.(error);
      void this.#stopPhysical().finally(() => this.#scheduleReconnect());
    } finally {
      state.dispatching = false;
      this.#scheduleDrain(state);
    }
  }

  #scheduleReconnect(): void {
    if (!this.#started || this.#fatal || this.#ready || this.#connection || this.#reconnectTimer ||
        this.#stopOperation) return;
    this.#reconnectAttempt += 1;
    const delay = Math.min(
      this.#reconnectMaximumMs,
      this.#reconnectBaseMs * (2 ** Math.max(0, this.#reconnectAttempt - 1)),
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#ensureConnected().catch((error: unknown) => {
        this.#broadcastError(error);
        this.#scheduleReconnect();
      });
    }, delay);
  }

  #stopPhysical(): Promise<void> {
    if (this.#stopOperation) return this.#stopOperation;
    this.#stopOperation = (async () => {
      const connection = this.#connection;
      this.#generation += 1;
      this.#connection = undefined;
      this.#connected = false;
      this.#ready = false;
      for (const state of this.#consumers.values()) {
        state.pending.length = 0;
        state.consumer.onState?.(false);
      }
      await this.#physical.close().catch((error: unknown) => this.#broadcastError(error));
      await connection?.catch(() => undefined);
    })().finally(() => { this.#stopOperation = undefined; });
    return this.#stopOperation;
  }

  #broadcastError(error: unknown): void {
    for (const state of this.#consumers.values()) state.consumer.onError?.(error);
  }

  #haltAccountStream(error: Error): void {
    if (this.#fatal) return;
    this.#fatal = true;
    this.#ready = false;
    for (const state of this.#consumers.values()) state.failed = true;
    this.#broadcastError(error);
    void this.#stopPhysical();
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}
