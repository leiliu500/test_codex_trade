import { performance } from "node:perf_hooks";
import WebSocket, { type RawData } from "ws";
import type { OptionQuote } from "../types.js";
import type {
  OptionStream, OptionStreamHandlers,
} from "../alpaca/optionStream.js";
import type { OpraQuoteObservation } from "../marketData/opraQuoteHealth.js";
import { parseOccSymbol } from "../options/occSymbol.js";

export interface MassiveOptionStreamConfig {
  apiKey: string;
  url?: string;
  connectTimeoutMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
}

interface SubscriptionWaiter {
  action: "subscribe" | "unsubscribe";
  resolve: () => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const MASSIVE_OPTION_SUBSCRIPTION_LIMIT = 1_000;

/** Real-time Massive OPRA quote stream, normalized to internal OCC symbols. */
export class MassiveOptionWebSocket implements OptionStream {
  readonly #config: Required<MassiveOptionStreamConfig>;
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
  #subscriptionWaiter: SubscriptionWaiter | undefined;

  constructor(config: MassiveOptionStreamConfig) {
    if (!config.apiKey) throw new Error("Massive option stream requires an API key");
    this.#config = {
      apiKey: config.apiKey,
      url: config.url ?? "wss://socket.massive.com/options",
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
    if (this.#socket) throw new Error("Massive option stream is already connected");
    this.#handlers = handlers;
    this.#activeConnectionId = ++this.#connectionSequence;
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.#config.url);
      this.#socket = socket;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error("Timed out authenticating Massive OPRA option stream"));
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

      socket.on("open", () => this.#send({ action: "auth", params: this.#config.apiKey }));
      socket.on("message", (data: RawData) => {
        const receiveWallTimestamp = this.#config.now();
        const receiveMonotonicTimestamp = this.#config.monotonicNow();
        try {
          handlers.onActivity?.({ receiveWallTimestamp, receiveMonotonicTimestamp });
          const decoded = JSON.parse(rawDataToString(data)) as unknown;
          const messages = Array.isArray(decoded) ? decoded : [decoded];
          const quotes: OptionQuote[] = [];
          for (const value of messages) {
            if (!value || typeof value !== "object") throw new Error("Invalid Massive option stream payload");
            const message = value as Record<string, unknown>;
            if (message.ev === "Q") {
              quotes.push(adaptMassiveOptionQuote(message));
              continue;
            }
            if (message.ev !== "status") continue;
            const status = String(message.status ?? "");
            if (status === "connected") continue;
            if (status === "auth_success") {
              this.#authenticated = true;
              if (this.#symbols.size === 0) {
                handlers.onSubscriptions?.([]);
                resolveOnce();
              } else {
                const acknowledgement = this.#waitForSubscription("subscribe");
                this.#subscriptionTail = acknowledgement.catch(() => undefined);
                this.#sendSubscription("subscribe", [...this.#symbols]);
                void acknowledgement.then(() => {
                  handlers.onSubscriptions?.([...this.#symbols]);
                  resolveOnce();
                }, rejectOnce);
              }
              continue;
            }
            if (status === "success") {
              this.#acceptSubscriptionAcknowledgement(String(message.message ?? ""));
              continue;
            }
            throw new Error(`Massive option stream ${status || "error"}: ${String(message.message ?? "unknown error")}`);
          }
          if (quotes.length > 0) {
            const subscriptionSymbols = [...this.#symbols];
            const observations: OpraQuoteObservation[] = quotes.map((quote) => ({
              quote,
              receiveWallTimestamp,
              receiveMonotonicTimestamp,
              websocketConnectionId: this.#activeConnectionId,
              subscriptionSymbols,
            }));
            handlers.onQuoteObservations?.(observations);
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
        this.#failSubscriptionWaiter(new Error("Massive OPRA option stream closed"));
        handlers.onState?.(false);
        rejectOnce(new Error("Massive OPRA option stream closed before subscription"));
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
    await this.#subscriptionTail;
    await this.#dispatchTail;
  }

  #updateSubscriptions(action: "subscribe" | "unsubscribe", symbols: readonly string[]): Promise<void> {
    const unique = [...new Set(symbols.map(normalizeInternalOptionSymbol))];
    if (unique.length === 0) return Promise.resolve();
    if (!this.#authenticated) {
      const next = this.#nextSymbols(action, unique);
      this.#replaceSymbols(next);
      return Promise.resolve();
    }
    const operation = this.#subscriptionTail.then(async () => {
      const next = this.#nextSymbols(action, unique);
      this.#replaceSymbols(next);
      if (!this.#authenticated) return;
      const acknowledgement = this.#waitForSubscription(action);
      try { this.#sendSubscription(action, unique); }
      catch (error) { this.#failSubscriptionWaiter(error); }
      await acknowledgement;
      this.#handlers?.onSubscriptions?.([...this.#symbols]);
    });
    this.#subscriptionTail = operation.catch(() => undefined);
    return operation;
  }

  #nextSymbols(action: "subscribe" | "unsubscribe", symbols: readonly string[]): Set<string> {
    const next = new Set(this.#symbols);
    for (const symbol of symbols) {
      if (action === "subscribe") next.add(symbol);
      else next.delete(symbol);
    }
    if (next.size > MASSIVE_OPTION_SUBSCRIPTION_LIMIT) {
      throw new Error(
        `Massive OPRA supports at most ${MASSIVE_OPTION_SUBSCRIPTION_LIMIT} option contracts per connection`,
      );
    }
    return next;
  }

  #replaceSymbols(symbols: ReadonlySet<string>): void {
    this.#symbols.clear();
    for (const symbol of symbols) this.#symbols.add(symbol);
  }

  #sendSubscription(action: "subscribe" | "unsubscribe", symbols: readonly string[]): void {
    this.#send({ action, params: symbols.map((symbol) => `Q.${toMassiveOptionTicker(symbol)}`).join(",") });
  }

  #waitForSubscription(action: "subscribe" | "unsubscribe"): Promise<void> {
    if (this.#subscriptionWaiter) throw new Error("Massive option subscription acknowledgement is already pending");
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error(`Timed out waiting for Massive OPRA ${action} acknowledgement`);
        this.#subscriptionWaiter = undefined;
        reject(error);
        this.#failSocket(error);
      }, this.#config.connectTimeoutMs);
      this.#subscriptionWaiter = { action, resolve, reject, timeout };
    });
  }

  #acceptSubscriptionAcknowledgement(message: string): void {
    const waiter = this.#subscriptionWaiter;
    if (!waiter) return;
    const expected = waiter.action === "subscribe" ? "subscribed" : "unsubscribed";
    if (!message.toLowerCase().includes(expected)) return;
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
      if (!pending || quote.timestamp >= pending.timestamp) this.#pendingLatestQuotes.set(quote.symbol, quote);
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
        if (handlers?.onQuotes) await handlers.onQuotes(quotes);
        else if (handlers) for (const quote of quotes) await handlers.onQuote(quote);
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
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("Massive option stream is not open");
    }
    this.#socket.send(JSON.stringify(message));
  }
}

export function adaptMassiveOptionQuote(raw: Record<string, unknown>): OptionQuote {
  const symbol = fromMassiveOptionTicker(raw.sym);
  const values = [raw.t, raw.bp, raw.ap, raw.bs, raw.as];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error(`Invalid Massive option quote payload for ${symbol}`);
  }
  return {
    symbol,
    timestamp: raw.t as number,
    bidPrice: raw.bp as number,
    askPrice: raw.ap as number,
    bidSize: raw.bs as number,
    askSize: raw.as as number,
    ...(typeof raw.bx === "number" || typeof raw.bx === "string" ? { bidExchange: String(raw.bx) } : {}),
    ...(typeof raw.ax === "number" || typeof raw.ax === "string" ? { askExchange: String(raw.ax) } : {}),
  };
}

export function toMassiveOptionTicker(symbol: string): string {
  return `O:${normalizeInternalOptionSymbol(symbol)}`;
}

export function fromMassiveOptionTicker(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("O:")) {
    throw new Error("Massive option ticker must use the O: prefix");
  }
  return normalizeInternalOptionSymbol(value.slice(2));
}

function normalizeInternalOptionSymbol(symbol: string): string {
  const normalized = symbol.replace(/\s+/g, "").toUpperCase();
  if (!parseOccSymbol(normalized)) throw new Error(`Invalid OCC option symbol ${symbol}`);
  return normalized;
}

function rawDataToString(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}
