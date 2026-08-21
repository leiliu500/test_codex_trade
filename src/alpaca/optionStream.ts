import type { OptionQuote, OptionTrade } from "../types.js";
import { performance } from "node:perf_hooks";
import WebSocket, { type RawData } from "ws";
import { decode, encode } from "@msgpack/msgpack";
import {
  parseRfc3339ToMs, type OpraQuoteObservation,
} from "../marketData/opraQuoteHealth.js";
import type { MarketStreamTelemetry } from "../marketData/streamTelemetry.js";

export interface OptionStreamActivity {
  receiveWallTimestamp: number;
  receiveMonotonicTimestamp: number;
}

export type OptionStreamEvent =
  | { type: "quote"; value: OptionQuote }
  | { type: "trade"; value: OptionTrade };

export interface OptionStreamHandlers {
  onQuote(quote: OptionQuote): void | Promise<void>;
  onQuotes?(quotes: readonly OptionQuote[]): void | Promise<void>;
  /** Synchronous raw-arrival observation, before coalescing or asynchronous consumers. */
  onQuoteObservations?(observations: readonly OpraQuoteObservation[]): void;
  /** Synchronous Alpaca provider events before quote coalescing. Keep this handler non-blocking. */
  onRawEvents?(events: readonly OptionStreamEvent[], activity: OptionStreamActivity): void;
  /** Any OPRA frame, including control frames and frames for other subscribed symbols. */
  onActivity?(activity: OptionStreamActivity): void;
  onState?(connected: boolean): void;
  onSubscriptions?(symbols: readonly string[]): void;
  onError?(error: unknown): void;
}

export interface OptionStream {
  subscribe(symbols: readonly string[]): Promise<void>;
  unsubscribe(symbols: readonly string[]): Promise<void>;
  connect(handlers: OptionStreamHandlers): Promise<void>;
  close(): Promise<void>;
  readonly reconnectManaged?: boolean;
  requestReconnect?(reason?: string): Promise<void>;
  telemetry?(): MarketStreamTelemetry;
}

export interface AlpacaOptionStreamConfig {
  apiKey: string;
  apiSecret: string;
  feed?: "indicative" | "opra";
  sandbox?: boolean;
  url?: string;
  connectTimeoutMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
}

export class AlpacaOptionWebSocket implements OptionStream {
  readonly #config: Required<Omit<AlpacaOptionStreamConfig, "url">> & { url: string };
  readonly #symbols = new Set<string>();
  readonly #pendingLatestQuotes = new Map<string, OptionQuote>();
  #socket: WebSocket | undefined;
  #handlers: OptionStreamHandlers | undefined;
  #authenticated = false;
  #dispatching = false;
  #connectionSequence = 0;
  #activeConnectionId = 0;
  #dispatchTail: Promise<void> = Promise.resolve();
  #subscriptionTail: Promise<void> = Promise.resolve();
  #subscriptionWaiter: {
    target: Set<string>;
    resolve: () => void;
    reject: (error: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
  } | undefined;
  #coalescedQuotes = 0;

