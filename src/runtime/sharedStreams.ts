import { performance } from "node:perf_hooks";
import type {
  StockStream, StockStreamEvent, StockStreamHandlers,
} from "../alpaca/stockStream.js";
import type {
  OptionStream, OptionStreamActivity, OptionStreamEvent, OptionStreamHandlers,
} from "../alpaca/optionStream.js";
import type { MarketStreamTelemetry } from "../marketData/streamTelemetry.js";
import type { OpraQuoteObservation } from "../marketData/opraQuoteHealth.js";
import { parseOccSymbol } from "../options/occSymbol.js";
import type { OptionQuote, UnderlyingSymbol } from "../types.js";

export interface SharedStreamHubOptions {
  reconnectBaseMs?: number;
  reconnectMaximumMs?: number;
  maxPendingEventsPerChannel?: number;
  maxConsumerLagMs?: number;
  monotonicNow?: () => number;
}

export interface SharedOptionStreamHubOptions extends SharedStreamHubOptions {
  maxSubscriptions?: number;
}

interface PendingStockEvent {
  event: StockStreamEvent;
  enqueuedAt: number;
}

interface StockChannelState {
  active: boolean;
  failed: boolean;
  handlers: StockStreamHandlers | undefined;
  pending: PendingStockEvent[];
  dispatching: boolean;
  dispatchTail: Promise<void>;
  lastConsumerLagMs: number;
}

/** One reconnecting physical SIP connection with bounded, isolated per-underlying consumers. */
export class SharedStockStreamHub {
  readonly #physical: StockStream;
  readonly #channels = new Map<UnderlyingSymbol, StockChannelState>();
  readonly #reconnectBaseMs: number;
  readonly #reconnectMaximumMs: number;
  readonly #maxPendingEventsPerChannel: number;
  readonly #maxConsumerLagMs: number;
  readonly #monotonicNow: () => number;
  #connected = false;
  #connection: Promise<void> | undefined;
  #restartOperation: Promise<void> | undefined;
  #stopOperation: Promise<void> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectAttempt = 0;
  #generation = 0;

