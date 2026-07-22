import type { StockQuote, StockTrade } from "../types.js";
import WebSocket, { type RawData } from "ws";

export interface StockStreamHandlers {
  onQuote(quote: StockQuote): void | Promise<void>;
  onTrade(trade: StockTrade): void | Promise<void>;
  onState?(connected: boolean): void;
  onError?(error: unknown): void;
}

export interface StockStream {
  connect(handlers: StockStreamHandlers): Promise<void>;
  close(): Promise<void>;
}

export interface AlpacaStockStreamConfig {
  apiKey: string;
  apiSecret: string;
  feed?: "iex" | "sip";
  symbol?: "SPY";
  url?: string;
  connectTimeoutMs?: number;
}

export class AlpacaStockWebSocket implements StockStream {
  readonly #config: Required<Omit<AlpacaStockStreamConfig, "url">> & { url: string };
  #socket: WebSocket | undefined;
  #handlers: StockStreamHandlers | undefined;

  constructor(config: AlpacaStockStreamConfig) {
    const feed = config.feed ?? "iex";
    this.#config = {
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      feed,
      symbol: config.symbol ?? "SPY",
      url: config.url ?? `wss://stream.data.alpaca.markets/v2/${feed}`,
      connectTimeoutMs: config.connectTimeoutMs ?? 10_000,
    };
  }

  connect(handlers: StockStreamHandlers): Promise<void> {
    if (this.#socket) throw new Error("Stock stream is already connected");
    this.#handlers = handlers;
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.#config.url);
      this.#socket = socket;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error(`Timed out authenticating SPY ${this.#config.feed.toUpperCase()} stream`));
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
          for (const message of messages) {
            if (message.T === "success" && message.msg === "authenticated") {
              socket.send(JSON.stringify({
                action: "subscribe", trades: [this.#config.symbol], quotes: [this.#config.symbol],
              }));
            } else if (message.T === "subscription") {
              const trades = Array.isArray(message.trades) ? message.trades : [];
              const quotes = Array.isArray(message.quotes) ? message.quotes : [];
              if (!trades.includes(this.#config.symbol) || !quotes.includes(this.#config.symbol)) {
                throw new Error(`SPY ${this.#config.feed.toUpperCase()} subscription acknowledgement is incomplete`);
              }
              resolveOnce();
            } else if (message.T === "q") void handlers.onQuote(adaptAlpacaStockQuote(message));
            else if (message.T === "t") void handlers.onTrade(adaptAlpacaStockTrade(message));
            else if (message.T === "error") throw new Error(`Alpaca stock stream error ${String(message.code)}: ${String(message.msg)}`);
          }
        } catch (error) {
          handlers.onError?.(error);
          rejectOnce(error);
        }
      });
      socket.on("error", (error) => {
        handlers.onError?.(error);
        rejectOnce(error);
      });
      socket.on("close", () => {
        this.#socket = undefined;
        handlers.onState?.(false);
        rejectOnce(new Error(`SPY ${this.#config.feed.toUpperCase()} stream closed before subscription`));
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
  if (quote.symbol !== "SPY" || ![quote.timestamp, quote.bidPrice, quote.askPrice, quote.bidSize, quote.askSize].every(Number.isFinite)) {
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
  if (trade.symbol !== "SPY" || ![trade.timestamp, trade.price, trade.size].every(Number.isFinite)) {
    throw new Error("Invalid Alpaca stock trade payload");
  }
  return trade as StockTrade;
}
