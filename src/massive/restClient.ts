import {
  isUnderlyingSymbol,
  type AccountState, type OptionContract, type OptionQuote, type OptionSnapshot, type StockQuote,
  type UnderlyingSymbol,
} from "../types.js";
import type {
  BrokerOrder, BrokerOrderRequest, BrokerPosition, MultiUnderlyingTradingRestClient,
} from "../alpaca/restClient.js";
import { parseOccSymbol } from "../options/occSymbol.js";
import { fromMassiveOptionTicker } from "./optionStream.js";

export interface MassiveOptionRestConfig {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  underlyings?: readonly UnderlyingSymbol[];
}

interface MassivePage {
  results?: Array<Record<string, unknown>>;
  next_url?: string;
  request_id?: string;
  status?: string;
}

/** Massive option snapshots and quotes; executable orders remain outside this adapter. */
export class MassiveOptionRestClient {
  readonly #apiKey: string;
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #underlyings: ReadonlySet<UnderlyingSymbol>;

  constructor(config: MassiveOptionRestConfig) {
    if (!config.apiKey) throw new Error("Massive option REST client requires an API key");
    this.#apiKey = config.apiKey;
    this.#baseUrl = new URL(config.baseUrl ?? "https://api.massive.com");
    this.#fetch = config.fetch ?? fetch;
    this.#underlyings = new Set(config.underlyings ?? ["SPY"]);
  }

  async getOptionSnapshots(symbols: readonly string[]): Promise<OptionSnapshot[]> {
    const items = await this.#getChainItems(symbols);
    return items.map((item) => adaptMassiveOptionSnapshot(item));
  }

  async getLatestOptionQuotes(symbols: readonly string[]): Promise<OptionQuote[]> {
    const items = await this.#getChainItems(symbols);
    return items.flatMap((item) => {
      const quote = adaptMassiveSnapshotQuote(item);
      return quote ? [quote] : [];
    });
  }

  async #getChainItems(symbols: readonly string[]): Promise<Array<Record<string, unknown>>> {
    const target = new Set(symbols);
    const groups = new Map<string, { underlying: UnderlyingSymbol; expirationDate: string; strikes: number[] }>();
    for (const symbol of target) {
      const parsed = parseOccSymbol(symbol);
      if (!parsed || !isUnderlyingSymbol(parsed.underlying)) {
        throw new Error(`Massive option data rejected invalid symbol ${symbol}`);
      }
      const underlying = parsed.underlying;
      if (!this.#underlyings.has(underlying)) {
        throw new Error(`${underlying} is not enabled at the Massive option-data boundary`);
      }
      const key = `${underlying}:${parsed.expirationDate}`;
      const group = groups.get(key) ?? { underlying, expirationDate: parsed.expirationDate, strikes: [] };
      group.strikes.push(parsed.strike);
      groups.set(key, group);
    }

