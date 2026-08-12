import type {
  StockStream, StockStreamEvent, StockStreamHandlers,
} from "../alpaca/stockStream.js";
import type { OptionStream, OptionStreamHandlers } from "../alpaca/optionStream.js";
import type { OptionQuote, UnderlyingSymbol } from "../types.js";

interface StockChannelState {
  active: boolean;
  handlers: StockStreamHandlers | undefined;
}

/** One physical SIP connection, with causally isolated per-underlying consumers. */
export class SharedStockStreamHub {
  readonly #physical: StockStream;
  readonly #channels = new Map<UnderlyingSymbol, StockChannelState>();
  #connected = false;
  #connection: Promise<void> | undefined;

  constructor(physical: StockStream, underlyings: readonly UnderlyingSymbol[]) {
    this.#physical = physical;
    for (const underlying of underlyings) this.#channels.set(underlying, { active: false, handlers: undefined });
  }

  channel(underlying: UnderlyingSymbol): StockStream {
    if (!this.#channels.has(underlying)) throw new Error(`${underlying} is not registered with the SIP hub`);
    return {
      connect: (handlers) => this.#connectChannel(underlying, handlers),
      close: () => this.#closeChannel(underlying),
    };
  }

  async #connectChannel(underlying: UnderlyingSymbol, handlers: StockStreamHandlers): Promise<void> {
    const state = this.#channels.get(underlying)!;
    if (state.active) throw new Error(`${underlying} SIP channel is already connected`);
    state.active = true;
    state.handlers = handlers;
    if (this.#connected) {
      handlers.onState?.(true);
      return;
    }
    await this.#ensureConnected();
  }

  async #closeChannel(underlying: UnderlyingSymbol): Promise<void> {
    const state = this.#channels.get(underlying)!;
    if (!state.active) return;
    state.active = false;
    state.handlers?.onState?.(false);
    state.handlers = undefined;
    if ([...this.#channels.values()].some((channel) => channel.active)) return;
    await this.#connection?.catch(() => undefined);
    await this.#physical.close();
    this.#connected = false;
    this.#connection = undefined;
  }

  async #ensureConnected(): Promise<void> {
    if (this.#connected) return;
    this.#connection ??= this.#physical.connect({
      onQuote: (quote) => this.#dispatch([{ type: "quote", value: quote }]),
      onTrade: (trade) => this.#dispatch([{ type: "trade", value: trade }]),
      onEvents: (events) => this.#dispatch(events),
      onState: (connected) => {
        this.#connected = connected;
        if (!connected) this.#connection = undefined;
        for (const channel of this.#channels.values()) {
          if (channel.active) channel.handlers?.onState?.(connected);
        }
      },
      onError: (error) => {
        for (const channel of this.#channels.values()) {
          if (channel.active) channel.handlers?.onError?.(error);
        }
      },
    });
    try {
      await this.#connection;
    } catch (error) {
      this.#connection = undefined;
      throw error;
    }
  }

  async #dispatch(events: readonly StockStreamEvent[]): Promise<void> {
    await Promise.all([...this.#channels.entries()].map(async ([underlying, channel]) => {
      if (!channel.active || !channel.handlers) return;
      const scoped = events.filter((event) => event.value.symbol === underlying);
      if (scoped.length === 0) return;
      try {
        if (channel.handlers.onEvents) {
          await channel.handlers.onEvents(scoped);
          return;
        }
        for (const event of scoped) {
          if (event.type === "quote") await channel.handlers.onQuote(event.value);
          else await channel.handlers.onTrade(event.value);
        }
      } catch (error) {
        channel.handlers.onError?.(error);
      }
    }));
  }
}

interface OptionChannelState {
  active: boolean;
  desired: Set<string>;
  handlers: OptionStreamHandlers | undefined;
}

/** One physical OPRA connection with unioned subscriptions and per-runtime quote routing. */
export class SharedOptionStreamHub {
  readonly #physical: OptionStream;
  readonly #channels = new Map<UnderlyingSymbol, OptionChannelState>();
  readonly #applied = new Set<string>();
  #connected = false;
  #connection: Promise<void> | undefined;
  #reconcileTail: Promise<void> = Promise.resolve();

  constructor(physical: OptionStream, underlyings: readonly UnderlyingSymbol[]) {
    this.#physical = physical;
    for (const underlying of underlyings) {
      this.#channels.set(underlying, { active: false, desired: new Set(), handlers: undefined });
    }
  }