  constructor(config: AlpacaOptionStreamConfig) {
    const feed = config.feed ?? "indicative";
    const sandbox = config.sandbox ?? false;
    const host = sandbox ? "stream.data.sandbox.alpaca.markets" : "stream.data.alpaca.markets";
    this.#config = {
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      feed,
      sandbox,
      url: config.url ?? `wss://${host}/v1beta1/${feed}`,
      connectTimeoutMs: config.connectTimeoutMs ?? 10_000,
      now: config.now ?? Date.now,
      monotonicNow: config.monotonicNow ?? performance.now.bind(performance),
    };
  }

  subscribe(symbols: readonly string[]): Promise<void> {
    return this.#updateSubscriptions("subscribe", symbols);
  }

  unsubscribe(symbols: readonly string[]): Promise<void> {
    return this.#updateSubscriptions("unsubscribe", symbols);
  }

  connect(handlers: OptionStreamHandlers): Promise<void> {
    if (this.#socket) throw new Error("Option stream is already connected");
    this.#handlers = handlers;
    this.#activeConnectionId = ++this.#connectionSequence;
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.#config.url, {
        headers: { "Content-Type": "application/msgpack" },
      });
      this.#socket = socket;
      socket.binaryType = "arraybuffer";
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error(`Timed out authenticating ${this.#config.feed.toUpperCase()} option stream`));
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
      socket.on("open", () => this.#send({ action: "auth", key: this.#config.apiKey, secret: this.#config.apiSecret }));
      socket.on("message", (data: RawData) => {
        const receiveWallTimestamp = this.#config.now();
        const receiveMonotonicTimestamp = this.#config.monotonicNow();
        try {
          handlers.onActivity?.({ receiveWallTimestamp, receiveMonotonicTimestamp });
          const binary = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Buffer);
          const decoded = decode(binary) as Array<Record<string, unknown>>;
          const quotes: OptionQuote[] = [];
          const trades: OptionTrade[] = [];
          for (const message of decoded) {
            if (message.T === "success" && message.msg === "authenticated") {
              this.#authenticated = true;
              if (this.#symbols.size > 0) {
                const initialSubscription = this.#waitForSubscriptions(new Set(this.#symbols));
                this.#subscriptionTail = initialSubscription.catch(() => undefined);
                this.#send({ action: "subscribe", quotes: [...this.#symbols], trades: [...this.#symbols] });
                void initialSubscription.then(resolveOnce, rejectOnce);
              }
              else resolveOnce();
            } else if (message.T === "subscription") {
              const quotes = Array.isArray(message.quotes)
                ? message.quotes.filter((symbol): symbol is string => typeof symbol === "string")
                : [];
              const trades = Array.isArray(message.trades)
                ? message.trades.filter((symbol): symbol is string => typeof symbol === "string")
                : [];
              handlers.onSubscriptions?.(quotes);
              this.#acceptSubscriptionSnapshot(new Set(quotes), new Set(trades));
            } else if (message.T === "q") quotes.push(adaptAlpacaOptionQuote(message));
            else if (message.T === "t") trades.push(adaptAlpacaOptionTrade(message));
            else if (message.T === "error") throw new Error(`Alpaca option stream error ${String(message.code)}: ${String(message.msg)}`);
          }
          const rawEvents: OptionStreamEvent[] = [
            ...quotes.map((quote) => ({ type: "quote" as const, value: quote })),
            ...trades.map((trade) => ({ type: "trade" as const, value: trade })),
          ].sort((left, right) => left.value.timestamp - right.value.timestamp);
          if (rawEvents.length > 0) {
            handlers.onRawEvents?.(rawEvents, { receiveWallTimestamp, receiveMonotonicTimestamp });
          }
          if (quotes.length > 0) {
            handlers.onQuoteObservations?.(quotes.map((quote) => ({
              quote,
              receiveWallTimestamp,
              receiveMonotonicTimestamp,
              websocketConnectionId: this.#activeConnectionId,
              subscriptionSymbols: [...this.#symbols],
            })));
            this.#enqueueQuotes(quotes);
          }
        } catch (error) {
          this.#failSubscriptionWaiter(error);
          rejectOnce(error);
          this.#failSocket(error);
        }
      });
      socket.on("error", (error) => {
        this.#failSubscriptionWaiter(error);
        rejectOnce(error);
        handlers.onError?.(error);
      });
      socket.on("close", () => {
        clearTimeout(timeout);
        this.#socket = undefined;
        this.#authenticated = false;
        this.#failSubscriptionWaiter(new Error(`${this.#config.feed.toUpperCase()} option stream closed`));
        handlers.onState?.(false);
        rejectOnce(new Error(`${this.#config.feed.toUpperCase()} option stream closed before subscription`));
      });
    });
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (socket) {
      await new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.close(); });
    }
    await this.#subscriptionTail;
    await this.#dispatchTail;
  }

  telemetry(): MarketStreamTelemetry {
    return {
      pendingEvents: this.#pendingLatestQuotes.size,
      maximumPendingEvents: Number.MAX_SAFE_INTEGER,
      consumerLagMs: 0,
      maximumConsumerLagMs: Number.MAX_SAFE_INTEGER,
      coalescedEvents: this.#coalescedQuotes,
      overloaded: false,
      reconnectAttempt: 0,
    };
  }

  #updateSubscriptions(action: "subscribe" | "unsubscribe", symbols: readonly string[]): Promise<void> {
    const unique = [...new Set(symbols)];
    if (unique.length === 0) return Promise.resolve();
    if (!this.#authenticated) {
      for (const symbol of unique) {
        if (action === "subscribe") this.#symbols.add(symbol);
        else this.#symbols.delete(symbol);
      }
      return Promise.resolve();
    }
    const operation = this.#subscriptionTail.then(async () => {
      for (const symbol of unique) {
        if (action === "subscribe") this.#symbols.add(symbol);
        else this.#symbols.delete(symbol);
      }
      if (!this.#authenticated) return;
      const acknowledgement = this.#waitForSubscriptions(new Set(this.#symbols));
      try {
        this.#send({ action, quotes: unique, trades: unique });
      } catch (error) {
        this.#failSubscriptionWaiter(error);
      }
      await acknowledgement;
    });
    this.#subscriptionTail = operation.catch(() => undefined);
    return operation;
  }

  #waitForSubscriptions(target: Set<string>): Promise<void> {
    if (this.#subscriptionWaiter) throw new Error("Option subscription acknowledgement is already pending");
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error(
          `Timed out reconciling ${this.#config.feed.toUpperCase()} option subscriptions`,
        );
        this.#subscriptionWaiter = undefined;
        reject(error);
        this.#failSocket(error);
      }, this.#config.connectTimeoutMs);
      this.#subscriptionWaiter = { target, resolve, reject, timeout };
    });
  }

  #acceptSubscriptionSnapshot(acknowledgedQuotes: Set<string>, acknowledgedTrades: Set<string>): void {
    const waiter = this.#subscriptionWaiter;
    const target = waiter?.target ?? this.#symbols;
    const missingQuotes = [...target].filter((symbol) => !acknowledgedQuotes.has(symbol));
    const unexpectedQuotes = [...acknowledgedQuotes].filter((symbol) => !target.has(symbol));
    const missingTrades = [...target].filter((symbol) => !acknowledgedTrades.has(symbol));
    const unexpectedTrades = [...acknowledgedTrades].filter((symbol) => !target.has(symbol));
    if (missingQuotes.length > 0 || unexpectedQuotes.length > 0 ||
        missingTrades.length > 0 || unexpectedTrades.length > 0) {
      const error = new Error(
        `${this.#config.feed.toUpperCase()} option subscription acknowledgement differs from requested state: ` +
        `${missingQuotes.length} quote/${missingTrades.length} trade missing, ` +
        `${unexpectedQuotes.length} quote/${unexpectedTrades.length} trade unexpected`,
      );
      this.#failSubscriptionWaiter(error);
      this.#failSocket(error);
      return;
    }
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.#subscriptionWaiter = undefined;
    waiter.resolve();
  }

  #failSubscriptionWaiter(error: unknown): void {
    const waiter = this.#subscriptionWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.#subscriptionWaiter = undefined;
    waiter.reject(error);
  }

  #failSocket(error: unknown): void {
    this.#handlers?.onError?.(error);
    const socket = this.#socket;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close();
    }
  }

  #enqueueQuotes(quotes: readonly OptionQuote[]): void {
    for (const quote of quotes) {
      const pending = this.#pendingLatestQuotes.get(quote.symbol);
      if (!pending || quote.timestamp >= pending.timestamp) {
        if (pending) this.#coalescedQuotes += 1;
        this.#pendingLatestQuotes.set(quote.symbol, quote);
      }
    }
    if (this.#dispatching) return;
    this.#dispatching = true;
    this.#dispatchTail = this.#drainQuotes();
  }

  async #drainQuotes(): Promise<void> {
    try {
      while (this.#pendingLatestQuotes.size > 0) {
        const quotes = [...this.#pendingLatestQuotes.values()]
          .sort((left, right) => left.timestamp - right.timestamp || left.symbol.localeCompare(right.symbol));
        this.#pendingLatestQuotes.clear();
        const handlers = this.#handlers;
        if (handlers) {
          if (handlers.onQuotes) await handlers.onQuotes(quotes);
          else for (const quote of quotes) await handlers.onQuote(quote);
        }
      }
    } catch (error) {
      this.#pendingLatestQuotes.clear();
      this.#handlers?.onError?.(error);
      this.#socket?.close();
    } finally {
      this.#dispatching = false;
      if (this.#pendingLatestQuotes.size > 0) {
        const quotes = [...this.#pendingLatestQuotes.values()];
        this.#pendingLatestQuotes.clear();
        this.#enqueueQuotes(quotes);
      }
    }
  }

  #send(message: Record<string, unknown>): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) throw new Error("Option stream is not open");
    this.#socket.send(encode(message));
  }
}