    const matches = new Map<string, Record<string, unknown>>();
    await Promise.all([...groups.values()].map(async (group) => {
      const query = new URLSearchParams({
        expiration_date: group.expirationDate,
        "strike_price.gte": String(Math.min(...group.strikes)),
        "strike_price.lte": String(Math.max(...group.strikes)),
        order: "asc",
        limit: "250",
        sort: "ticker",
      });
      const items = await this.#requestAll(
        `/v3/snapshot/options/${encodeURIComponent(group.underlying)}?${query}`,
      );
      for (const item of items) {
        const details = asRecord(item.details);
        const rawTicker = details?.ticker ?? item.ticker;
        if (typeof rawTicker !== "string") continue;
        const symbol = fromMassiveOptionTicker(rawTicker);
        if (target.has(symbol)) matches.set(symbol, item);
      }
    }));
    return [...target].flatMap((symbol) => {
      const item = matches.get(symbol);
      return item ? [item] : [];
    });
  }

  async #requestAll(path: string): Promise<Array<Record<string, unknown>>> {
    const results: Array<Record<string, unknown>> = [];
    let next: URL | undefined = new URL(path, this.#baseUrl);
    while (next) {
      if (next.origin !== this.#baseUrl.origin) throw new Error("Massive pagination returned an unexpected origin");
      const response = await this.#fetch(next, {
        headers: { authorization: `Bearer ${this.#apiKey}`, accept: "application/json" },
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Massive HTTP ${response.status} request_id=${response.headers.get("x-request-id") ?? "unknown"}: ` +
          body.slice(0, 500),
        );
      }
      const page = await response.json() as MassivePage;
      if (page.status && page.status !== "OK") {
        throw new Error(`Massive option request failed with status ${page.status}`);
      }
      results.push(...(page.results ?? []));
      next = page.next_url ? new URL(page.next_url, this.#baseUrl) : undefined;
    }
    return results;
  }
}

/** Uses Massive for OPRA-derived state and Alpaca for contracts, SIP, account, and execution. */
export class MassiveAlpacaTradingRestClient implements MultiUnderlyingTradingRestClient {
  readonly #alpaca: MultiUnderlyingTradingRestClient;
  readonly #massive: MassiveOptionRestClient;

  constructor(alpaca: MultiUnderlyingTradingRestClient, massive: MassiveOptionRestClient) {
    this.#alpaca = alpaca;
    this.#massive = massive;
  }

  getAccount(): Promise<AccountState> { return this.#alpaca.getAccount(); }
  getMarketClock(): Promise<{ timestamp: number; isOpen: boolean }> { return this.#alpaca.getMarketClock(); }
  getLatestUnderlyingSipQuote(underlying: UnderlyingSymbol): Promise<StockQuote> {
    return this.#alpaca.getLatestUnderlyingSipQuote(underlying);
  }
  listOptionContracts(underlying?: UnderlyingSymbol): Promise<OptionContract[]> {
    return this.#alpaca.listOptionContracts(underlying);
  }
  getOptionSnapshots(symbols: readonly string[]): Promise<OptionSnapshot[]> {
    return this.#massive.getOptionSnapshots(symbols);
  }
  getLatestOptionQuotes(symbols: readonly string[]): Promise<OptionQuote[]> {
    return this.#massive.getLatestOptionQuotes(symbols);
  }
  submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder> { return this.#alpaca.submitOrder(request); }
  getOrder(orderId: string): Promise<BrokerOrder> { return this.#alpaca.getOrder(orderId); }
  getOrderByClientOrderId(clientOrderId: string): Promise<BrokerOrder> {
    return this.#alpaca.getOrderByClientOrderId(clientOrderId);
  }
  replaceOrder(orderId: string, limitPrice: number): Promise<BrokerOrder> {
    return this.#alpaca.replaceOrder(orderId, limitPrice);
  }
  cancelOrder(orderId: string): Promise<void> { return this.#alpaca.cancelOrder(orderId); }
  listOpenOrders(): Promise<BrokerOrder[]> { return this.#alpaca.listOpenOrders(); }
  listPositions(): Promise<BrokerPosition[]> { return this.#alpaca.listPositions(); }
}

export function adaptMassiveOptionSnapshot(item: Record<string, unknown>): OptionSnapshot {
  const details = asRecord(item.details);
  const ticker = details?.ticker ?? item.ticker;
  const symbol = fromMassiveOptionTicker(ticker);
  const quote = asRecord(item.last_quote);
  assertRealTimeQuote(symbol, quote);
  const greeks = asRecord(item.greeks);
  const day = asRecord(item.day);
  const timestamp = optionalUnixTimestampMs(quote?.last_updated);
  return {
    symbol,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(finiteNumber(item.implied_volatility) !== undefined
      ? { impliedVolatility: finiteNumber(item.implied_volatility)! } : {}),
    ...(greeks ? { greeks: {
      ...(finiteNumber(greeks.delta) !== undefined ? { delta: finiteNumber(greeks.delta)! } : {}),
      ...(finiteNumber(greeks.gamma) !== undefined ? { gamma: finiteNumber(greeks.gamma)! } : {}),
      ...(finiteNumber(greeks.theta) !== undefined ? { theta: finiteNumber(greeks.theta)! } : {}),
      ...(finiteNumber(greeks.vega) !== undefined ? { vega: finiteNumber(greeks.vega)! } : {}),
    } } : {}),
    ...(finiteNumber(day?.volume) !== undefined ? { dailyVolume: finiteNumber(day?.volume)! } : {}),
    ...(finiteNumber(item.open_interest) !== undefined ? { openInterest: finiteNumber(item.open_interest)! } : {}),
  };
}

export function adaptMassiveSnapshotQuote(item: Record<string, unknown>): OptionQuote | undefined {
  const details = asRecord(item.details);
  const ticker = details?.ticker ?? item.ticker;
  const symbol = fromMassiveOptionTicker(ticker);
  const quote = asRecord(item.last_quote);
  if (!quote) return undefined;
  assertRealTimeQuote(symbol, quote);
  const timestamp = optionalUnixTimestampMs(quote.last_updated);
  const bidPrice = finiteNumber(quote.bid);
  const askPrice = finiteNumber(quote.ask);
  const bidSize = finiteNumber(quote.bid_size);
  const askSize = finiteNumber(quote.ask_size);
  if ([timestamp, bidPrice, askPrice, bidSize, askSize].some((value) => value === undefined)) {
    throw new Error(`Invalid Massive latest option quote payload for ${symbol}`);
  }
  return {
    symbol,
    timestamp: timestamp!,
    bidPrice: bidPrice!,
    askPrice: askPrice!,
    bidSize: bidSize!,
    askSize: askSize!,
    ...(quote.bid_exchange !== undefined ? { bidExchange: String(quote.bid_exchange) } : {}),
    ...(quote.ask_exchange !== undefined ? { askExchange: String(quote.ask_exchange) } : {}),
  };
}

function assertRealTimeQuote(symbol: string, quote: Record<string, unknown> | undefined): void {
  if (quote?.timeframe !== undefined && quote.timeframe !== "REAL-TIME") {
    throw new Error(`Massive returned non-real-time option data for ${symbol}`);
  }
}

function optionalUnixTimestampMs(value: unknown): number | undefined {
  const timestamp = finiteNumber(value);
  if (timestamp === undefined) return undefined;
  if (timestamp >= 100_000_000_000_000_000) return Math.trunc(timestamp / 1_000_000);
  if (timestamp >= 100_000_000_000_000) return Math.trunc(timestamp / 1_000);
  return Math.trunc(timestamp);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}