  channel(underlying: UnderlyingSymbol): OptionStream {
    if (!this.#channels.has(underlying)) throw new Error(`${underlying} is not registered with the OPRA hub`);
    return {
      subscribe: (symbols) => this.#updateDesired(underlying, "subscribe", symbols),
      unsubscribe: (symbols) => this.#updateDesired(underlying, "unsubscribe", symbols),
      connect: (handlers) => this.#connectChannel(underlying, handlers),
      close: () => this.#closeChannel(underlying),
    };
  }

  async #connectChannel(underlying: UnderlyingSymbol, handlers: OptionStreamHandlers): Promise<void> {
    const state = this.#channels.get(underlying)!;
    if (state.active) throw new Error(`${underlying} OPRA channel is already connected`);
    state.active = true;
    state.handlers = handlers;
    if (this.#connected) handlers.onState?.(true);
    else await this.#ensureConnected();
    await this.#queueReconcile();
  }

  async #closeChannel(underlying: UnderlyingSymbol): Promise<void> {
    const state = this.#channels.get(underlying)!;
    if (!state.active) return;
    state.active = false;
    state.handlers?.onState?.(false);
    state.handlers = undefined;
    await this.#queueReconcile();
    if ([...this.#channels.values()].some((channel) => channel.active)) return;
    await this.#connection?.catch(() => undefined);
    await this.#physical.close();
    this.#connected = false;
    this.#connection = undefined;
    this.#applied.clear();
  }

  async #updateDesired(
    underlying: UnderlyingSymbol, action: "subscribe" | "unsubscribe", symbols: readonly string[],
  ): Promise<void> {
    const state = this.#channels.get(underlying)!;
    for (const symbol of new Set(symbols)) {
      if (action === "subscribe") state.desired.add(symbol);
      else state.desired.delete(symbol);
    }
    await this.#queueReconcile();
  }

  async #ensureConnected(): Promise<void> {
    if (this.#connected) return;
    this.#connection ??= this.#physical.connect({
      onQuote: (quote) => this.#dispatch([quote]),
      onQuotes: (quotes) => this.#dispatch(quotes),
      onActivity: (activity) => {
        for (const channel of this.#channels.values()) {
          if (!channel.active || !channel.handlers?.onActivity) continue;
          try { channel.handlers.onActivity(activity); }
          catch (error) { channel.handlers.onError?.(error); }
        }
      },
      onQuoteObservations: (observations) => {
        for (const channel of this.#channels.values()) {
          if (!channel.active || !channel.handlers?.onQuoteObservations) continue;
          const scoped = observations.filter((observation) => channel.desired.has(observation.quote.symbol));
          if (scoped.length === 0) continue;
          try { channel.handlers.onQuoteObservations(scoped); }
          catch (error) { channel.handlers.onError?.(error); }
        }
      },
      onRawEvents: (events, activity) => {
        for (const channel of this.#channels.values()) {
          if (!channel.active || !channel.handlers?.onRawEvents) continue;
          const scoped = events.filter((event) => channel.desired.has(event.value.symbol));
          if (scoped.length === 0) continue;
          try { channel.handlers.onRawEvents(scoped, activity); }
          catch (error) { channel.handlers.onError?.(error); }
        }
      },
      onState: (connected) => {
        this.#connected = connected;
        if (!connected) {
          this.#connection = undefined;
          this.#applied.clear();
        }
        for (const channel of this.#channels.values()) {
          if (channel.active) channel.handlers?.onState?.(connected);
        }
      },
      onSubscriptions: (symbols) => {
        for (const channel of this.#channels.values()) {
          if (!channel.active || !channel.handlers?.onSubscriptions) continue;
          channel.handlers.onSubscriptions(symbols.filter((symbol) => channel.desired.has(symbol)));
        }
      },
      onError: (error) => {
        for (const channel of this.#channels.values()) {
          if (channel.active) channel.handlers?.onError?.(error);
        }
      },
    });
    try {
      await this.#connection;
    } catch (error) {
      this.#connection = undefined;
      throw error;
    }
  }

  #queueReconcile(): Promise<void> {
    const operation = this.#reconcileTail.then(() => this.#reconcile());
    this.#reconcileTail = operation.catch(() => undefined);
    return operation;
  }

  async #reconcile(): Promise<void> {
    if (!this.#connected) return;
    const target = new Set<string>();
    for (const channel of this.#channels.values()) {
      if (channel.active) for (const symbol of channel.desired) target.add(symbol);
    }
    const remove = [...this.#applied].filter((symbol) => !target.has(symbol));
    const add = [...target].filter((symbol) => !this.#applied.has(symbol));
    if (remove.length > 0) await this.#physical.unsubscribe(remove);
    if (add.length > 0) await this.#physical.subscribe(add);
    for (const symbol of remove) this.#applied.delete(symbol);
    for (const symbol of add) this.#applied.add(symbol);
  }

  async #dispatch(quotes: readonly OptionQuote[]): Promise<void> {
    await Promise.all([...this.#channels.values()].map(async (channel) => {
      if (!channel.active || !channel.handlers) return;
      const scoped = quotes.filter((quote) => channel.desired.has(quote.symbol));
      if (scoped.length === 0) return;
      try {
        if (channel.handlers.onQuotes) await channel.handlers.onQuotes(scoped);
        else for (const quote of scoped) await channel.handlers.onQuote(quote);
      } catch (error) {
        channel.handlers.onError?.(error);
      }
    }));
  }
}
