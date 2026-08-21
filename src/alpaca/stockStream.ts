import { isUnderlyingSymbol, type StockQuote, type StockTrade, type UnderlyingSymbol } from "../types.js";
import WebSocket, { type RawData } from "ws";
import type { MarketStreamTelemetry } from "../marketData/streamTelemetry.js";

export interface StockStreamHandlers {
  onQuote(quote: StockQuote): void | Promise<void>;
  onTrade(trade: StockTrade): void | Promise<void>;
  onEvents?(events: readonly StockStreamEvent[]): void | Promise<void>;
  onState?(connected: boolean): void;
  onError?(error: unknown): void;
}

export type StockStreamEvent =
  | { type: "quote"; value: StockQuote }
  | { type: "trade"; value: StockTrade };

export interface StockStream {
  connect(handlers: StockStreamHandlers): Promise<void>;
  close(): Promise<void>;
  /** Shared logical streams leave physical reconnect ownership at the hub. */
  readonly reconnectManaged?: boolean;
  requestReconnect?(reason?: string): Promise<void>;
  telemetry?(): MarketStreamTelemetry;
}

export interface AlpacaStockStreamConfig {
  apiKey: string;
  apiSecret: string;
  feed?: "iex" | "sip";
  /** `symbol` is retained for single-underlying callers. */
  symbol?: UnderlyingSymbol;
  symbols?: readonly UnderlyingSymbol[];
  url?: string;
  connectTimeoutMs?: number;
  maxPendingEvents?: number;
}