  constructor(
    physical: StockStream,
    underlyings: readonly UnderlyingSymbol[],
    options: SharedStreamHubOptions = {},
  ) {
    this.#physical = physical;
    this.#reconnectBaseMs = positiveInteger(options.reconnectBaseMs ?? 1_000, "SIP reconnectBaseMs");
    this.#reconnectMaximumMs = positiveInteger(options.reconnectMaximumMs ?? 30_000, "SIP reconnectMaximumMs");
    this.#maxPendingEventsPerChannel = positiveInteger(
      options.maxPendingEventsPerChannel ?? 50_000,
      "SIP maxPendingEventsPerChannel",
    );
    this.#maxConsumerLagMs = positiveInteger(options.maxConsumerLagMs ?? 500, "SIP maxConsumerLagMs");
    this.#monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
    for (const underlying of underlyings) {
      this.#channels.set(underlying, {
        active: false,
        failed: false,
        handlers: undefined,
        pending: [],
        dispatching: false,
        dispatchTail: Promise.resolve(),
        lastConsumerLagMs: 0,
      });
    }
  }

  channel(underlying: UnderlyingSymbol): StockStream {
    const state = this.#channels.get(underlying);
    if (!state) throw new Error(`${underlying} is not registered with the SIP hub`);
    return {
      reconnectManaged: true,
      connect: (handlers) => this.#connectChannel(underlying, handlers),
      close: () => this.#closeChannel(underlying),
      requestReconnect: (reason) => this.#requestReconnect(reason),
      telemetry: () => this.#stockTelemetry(state),
    };
  }

  async #connectChannel(underlying: UnderlyingSymbol, handlers: StockStreamHandlers): Promise<void> {
    await this.#stopOperation;
    await this.#restartOperation;
    const state = this.#channels.get(underlying)!;
    if (state.active) throw new Error(`${underlying} SIP channel is already connected`);
    state.active = true;
    state.failed = false;
    state.handlers = handlers;
    state.pending.length = 0;
    state.lastConsumerLagMs = 0;
    if (this.#connected) {
      handlers.onState?.(true);
      return;
    }
    try {
      await this.#ensureConnected();
    } catch (error) {
      this.#scheduleReconnect();
      throw error;
    }
  }

  async #closeChannel(underlying: UnderlyingSymbol): Promise<void> {
    const state = this.#channels.get(underlying)!;
    if (!state.active) return;
    state.active = false;
    state.pending.length = 0;
    state.handlers?.onState?.(false);
    await state.dispatchTail.catch(() => undefined);
    state.handlers = undefined;
    state.failed = false;
    if (this.#hasActiveChannels()) return;
    await this.#stopPhysical(false);
  }

  async #ensureConnected(): Promise<void> {
    if (this.#connected) return;
    if (this.#connection) return this.#connection;
    const generation = ++this.#generation;
    const connection = this.#physical.connect({
      onQuote: (quote) => this.#dispatch([{ type: "quote", value: quote }]),
      onTrade: (trade) => this.#dispatch([{ type: "trade", value: trade }]),
      onEvents: (events) => { this.#dispatch(events); },
      onState: (connected) => this.#onPhysicalState(generation, connected),
      onError: (error) => this.#broadcastError(error),
    });
    this.#connection = connection;
    try {
      await connection;
      if (generation !== this.#generation) throw new Error("SIP connection was superseded");
    } catch (error) {
      if (generation === this.#generation) {
        this.#connected = false;
        this.#connection = undefined;
      }
      throw error;
    }
  }

  #onPhysicalState(generation: number, connected: boolean): void {
    if (generation !== this.#generation) return;
    this.#connected = connected;
    if (connected) {
      this.#reconnectAttempt = 0;
      this.#cancelReconnect();
    } else {
      this.#connection = undefined;
    }
    for (const channel of this.#channels.values()) {
      if (channel.active && !channel.failed) channel.handlers?.onState?.(connected);
    }
    if (!connected) this.#scheduleReconnect();
  }

  #dispatch(events: readonly StockStreamEvent[]): void {
    const enqueuedAt = this.#monotonicNow();
    const grouped = new Map<UnderlyingSymbol, StockStreamEvent[]>();
    for (const event of events) {
      const state = this.#channels.get(event.value.symbol);
      if (!state?.active || state.failed || !state.handlers) continue;
      const values = grouped.get(event.value.symbol) ?? [];
      values.push(event);
      grouped.set(event.value.symbol, values);
    }
    for (const [underlying, values] of grouped) {
      this.#enqueueStock(this.#channels.get(underlying)!, values, enqueuedAt);
    }
  }

  #enqueueStock(state: StockChannelState, events: readonly StockStreamEvent[], enqueuedAt: number): void {
    const requestedSize = state.pending.length + events.length;
    if (requestedSize > this.#maxPendingEventsPerChannel) {
      state.failed = true;
      state.pending.length = 0;
      const error = new Error(
        `SIP channel pending-event limit exceeded (${requestedSize} > ` +
        `${this.#maxPendingEventsPerChannel}); channel failed closed`,
      );
      state.handlers?.onError?.(error);
      state.handlers?.onState?.(false);
      return;
    }
    state.pending.push(...events.map((event) => ({ event, enqueuedAt })));
    if (state.dispatching) return;
    state.dispatching = true;
    state.dispatchTail = Promise.resolve().then(() => this.#drainStock(state));
  }

  async #drainStock(state: StockChannelState): Promise<void> {
    try {
      while (state.active && !state.failed && state.pending.length > 0) {
        const pending = state.pending.splice(0);
        state.lastConsumerLagMs = Math.max(0, this.#monotonicNow() - pending[0]!.enqueuedAt);
        const handlers = state.handlers;
        if (!handlers) continue;
        const events = pending.map(({ event }) => event);
        if (handlers.onEvents) await handlers.onEvents(events);
        else {
          for (const event of events) {
            if (event.type === "quote") await handlers.onQuote(event.value);
            else await handlers.onTrade(event.value);
          }
        }
      }
    } catch (error) {
      state.failed = true;
      state.pending.length = 0;
      state.handlers?.onError?.(error);
      state.handlers?.onState?.(false);
    } finally {
      state.dispatching = false;
      if (state.active && !state.failed && state.pending.length > 0) this.#enqueueStock(state, [], this.#monotonicNow());
    }
  }

  #stockTelemetry(state: StockChannelState): MarketStreamTelemetry {
    const oldestAge = state.pending[0]
      ? Math.max(0, this.#monotonicNow() - state.pending[0].enqueuedAt)
      : 0;
    const consumerLagMs = Math.max(oldestAge, state.lastConsumerLagMs);
    return {
      pendingEvents: state.pending.length,
      maximumPendingEvents: this.#maxPendingEventsPerChannel,
      consumerLagMs,
      maximumConsumerLagMs: this.#maxConsumerLagMs,
      coalescedEvents: 0,
      overloaded: state.failed || consumerLagMs > this.#maxConsumerLagMs,
      reconnectAttempt: this.#reconnectAttempt,
    };
  }

  #scheduleReconnect(): void {
    if (!this.#hasActiveChannels() || this.#connected || this.#connection || this.#reconnectTimer || this.#restartOperation) return;
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

  #requestReconnect(reason?: string): Promise<void> {
    if (reason) this.#broadcastError(new Error(`SIP reconnect requested: ${reason}`));
    if (this.#restartOperation) return this.#restartOperation;
    this.#restartOperation = (async () => {
      this.#cancelReconnect();
      await this.#stopPhysical(true);
      if (!this.#hasActiveChannels()) return;
      try {
        await this.#ensureConnected();
      } catch (error) {
        this.#scheduleReconnect();
        throw error;
      }
    })().finally(() => {
      this.#restartOperation = undefined;
      this.#scheduleReconnect();
    });
    return this.#restartOperation;
  }

  async #stopPhysical(notify: boolean): Promise<void> {
    if (this.#stopOperation) return this.#stopOperation;
    this.#stopOperation = (async () => {
      this.#cancelReconnect();
      const connection = this.#connection;
      const wasConnected = this.#connected;
      this.#generation += 1;
      this.#connection = undefined;
      this.#connected = false;
      if (notify && wasConnected) {
        for (const channel of this.#channels.values()) {
          if (channel.active && !channel.failed) channel.handlers?.onState?.(false);
        }
      }
      await this.#physical.close().catch((error: unknown) => this.#broadcastError(error));
      await connection?.catch(() => undefined);
    })().finally(() => { this.#stopOperation = undefined; });
    return this.#stopOperation;
  }

  #cancelReconnect(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #hasActiveChannels(): boolean {
    return [...this.#channels.values()].some((channel) => channel.active);
  }

  #broadcastError(error: unknown): void {
    for (const channel of this.#channels.values()) {
      if (channel.active) channel.handlers?.onError?.(error);
    }
  }
}