export function adaptAlpacaOptionQuote(raw: Record<string, unknown>): OptionQuote {
  const quote = {
    symbol: raw.S,
    // MsgPack timestamp extensions are decoded to Date instances even though
    // Alpaca documents the logical field as an RFC-3339 string.
    timestamp: raw.t instanceof Date ? raw.t.getTime() :
      typeof raw.t === "string" ? parseRfc3339ToMs(raw.t) : raw.t,
    bidPrice: raw.bp,
    askPrice: raw.ap,
    bidSize: raw.bs,
    askSize: raw.as,
    ...(typeof raw.bx === "string" ? { bidExchange: raw.bx } : {}),
    ...(typeof raw.ax === "string" ? { askExchange: raw.ax } : {}),
    ...(Array.isArray(raw.c)
      ? { conditions: raw.c.filter((condition): condition is string => typeof condition === "string") }
      : typeof raw.c === "string" ? { conditions: [raw.c] } : {}),
  };
  if (typeof quote.symbol !== "string" || ![quote.timestamp, quote.bidPrice, quote.askPrice, quote.bidSize, quote.askSize].every(Number.isFinite)) {
    throw new Error("Invalid Alpaca option quote payload");
  }
  return quote as OptionQuote;
}

export function adaptAlpacaOptionTrade(raw: Record<string, unknown>): OptionTrade {
  const trade = {
    symbol: raw.S,
    timestamp: raw.t instanceof Date ? raw.t.getTime() :
      typeof raw.t === "string" ? parseRfc3339ToMs(raw.t) : raw.t,
    price: raw.p,
    size: raw.s,
    ...(typeof raw.x === "string" ? { exchange: raw.x } : {}),
    ...(Array.isArray(raw.c)
      ? { conditions: raw.c.filter((condition): condition is string => typeof condition === "string") }
      : typeof raw.c === "string" ? { conditions: [raw.c] } : {}),
  };
  if (typeof trade.symbol !== "string" ||
      ![trade.timestamp, trade.price, trade.size].every(Number.isFinite)) {
    throw new Error("Invalid Alpaca option trade payload");
  }
  return trade as OptionTrade;
}