export class AlpacaStockWebSocket implements StockStream {
  readonly #config: {
    apiKey: string;
    apiSecret: string;
    feed: "iex" | "sip";
    symbols: readonly UnderlyingSymbol[];
    url: string;
    connectTimeoutMs: number;
    maxPendingEvents: number;
  };
  #socket: WebSocket | undefined;
  #handlers: StockStreamHandlers | undefined;
  readonly #pendingEvents: StockStreamEvent[] = [];
  #dispatching = false;
  #dispatchTail: Promise<void> = Promise.resolve();
  #overloaded = false;

  constructor(config: AlpacaStockStreamConfig) {
    const feed = config.feed ?? "iex";
    const symbols = [...new Set(config.symbols ?? [config.symbol ?? "SPY"])] as UnderlyingSymbol[];
    if (symbols.length === 0) throw new Error("At least one stock-stream symbol is required");
    this.#config = {
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      feed,
      symbols,
      url: config.url ?? `wss://stream.data.alpaca.markets/v2/${feed}`,
      connectTimeoutMs: config.connectTimeoutMs ?? 10_000,
      maxPendingEvents: config.maxPendingEvents ?? 100_000,
    };
    if (!Number.isInteger(this.#config.maxPendingEvents) || this.#config.maxPendingEvents < 1) {
      throw new Error("Stock stream maxPendingEvents must be a positive integer");
    }
  }

  connect(handlers: StockStreamHandlers): Promise<void> {
    if (this.#socket) throw new Error("Stock stream is already connected");
    this.#overloaded = false;
    this.#handlers = handlers;
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.#config.url);
      this.#socket = socket;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error(
          `Timed out authenticating ${this.#config.symbols.join(",")} ${this.#config.feed.toUpperCase()} stream`,
        ));
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
        action: "auth", key: this.#config.apiKey, secret: this.#config.apiSecret,
      })));
      socket.on("message", (data: RawData) => {
        try {
          const messages = JSON.parse(data.toString()) as Array<Record<string, unknown>>;
          const events: StockStreamEvent[] = [];
          for (const message of messages) {
            if (message.T === "success" && message.msg === "authenticated") {
              socket.send(JSON.stringify({
                action: "subscribe", trades: this.#config.symbols, quotes: this.#config.symbols,
              }));
            } else if (message.T === "subscription") {
              const trades = Array.isArray(message.trades) ? message.trades : [];
              const quotes = Array.isArray(message.quotes) ? message.quotes : [];
              if (this.#config.symbols.some((symbol) => !trades.includes(symbol) || !quotes.includes(symbol))) {
                throw new Error(
                  `${this.#config.symbols.join(",")} ${this.#config.feed.toUpperCase()} subscription acknowledgement is incomplete`,
                );
              }
              resolveOnce();
            } else if (message.T === "q") events.push({ type: "quote", value: adaptAlpacaStockQuote(message) });
            else if (message.T === "t") events.push({ type: "trade", value: adaptAlpacaStockTrade(message) });
            else if (message.T === "error") throw new Error(`Alpaca stock stream error ${String(message.code)}: ${String(message.msg)}`);
          }
          if (events.length > 0) this.#enqueueEvents(events);
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
        this.#socket = undefined;
        handlers.onState?.(false);
        rejectOnce(new Error(
          `${this.#config.symbols.join(",")} ${this.#config.feed.toUpperCase()} stream closed before subscription`,
        ));
      });
    });
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (socket) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
      });
    }
    await this.#dispatchTail;
  }

  telemetry(): MarketStreamTelemetry {
    return {
      pendingEvents: this.#pendingEvents.length,
      maximumPendingEvents: this.#config.maxPendingEvents,
      consumerLagMs: 0,
      maximumConsumerLagMs: Number.MAX_SAFE_INTEGER,
      coalescedEvents: 0,
      overloaded: this.#overloaded,
      reconnectAttempt: 0,
    };
  }

  #enqueueEvents(events: readonly StockStreamEvent[]): void {
    if (this.#overloaded) return;
    if (this.#pendingEvents.length + events.length > this.#config.maxPendingEvents) {
      this.#overloaded = true;
      const error = new Error(
        `SIP pending-event limit exceeded (${this.#pendingEvents.length + events.length} > ` +
        `${this.#config.maxPendingEvents})`,
      );
      this.#handlers?.onError?.(error);
      this.#socket?.close();
      return;
    }
    this.#pendingEvents.push(...events);
    if (this.#dispatching) return;
    this.#dispatching = true;
    this.#dispatchTail = this.#drainEvents();
  }

  async #drainEvents(): Promise<void> {
    try {
      while (this.#pendingEvents.length > 0) {
        const events = this.#pendingEvents.splice(0);
        const handlers = this.#handlers;
        if (!handlers) continue;
        if (handlers.onEvents) {
          await handlers.onEvents(events);
          continue;
        }
        for (const event of events) {
          if (event.type === "quote") await handlers.onQuote(event.value);
          else await handlers.onTrade(event.value);
        }
      }
    } catch (error) {
      this.#pendingEvents.length = 0;
      this.#handlers?.onError?.(error);
      this.#socket?.close();
    } finally {
      this.#dispatching = false;
      if (this.#pendingEvents.length > 0) this.#enqueueEvents([]);
    }
  }
}

/** Provider-schema adaptation is kept at the boundary and rejects incomplete messages. */
export function adaptAlpacaStockQuote(raw: Record<string, unknown>): StockQuote {
  const quote = {
    symbol: raw.S,
    timestamp: typeof raw.t === "string" ? Date.parse(raw.t) : raw.t,
    bidPrice: raw.bp,
    askPrice: raw.ap,
    bidSize: raw.bs,
    askSize: raw.as,
    bidExchange: raw.bx,
    askExchange: raw.ax,
    conditions: raw.c,
  };
  if (!isUnderlyingSymbol(quote.symbol) ||
      ![quote.timestamp, quote.bidPrice, quote.askPrice, quote.bidSize, quote.askSize].every(Number.isFinite)) {
    throw new Error("Invalid Alpaca stock quote payload");
  }
  return quote as StockQuote;
}

export function adaptAlpacaStockTrade(raw: Record<string, unknown>): StockTrade {
  const trade = {
    symbol: raw.S,
    timestamp: typeof raw.t === "string" ? Date.parse(raw.t) : raw.t,
    price: raw.p,
    size: raw.s,
    exchange: raw.x,
    conditions: raw.c,
  };
  if (!isUnderlyingSymbol(trade.symbol) || ![trade.timestamp, trade.price, trade.size].every(Number.isFinite)) {
    throw new Error("Invalid Alpaca stock trade payload");
  }
  return trade as StockTrade;
}