interface PendingOptionQuote {
  quote: OptionQuote;
  enqueuedAt: number;
}

interface PendingOptionRawBatch {
  events: readonly OptionStreamEvent[];
  activity: OptionStreamActivity;
  enqueuedAt: number;
}

interface OptionChannelState {
  active: boolean;
  failed: boolean;
  desired: Set<string>;
  handlers: OptionStreamHandlers | undefined;
  pendingLatest: Map<string, PendingOptionQuote>;
  pendingRaw: PendingOptionRawBatch[];
  pendingObservations: OpraQuoteObservation[];
  pendingActivity: OptionStreamActivity | undefined;
  dispatching: boolean;
  dispatchTail: Promise<void>;
  lastConsumerLagMs: number;
  coalescedQuotes: number;
}

/** One reconnecting physical OPRA connection with budgeted union subscriptions and isolated consumers. */
export class SharedOptionStreamHub {
  readonly #physical: OptionStream;
  readonly #channels = new Map<UnderlyingSymbol, OptionChannelState>();
  readonly #applied = new Set<string>();
  readonly #maxSubscriptions: number;
  readonly #reconnectBaseMs: number;
  readonly #reconnectMaximumMs: number;
  readonly #maxPendingEventsPerChannel: number;
  readonly #maxConsumerLagMs: number;
  readonly #monotonicNow: () => number;
  #connected = false;
  #connection: Promise<void> | undefined;
  #restartOperation: Promise<void> | undefined;
  #stopOperation: Promise<void> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectAttempt = 0;
  #generation = 0;
  #reconcileTail: Promise<void> = Promise.resolve();

