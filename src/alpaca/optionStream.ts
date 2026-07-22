import type { OptionQuote } from "../types.js";
import WebSocket, { type RawData } from "ws";
import { decode, encode } from "@msgpack/msgpack";

export interface OptionStreamHandlers {
  onQuote(quote: OptionQuote): void | Promise<void>;
  onState?(connected: boolean): void;
  onError?(error: unknown): void;
}

export interface OptionStream {
  subscribe(symbols: readonly string[]): Promise<void>;
  unsubscribe(symbols: readonly string[]): Promise<void>;
  connect(handlers: OptionStreamHandlers): Promise<void>;
  close(): Promise<void>;
}

export interface AlpacaOptionStreamConfig {
  apiKey: string;
  apiSecret: string;
  feed?: "indicative" | "opra";
  sandbox?: boolean;
  url?: string;
}

export class AlpacaOptionWebSocket implements OptionStream {
  readonly #config: Required<Omit<AlpacaOptionStreamConfig, "url">> & { url: string };
  readonly #symbols = new Set<string>();
  #socket: WebSocket | undefined;
  #authenticated = false;

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
    };
  }

  async subscribe(symbols: readonly string[]): Promise<void> {
    for (const symbol of symbols) this.#symbols.add(symbol);
    if (this.#authenticated && symbols.length > 0) this.#send({ action: "subscribe", quotes: [...symbols] });
  }

  async unsubscribe(symbols: readonly string[]): Promise<void> {
    for (const symbol of symbols) this.#symbols.delete(symbol);
    if (this.#authenticated && symbols.length > 0) this.#send({ action: "unsubscribe", quotes: [...symbols] });
  }

  connect(handlers: OptionStreamHandlers): Promise<void> {
    if (this.#socket) throw new Error("Option stream is already connected");
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.#config.url, {
        headers: { "Content-Type": "application/msgpack" },
      });
      this.#socket = socket;
      socket.binaryType = "arraybuffer";
      socket.on("open", () => this.#send({ action: "auth", key: this.#config.apiKey, secret: this.#config.apiSecret }));
      socket.on("message", (data: RawData) => {
        try {
          const binary = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Buffer);
          const decoded = decode(binary) as Array<Record<string, unknown>>;
          for (const message of decoded) {
            if (message.T === "success" && message.msg === "authenticated") {
              this.#authenticated = true;
              if (this.#symbols.size > 0) this.#send({ action: "subscribe", quotes: [...this.#symbols] });
              else if (!settled) { settled = true; handlers.onState?.(true); resolve(); }
            } else if (message.T === "subscription") {
              if (!settled) { settled = true; handlers.onState?.(true); resolve(); }
            } else if (message.T === "q") void handlers.onQuote(adaptAlpacaOptionQuote(message));
            else if (message.T === "error") throw new Error(`Alpaca option stream error ${String(message.code)}: ${String(message.msg)}`);
          }
        } catch (error) {
          handlers.onError?.(error);
          if (!settled) { settled = true; reject(error); }
        }
      });
      socket.on("error", (error) => {
        handlers.onError?.(error);
        if (!settled) { settled = true; reject(error); }
      });
      socket.on("close", () => { this.#socket = undefined; this.#authenticated = false; handlers.onState?.(false); });
    });
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (!socket) return;
    await new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.close(); });
  }

  #send(message: Record<string, unknown>): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) throw new Error("Option stream is not open");
    this.#socket.send(encode(message));
  }
}

export function adaptAlpacaOptionQuote(raw: Record<string, unknown>): OptionQuote {
  const quote = {
    symbol: raw.S,
    timestamp: typeof raw.t === "string" ? Date.parse(raw.t) : raw.t,
    bidPrice: raw.bp,
    askPrice: raw.ap,
    bidSize: raw.bs,
    askSize: raw.as,
  };
  if (typeof quote.symbol !== "string" || ![quote.timestamp, quote.bidPrice, quote.askPrice, quote.bidSize, quote.askSize].every(Number.isFinite)) {
    throw new Error("Invalid Alpaca option quote payload");
  }
  return quote as OptionQuote;
}