  constructor(
    physical: OptionStream,
    underlyings: readonly UnderlyingSymbol[],
    options: SharedOptionStreamHubOptions = {},
  ) {
    this.#physical = physical;
    this.#maxSubscriptions = positiveInteger(options.maxSubscriptions ?? 900, "OPRA maxSubscriptions");
    this.#reconnectBaseMs = positiveInteger(options.reconnectBaseMs ?? 1_000, "OPRA reconnectBaseMs");
    this.#reconnectMaximumMs = positiveInteger(options.reconnectMaximumMs ?? 30_000, "OPRA reconnectMaximumMs");
    this.#maxPendingEventsPerChannel = positiveInteger(
      options.maxPendingEventsPerChannel ?? 50_000,
      "OPRA maxPendingEventsPerChannel",
    );
    this.#maxConsumerLagMs = positiveInteger(options.maxConsumerLagMs ?? 500, "OPRA maxConsumerLagMs");
    this.#monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
    for (const underlying of underlyings) {
      this.#channels.set(underlying, {
        active: false,
        failed: false,
        desired: new Set(),
        handlers: undefined,
        pendingLatest: new Map(),
        pendingRaw: [],
        pendingObservations: [],
        pendingActivity: undefined,
        dispatching: false,
        dispatchTail: Promise.resolve(),
        lastConsumerLagMs: 0,
        coalescedQuotes: 0,
      });
    }
  }

  channel(underlying: UnderlyingSymbol): OptionStream {
    const state = this.#channels.get(underlying);
    if (!state) throw new Error(`${underlying} is not registered with the OPRA hub`);
    return {
      reconnectManaged: true,
      subscribe: (symbols) => this.#updateDesired(underlying, "subscribe", symbols),
      unsubscribe: (symbols) => this.#updateDesired(underlying, "unsubscribe", symbols),
      connect: (handlers) => this.#connectChannel(underlying, handlers),
      close: () => this.#closeChannel(underlying),
      requestReconnect: (reason) => this.#requestReconnect(reason),
      telemetry: () => this.#optionTelemetry(state),
    };
  }

  async #connectChannel(underlying: UnderlyingSymbol, handlers: OptionStreamHandlers): Promise<void> {
    await this.#stopOperation;
    await this.#restartOperation;
    const state = this.#channels.get(underlying)!;
    if (state.active) throw new Error(`${underlying} OPRA channel is already connected`);
    state.active = true;
    state.failed = false;
    state.handlers = handlers;
    state.pendingLatest.clear();
    state.pendingRaw.length = 0;
    state.pendingObservations.length = 0;
    state.pendingActivity = undefined;
    state.lastConsumerLagMs = 0;
    if (this.#connected) handlers.onState?.(true);
    else {
      try {
        await this.#ensureConnected();
      } catch (error) {
        this.#scheduleReconnect();
        throw error;
      }
    }
    await this.#queueReconcile();
  }

  async #closeChannel(underlying: UnderlyingSymbol): Promise<void> {
    const state = this.#channels.get(underlying)!;
    if (!state.active) return;
    state.active = false;
    state.pendingLatest.clear();
    state.pendingRaw.length = 0;
    state.pendingObservations.length = 0;
    state.pendingActivity = undefined;
    state.handlers?.onState?.(false);
    await state.dispatchTail.catch(() => undefined);
    state.handlers = undefined;
    state.failed = false;
    await this.#queueReconcile();
    if (this.#hasActiveChannels()) return;
    await this.#stopPhysical(false);
  }

  async #updateDesired(
    underlying: UnderlyingSymbol,
    action: "subscribe" | "unsubscribe",
    symbols: readonly string[],
  ): Promise<void> {
    const state = this.#channels.get(underlying)!;
    const next = new Set(state.desired);
    for (const symbol of new Set(symbols)) {
      const parsed = parseOccSymbol(symbol);
      if (!parsed || parsed.underlying !== underlying) {
        throw new Error(`${underlying} OPRA channel rejected cross-underlying or invalid contract ${symbol}`);
      }
      if (action === "subscribe") next.add(symbol);
      else next.delete(symbol);
    }
    const union = new Set<string>();
    for (const [candidateUnderlying, channel] of this.#channels) {
      for (const symbol of candidateUnderlying === underlying ? next : channel.desired) union.add(symbol);
    }
    if (union.size > this.#maxSubscriptions) {
      throw new Error(
        `OPRA subscription budget exceeded: requested ${union.size} unique contracts, ` +
        `configured maximum ${this.#maxSubscriptions}`,
      );
    }
    state.desired = next;
    await this.#queueReconcile();
  }

  async #ensureConnected(): Promise<void> {
    if (this.#connected) return;
    if (this.#connection) return this.#connection;
    const generation = ++this.#generation;
    const connection = this.#physical.connect({
      onQuote: (quote) => this.#dispatch([quote]),
      onQuotes: (quotes) => { this.#dispatch(quotes); },
      onRawEvents: (events, activity) => this.#dispatchRawEvents(events, activity),
      onActivity: (activity) => this.#dispatchActivity(activity),
      onQuoteObservations: (observations) => this.#dispatchObservations(observations),
      onState: (connected) => this.#onPhysicalState(generation, connected),
      onSubscriptions: (symbols) => {
        if (generation !== this.#generation) return;
        this.#applied.clear();
        for (const symbol of symbols) this.#applied.add(symbol);
        for (const channel of this.#channels.values()) {
          if (!channel.active || channel.failed || !channel.handlers?.onSubscriptions) continue;
          channel.handlers.onSubscriptions(symbols.filter((symbol) => channel.desired.has(symbol)));
        }
      },
      onError: (error) => this.#broadcastError(error),
    });
    this.#connection = connection;
    try {
      await connection;
      if (generation !== this.#generation) throw new Error("OPRA connection was superseded");
    } catch (error) {
      if (generation === this.#generation) {
        this.#connected = false;
        this.#connection = undefined;
        this.#applied.clear();
      }
      throw error;
    }
  }

  #onPhysicalState(generation: number, connected: boolean): void {
    if (generation !== this.#generation) return;
    this.#connected = connected;
    if (connected) {
      this.#reconnectAttempt = 0;
      this.#cancelReconnect();
    } else {
      this.#connection = undefined;
      this.#applied.clear();
    }
    for (const channel of this.#channels.values()) {
      if (channel.active && !channel.failed) channel.handlers?.onState?.(connected);
    }
    if (!connected) this.#scheduleReconnect();
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
      if (channel.active && !channel.failed) for (const symbol of channel.desired) target.add(symbol);
    }
    const remove = [...this.#applied].filter((symbol) => !target.has(symbol));
    const add = [...target].filter((symbol) => !this.#applied.has(symbol));
    if (remove.length > 0) await this.#physical.unsubscribe(remove);
    if (add.length > 0) await this.#physical.subscribe(add);
    for (const symbol of remove) this.#applied.delete(symbol);
    for (const symbol of add) this.#applied.add(symbol);
  }

  #dispatch(quotes: readonly OptionQuote[]): void {
    const enqueuedAt = this.#monotonicNow();
    for (const channel of this.#channels.values()) {
      if (!channel.active || channel.failed || !channel.handlers) continue;
      const scoped = quotes.filter((quote) => channel.desired.has(quote.symbol));
      if (scoped.length > 0) this.#enqueueOptions(channel, scoped, enqueuedAt);
    }
  }

  #enqueueOptions(state: OptionChannelState, quotes: readonly OptionQuote[], enqueuedAt: number): void {
    for (const quote of quotes) {
      const pending = state.pendingLatest.get(quote.symbol);
      if (pending && quote.timestamp >= pending.quote.timestamp) state.coalescedQuotes += 1;
      if (!pending || quote.timestamp >= pending.quote.timestamp) {
        state.pendingLatest.set(quote.symbol, { quote, enqueuedAt: pending?.enqueuedAt ?? enqueuedAt });
      }
    }
    if (!this.#validateOptionCapacity(state)) return;
    this.#scheduleOptionDrain(state);
  }

  async #drainOptions(state: OptionChannelState): Promise<void> {
    try {
      while (state.active && !state.failed && this.#pendingOptionWork(state) > 0) {
        const activity = state.pendingActivity;
        state.pendingActivity = undefined;
        const rawBatches = state.pendingRaw.splice(0);
        const observations = state.pendingObservations.splice(0);
        const pending = [...state.pendingLatest.values()]
          .sort((left, right) => left.quote.timestamp - right.quote.timestamp ||
            left.quote.symbol.localeCompare(right.quote.symbol));
        state.pendingLatest.clear();
        const enqueueTimes = [
          ...rawBatches.map(({ enqueuedAt: timestamp }) => timestamp),
          ...observations.map(({ receiveMonotonicTimestamp }) => receiveMonotonicTimestamp),
          ...pending.map(({ enqueuedAt: timestamp }) => timestamp),
          ...(activity ? [activity.receiveMonotonicTimestamp] : []),
        ];
        if (enqueueTimes.length > 0) {
          state.lastConsumerLagMs = Math.max(0, this.#monotonicNow() - Math.min(...enqueueTimes));
        }
        const handlers = state.handlers;
        if (!handlers) continue;
        if (activity) handlers.onActivity?.(activity);
        if (handlers.onRawEvents) {
          for (const batch of rawBatches) handlers.onRawEvents(batch.events, batch.activity);
        }
        if (observations.length > 0) handlers.onQuoteObservations?.(observations);
        const quotes = pending.map(({ quote }) => quote);
        if (quotes.length > 0) {
          if (handlers.onQuotes) await handlers.onQuotes(quotes);
          else for (const quote of quotes) await handlers.onQuote(quote);
        }
      }
    } catch (error) {
      state.failed = true;
      state.pendingLatest.clear();
      state.pendingRaw.length = 0;
      state.pendingObservations.length = 0;
      state.pendingActivity = undefined;
      state.handlers?.onError?.(error);
      state.handlers?.onState?.(false);
      void this.#queueReconcile().catch((reconcileError: unknown) => state.handlers?.onError?.(reconcileError));
    } finally {
      state.dispatching = false;
      if (state.active && !state.failed && this.#pendingOptionWork(state) > 0) this.#scheduleOptionDrain(state);
    }
  }

  #dispatchRawEvents(events: readonly OptionStreamEvent[], activity: OptionStreamActivity): void {
    const enqueuedAt = this.#monotonicNow();
    for (const channel of this.#channels.values()) {
      if (!channel.active || channel.failed || !channel.handlers) continue;
      const scoped = events.filter((event) => channel.desired.has(event.value.symbol));
      if (scoped.length === 0) continue;
      channel.pendingRaw.push({ events: scoped, activity, enqueuedAt });
      if (!this.#validateOptionCapacity(channel)) continue;
      this.#scheduleOptionDrain(channel);
    }
  }

  #dispatchActivity(activity: OptionStreamActivity): void {
    for (const channel of this.#channels.values()) {
      if (!channel.active || channel.failed || !channel.handlers) continue;
      channel.pendingActivity = activity;
      this.#scheduleOptionDrain(channel);
    }
  }

  #dispatchObservations(observations: readonly OpraQuoteObservation[]): void {
    for (const channel of this.#channels.values()) {
      if (!channel.active || channel.failed || !channel.handlers) continue;
      const scoped = observations.filter((observation) => channel.desired.has(observation.quote.symbol));
      if (scoped.length === 0) continue;
      channel.pendingObservations.push(...scoped);
      if (!this.#validateOptionCapacity(channel)) continue;
      this.#scheduleOptionDrain(channel);
    }
  }

  #scheduleOptionDrain(state: OptionChannelState): void {
    if (state.dispatching || state.failed) return;
    state.dispatching = true;
    state.dispatchTail = Promise.resolve().then(() => this.#drainOptions(state));
  }

  #validateOptionCapacity(state: OptionChannelState): boolean {
    const size = this.#pendingOptionDataEvents(state);
    if (size <= this.#maxPendingEventsPerChannel) return true;
    state.failed = true;
    state.pendingLatest.clear();
    state.pendingRaw.length = 0;
    state.pendingObservations.length = 0;
    state.pendingActivity = undefined;
    const error = new Error(
      `OPRA channel pending-event limit exceeded (${size} > ${this.#maxPendingEventsPerChannel}); ` +
      "channel failed closed",
    );
    state.handlers?.onError?.(error);
    state.handlers?.onState?.(false);
    void this.#queueReconcile().catch((reconcileError: unknown) => state.handlers?.onError?.(reconcileError));
    return false;
  }

  #pendingOptionWork(state: OptionChannelState): number {
    return state.pendingLatest.size + state.pendingRaw.reduce((total, batch) => total + batch.events.length, 0) +
      state.pendingObservations.length + (state.pendingActivity ? 1 : 0);
  }

  #pendingOptionDataEvents(state: OptionChannelState): number {
    // Raw events, observations, and executable quotes are parallel views of the
    // same upstream frames. Bound the largest view instead of triple-counting a
    // quote while still preventing any individual queue from growing without limit.
    return Math.max(
      state.pendingLatest.size,
      state.pendingObservations.length,
      state.pendingRaw.reduce((total, batch) => total + batch.events.length, 0),
    );
  }

  #oldestOptionEnqueueTime(state: OptionChannelState): number | undefined {
    const times = [
      ...[...state.pendingLatest.values()].map(({ enqueuedAt }) => enqueuedAt),
      ...state.pendingRaw.map(({ enqueuedAt }) => enqueuedAt),
      ...state.pendingObservations.map(({ receiveMonotonicTimestamp }) => receiveMonotonicTimestamp),
      ...(state.pendingActivity ? [state.pendingActivity.receiveMonotonicTimestamp] : []),
    ];
    return times.length > 0 ? Math.min(...times) : undefined;
  }

  #optionTelemetry(state: OptionChannelState): MarketStreamTelemetry {
    const oldest = this.#oldestOptionEnqueueTime(state);
    const oldestAge = oldest === undefined ? 0 : Math.max(0, this.#monotonicNow() - oldest);
    const consumerLagMs = Math.max(oldestAge, state.lastConsumerLagMs);
    return {
      pendingEvents: this.#pendingOptionDataEvents(state),
      maximumPendingEvents: this.#maxPendingEventsPerChannel,
      consumerLagMs,
      maximumConsumerLagMs: this.#maxConsumerLagMs,
      coalescedEvents: state.coalescedQuotes,
      overloaded: state.failed || consumerLagMs > this.#maxConsumerLagMs,
      reconnectAttempt: this.#reconnectAttempt,
    };
  }

  #scheduleReconnect(): void {
    if (!this.#hasActiveChannels() || this.#connected || this.#connection || this.#reconnectTimer || this.#restartOperation) return;
    this.#reconnectAttempt += 1;
    const delay = Math.min(
      this.#reconnectMaximumMs,
      this.#reconnectBaseMs * (2 ** Math.max(0, this.#reconnectAttempt - 1)),
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#ensureConnected().then(() => this.#queueReconcile()).catch((error: unknown) => {
        this.#broadcastError(error);
        this.#scheduleReconnect();
      });
    }, delay);
  }

  #requestReconnect(reason?: string): Promise<void> {
    if (reason) this.#broadcastError(new Error(`OPRA reconnect requested: ${reason}`));
    if (this.#restartOperation) return this.#restartOperation;
    this.#restartOperation = (async () => {
      this.#cancelReconnect();
      await this.#stopPhysical(true);
      if (!this.#hasActiveChannels()) return;
      try {
        await this.#ensureConnected();
        await this.#queueReconcile();
      } catch (error) {
        this.#scheduleReconnect();
        throw error;
      }
    })().finally(() => {
      this.#restartOperation = undefined;
      this.#scheduleReconnect();
    });
    return this.#restartOperation;
  }

  async #stopPhysical(notify: boolean): Promise<void> {
    if (this.#stopOperation) return this.#stopOperation;
    this.#stopOperation = (async () => {
      this.#cancelReconnect();
      const connection = this.#connection;
      const wasConnected = this.#connected;
      this.#generation += 1;
      this.#connection = undefined;
      this.#connected = false;
      this.#applied.clear();
      if (notify && wasConnected) {
        for (const channel of this.#channels.values()) {
          if (channel.active && !channel.failed) channel.handlers?.onState?.(false);
        }
      }
      await this.#physical.close().catch((error: unknown) => this.#broadcastError(error));
      await connection?.catch(() => undefined);
    })().finally(() => { this.#stopOperation = undefined; });
    return this.#stopOperation;
  }

  #cancelReconnect(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #hasActiveChannels(): boolean {
    return [...this.#channels.values()].some((channel) => channel.active);
  }

  #broadcastError(error: unknown): void {
    for (const channel of this.#channels.values()) {
      if (channel.active) channel.handlers?.onError?.(error);
    }
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}
