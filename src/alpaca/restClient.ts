import type {
  AccountState, OptionBar, OptionContract, OptionQuote, OptionSnapshot, PositionState, StockQuote,
  UnderlyingSymbol,
} from "../types.js";
import type { OrderSide } from "../execution/orderExecutor.js";
import { parseOccSymbol } from "../options/occSymbol.js";
import {
  assertSameDayOptionOrder, sameDayOptionContractReasons, sameDayOptionSymbolReasons,
} from "../options/tradingInvariants.js";
import { marketDate } from "../utils/time.js";
import { defaultConfig } from "../config.js";
import { adaptAlpacaStockQuote } from "./stockStream.js";
import { parseRfc3339ToMs } from "../marketData/opraQuoteHealth.js";
import { adaptAlpacaOptionQuote, adaptAlpacaOptionTrade } from "./optionStream.js";

export interface BrokerOrderRequest {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  limitPrice: number;
  timeInForce: "day";
}

export interface BrokerOrder {
  id: string;
  clientOrderId: string;
  symbol: string;
  status: string;
  filledQuantity: number;
  averageFillPrice?: number;
}

export interface BrokerPosition {
  symbol: string;
  direction: PositionState["direction"];
  quantity: number;
  averageEntryPrice: number;
  underlyingEntryPrice?: number;
}

export interface TradingRestClient {
  getAccount(): Promise<AccountState>;
  getMarketClock(): Promise<{ timestamp: number; isOpen: boolean }>;
  listOptionContracts(underlying?: UnderlyingSymbol): Promise<OptionContract[]>;
  getOptionSnapshots(symbols: readonly string[]): Promise<OptionSnapshot[]>;
  getLatestOptionQuotes?(symbols: readonly string[]): Promise<OptionQuote[]>;
  submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder>;
  getOrder(orderId: string): Promise<BrokerOrder>;
  getOrderByClientOrderId(clientOrderId: string): Promise<BrokerOrder>;
  replaceOrder(orderId: string, limitPrice: number): Promise<BrokerOrder>;
  cancelOrder(orderId: string): Promise<void>;
  listOpenOrders(): Promise<BrokerOrder[]>;
  listPositions(): Promise<BrokerPosition[]>;
}

export interface AlpacaRestConfig {
  apiKey: string;
  apiSecret: string;
  paper?: boolean;
  tradingBaseUrl?: string;
  dataBaseUrl?: string;
  optionFeed?: "indicative" | "opra";
  fetch?: typeof fetch;
  now?: () => number;
  timeZone?: string;
  underlyings?: readonly UnderlyingSymbol[];
}

export interface MultiUnderlyingTradingRestClient extends TradingRestClient {
  getLatestUnderlyingSipQuote(underlying: UnderlyingSymbol): Promise<StockQuote>;
}

interface RawOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  status: string;
  filled_qty: string;
  filled_avg_price?: string | null;
}

export class AlpacaTradingRestClient implements MultiUnderlyingTradingRestClient {
  readonly #config: {
    apiKey: string; apiSecret: string; paper: boolean; tradingBaseUrl: string;
    dataBaseUrl: string; optionFeed: "indicative" | "opra"; fetch: typeof fetch;
  };
  readonly #now: () => number;
  readonly #timeZone: string;
  readonly #underlyings: ReadonlySet<UnderlyingSymbol>;
  readonly #validatedOrderIds = new Set<string>();

  constructor(config: AlpacaRestConfig) {
    const paper = config.paper ?? true;
    this.#config = {
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      paper,
      tradingBaseUrl: config.tradingBaseUrl ?? (paper ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets"),
      dataBaseUrl: config.dataBaseUrl ?? "https://data.alpaca.markets",
      optionFeed: config.optionFeed ?? "indicative",
      fetch: config.fetch ?? fetch,
    };
    this.#now = config.now ?? Date.now;
    this.#timeZone = config.timeZone ?? defaultConfig.timeZone;
    const underlyings = config.underlyings ?? ["SPY"];
    if (underlyings.length === 0) throw new Error("At least one broker underlying must be enabled");
    this.#underlyings = new Set(underlyings);
  }

  async getAccount(): Promise<AccountState> {
    const raw = await this.#request<Record<string, unknown>>(this.#config.tradingBaseUrl, "/v2/account");
    const approved = Number(raw.options_approved_level ?? 0);
    return {
      equity: Number(raw.equity),
      optionBuyingPower: Number(raw.options_buying_power ?? raw.buying_power ?? 0),
      active: raw.status === "ACTIVE" && raw.trading_blocked !== true && raw.account_blocked !== true,
      optionsApproved: approved >= 2,
      killSwitch: false,
    };
  }

  async getMarketClock(): Promise<{ timestamp: number; isOpen: boolean }> {
    const raw = await this.#request<{ timestamp: string; is_open: boolean }>(this.#config.tradingBaseUrl, "/v2/clock");
    return { timestamp: Date.parse(raw.timestamp), isOpen: raw.is_open };
  }

  async getLatestSpySipQuote(): Promise<StockQuote> {
    return this.getLatestUnderlyingSipQuote("SPY");
  }

  async getLatestUnderlyingSipQuote(underlying: UnderlyingSymbol): Promise<StockQuote> {
    this.#assertEnabledUnderlying(underlying);
    const raw = await this.#request<{ quote: Record<string, unknown>; symbol?: string }>(
      this.#config.dataBaseUrl,
      `/v2/stocks/${underlying}/quotes/latest?feed=sip`,
    );
    const quote = adaptAlpacaStockQuote({ ...raw.quote, S: raw.symbol ?? underlying });
    if (quote.symbol !== underlying) throw new Error(`Latest SIP quote returned ${quote.symbol}, expected ${underlying}`);
    return quote;
  }

  async listOptionContracts(underlying: UnderlyingSymbol = "SPY"): Promise<OptionContract[]> {
    this.#assertEnabledUnderlying(underlying);
    const now = this.#now();
    const today = marketDate(now, this.#timeZone);
    let pageToken: string | undefined;
    const contracts: OptionContract[] = [];
    do {
      const query = new URLSearchParams({
        underlying_symbols: underlying, status: "active", expiration_date_gte: today,
        expiration_date_lte: today, limit: "10000",
      });
      if (pageToken) query.set("page_token", pageToken);
      const raw = await this.#request<{ option_contracts: Array<Record<string, unknown>>; next_page_token?: string; page_token?: string }>(
        this.#config.tradingBaseUrl, `/v2/options/contracts?${query}`,
      );
      for (const item of raw.option_contracts) {
        if (item.underlying_symbol !== underlying || (item.type !== "call" && item.type !== "put")) continue;
        const contract: OptionContract = {
          symbol: String(item.symbol), underlying, expirationDate: String(item.expiration_date),
          strike: Number(item.strike_price), type: item.type, tradable: item.tradable === true,
          active: item.status === "active",
          ...(Number.isFinite(Number(item.open_interest)) ? { openInterest: Number(item.open_interest) } : {}),
        };
        if (sameDayOptionContractReasons(contract, now, this.#timeZone, underlying).length === 0) {
          contracts.push(contract);
        }
      }
      pageToken = raw.next_page_token ?? raw.page_token;
    } while (pageToken);
    return contracts;
  }

  async getOptionSnapshots(symbols: readonly string[]): Promise<OptionSnapshot[]> {
    for (const symbol of symbols) this.#assertSameDaySymbol(symbol);
    const snapshots: OptionSnapshot[] = [];
    for (let start = 0; start < symbols.length; start += 100) {
      const query = new URLSearchParams({ symbols: symbols.slice(start, start + 100).join(","), feed: this.#config.optionFeed });
      const raw = await this.#request<{ snapshots: Record<string, Record<string, unknown>> }>(
        this.#config.dataBaseUrl, `/v1beta1/options/snapshots?${query}`,
      );
      for (const [symbol, item] of Object.entries(raw.snapshots ?? {})) {
        this.#assertSameDaySymbol(symbol);
        const greeks = item.greeks as Record<string, unknown> | undefined;
        const dailyBar = item.dailyBar as Record<string, unknown> | undefined;
        const minuteBar = item.minuteBar as Record<string, unknown> | undefined;
        const previousDailyBar = item.prevDailyBar as Record<string, unknown> | undefined;
        const latestQuote = item.latestQuote as Record<string, unknown> | undefined;
        const latestTrade = item.latestTrade as Record<string, unknown> | undefined;
        const mappedLatestQuote = latestQuote
          ? adaptAlpacaOptionQuote({ ...latestQuote, S: symbol }) : undefined;
        const mappedLatestTrade = latestTrade
          ? adaptAlpacaOptionTrade({ ...latestTrade, S: symbol }) : undefined;
        const mappedMinuteBar = adaptAlpacaOptionBar(minuteBar);
        const mappedDailyBar = adaptAlpacaOptionBar(dailyBar);
        const mappedPreviousDailyBar = adaptAlpacaOptionBar(previousDailyBar);
        const latestMarketTimestamp = [mappedLatestQuote?.timestamp, mappedLatestTrade?.timestamp]
          .filter((value): value is number => value !== undefined)
          .reduce<number | undefined>(
            (latest, value) => latest === undefined ? value : Math.max(latest, value),
            undefined,
          );
        snapshots.push({
          symbol,
          ...(latestMarketTimestamp !== undefined ? { timestamp: latestMarketTimestamp } : {}),
          ...(Number.isFinite(Number(item.impliedVolatility)) ? { impliedVolatility: Number(item.impliedVolatility) } : {}),
          ...(greeks ? { greeks: {
            ...(Number.isFinite(Number(greeks.delta)) ? { delta: Number(greeks.delta) } : {}),
            ...(Number.isFinite(Number(greeks.gamma)) ? { gamma: Number(greeks.gamma) } : {}),
            ...(Number.isFinite(Number(greeks.theta)) ? { theta: Number(greeks.theta) } : {}),
            ...(Number.isFinite(Number(greeks.vega)) ? { vega: Number(greeks.vega) } : {}),
          } } : {}),
          ...(mappedDailyBar ? { dailyVolume: mappedDailyBar.volume, dailyBar: mappedDailyBar } : {}),
          ...(mappedLatestQuote ? { latestQuote: mappedLatestQuote } : {}),
          ...(mappedLatestTrade ? { latestTrade: mappedLatestTrade } : {}),
          ...(mappedMinuteBar ? { minuteBar: mappedMinuteBar } : {}),
          ...(mappedPreviousDailyBar ? { previousDailyBar: mappedPreviousDailyBar } : {}),
        });
      }
    }
    return snapshots;
  }

  async getLatestOptionQuotes(symbols: readonly string[]): Promise<OptionQuote[]> {
    for (const symbol of symbols) this.#assertSameDaySymbol(symbol);
    const quotes: OptionQuote[] = [];
    for (let start = 0; start < symbols.length; start += 100) {
      const query = new URLSearchParams({
        symbols: symbols.slice(start, start + 100).join(","),
        feed: this.#config.optionFeed,
      });
      const raw = await this.#request<{ quotes: Record<string, Record<string, unknown>> }>(
        this.#config.dataBaseUrl, `/v1beta1/options/quotes/latest?${query}`,
      );
      for (const [symbol, item] of Object.entries(raw.quotes ?? {})) {
        this.#assertSameDaySymbol(symbol);
        const quote = {
          symbol,
          timestamp: typeof item.t === "string" ? parseRfc3339ToMs(item.t) : item.t,
          bidPrice: item.bp,
          askPrice: item.ap,
          bidSize: item.bs,
          askSize: item.as,
          ...(typeof item.bx === "string" ? { bidExchange: item.bx } : {}),
          ...(typeof item.ax === "string" ? { askExchange: item.ax } : {}),
          ...(Array.isArray(item.c)
            ? { conditions: item.c.filter((condition): condition is string => typeof condition === "string") }
            : typeof item.c === "string" ? { conditions: [item.c] } : {}),
        };
        if (![quote.timestamp, quote.bidPrice, quote.askPrice, quote.bidSize, quote.askSize].every(Number.isFinite)) {
          throw new Error(`Invalid Alpaca latest option quote payload for ${symbol}`);
        }
        quotes.push(quote as OptionQuote);
      }
    }
    return quotes;
  }

  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder> {
    const underlying = this.#assertSameDaySymbol(request.symbol);
    assertSameDayOptionOrder(request.symbol, request.side, this.#now(), {
      symbol: underlying,
      timeZone: this.#timeZone,
      session: defaultConfig.session,
      options: defaultConfig.options,
    });
    if (request.timeInForce !== "day") throw new Error("Option-only order rejected: time_in_force must be day");
    if (!Number.isInteger(request.quantity) || request.quantity < 1) throw new Error("Option quantity must be a positive whole number");
    if (!(request.limitPrice > 0)) throw new Error("Option limit price must be positive");
    const raw = await this.#request<RawOrder>(this.#config.tradingBaseUrl, "/v2/orders", {
      method: "POST",
      body: JSON.stringify({ symbol: request.symbol, side: request.side, qty: String(request.quantity), type: "limit",
        time_in_force: "day", limit_price: request.limitPrice.toFixed(2), client_order_id: request.clientOrderId,
        extended_hours: false }),
    });
    this.#assertSameDaySymbol(raw.symbol);
    if (raw.symbol !== request.symbol) throw new Error("Broker returned a different symbol than the submitted option");
    this.#validatedOrderIds.add(raw.id);
    return mapOrder(raw);
  }

  async getOrder(orderId: string): Promise<BrokerOrder> {
    const raw = await this.#request<RawOrder>(
      this.#config.tradingBaseUrl,
      `/v2/orders/${encodeURIComponent(orderId)}`,
    );
    this.#assertSameDaySymbol(raw.symbol);
    this.#validatedOrderIds.add(raw.id);
    return mapOrder(raw);
  }

  async getOrderByClientOrderId(clientOrderId: string): Promise<BrokerOrder> {
    const query = new URLSearchParams({ client_order_id: clientOrderId });
    const raw = await this.#request<RawOrder>(
      this.#config.tradingBaseUrl,
      `/v2/orders:by_client_order_id?${query}`,
    );
    this.#assertSameDaySymbol(raw.symbol);
    this.#validatedOrderIds.add(raw.id);
    return mapOrder(raw);
  }

  async replaceOrder(orderId: string, limitPrice: number): Promise<BrokerOrder> {
    if (!this.#validatedOrderIds.has(orderId)) {
      throw new Error(`Cannot replace an order that was not validated as a same-day ${this.#underlyingLabel()} option`);
    }
    const raw = await this.#request<RawOrder>(this.#config.tradingBaseUrl, `/v2/orders/${encodeURIComponent(orderId)}`, {
      method: "PATCH", body: JSON.stringify({ limit_price: limitPrice.toFixed(2) }),
    });
    this.#assertSameDaySymbol(raw.symbol);
    this.#validatedOrderIds.add(raw.id);
    return mapOrder(raw);
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!this.#validatedOrderIds.has(orderId)) {
      throw new Error(`Cannot cancel an order that was not validated as a same-day ${this.#underlyingLabel()} option`);
    }
    await this.#request<void>(this.#config.tradingBaseUrl, `/v2/orders/${encodeURIComponent(orderId)}`, { method: "DELETE" });
  }

  async listOpenOrders(): Promise<BrokerOrder[]> {
    const raw = await this.#request<RawOrder[]>(this.#config.tradingBaseUrl, "/v2/orders?status=open&limit=500");
    for (const order of raw) {
      this.#assertSameDaySymbol(order.symbol);
      this.#validatedOrderIds.add(order.id);
    }
    return raw.map(mapOrder);
  }

  async listPositions(): Promise<BrokerPosition[]> {
    const raw = await this.#request<Array<Record<string, unknown>>>(this.#config.tradingBaseUrl, "/v2/positions");
    return raw.map((item) => {
      const symbol = String(item.symbol);
      this.#assertSameDaySymbol(symbol);
      const price = Number(item.avg_entry_price);
      const type = parseOccSymbol(symbol)!.type === "put" ? "BEARISH" : "BULLISH";
      return {
        symbol, direction: type, quantity: Math.abs(Number(item.qty)), averageEntryPrice: price,
      };
    });
  }

  #assertSameDaySymbol(symbol: string): UnderlyingSymbol {
    const parsed = parseOccSymbol(symbol);
    if (!parsed) {
      const expected = this.#underlyings.values().next().value ?? "SPY";
      const reasons = sameDayOptionSymbolReasons(symbol, this.#now(), this.#timeZone, expected);
      throw new Error(`Broker state contains a non-compliant position/order ${symbol}: ${reasons.join(",")}`);
    }
    const underlying = parsed?.underlying;
    if (underlying !== "SPY" && underlying !== "QQQ") {
      throw new Error(`Broker state contains a non-compliant position/order ${symbol}: WRONG_UNDERLYING`);
    }
    this.#assertEnabledUnderlying(underlying);
    const reasons = sameDayOptionSymbolReasons(symbol, this.#now(), this.#timeZone, underlying);
    if (reasons.length > 0) throw new Error(`Broker state contains a non-compliant position/order ${symbol}: ${reasons.join(",")}`);
    return underlying;
  }

  #assertEnabledUnderlying(underlying: UnderlyingSymbol): void {
    if (!this.#underlyings.has(underlying)) throw new Error(`${underlying} is not enabled at the broker boundary`);
  }

  #underlyingLabel(): string { return [...this.#underlyings].join("/"); }

  async #request<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#config.fetch(`${base}${path}`, {
      ...init,
      headers: {
        "APCA-API-KEY-ID": this.#config.apiKey,
        "APCA-API-SECRET-KEY": this.#config.apiSecret,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Alpaca HTTP ${response.status} request_id=${response.headers.get("x-request-id") ?? "unknown"}: ${body.slice(0, 500)}`);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}

function adaptAlpacaOptionBar(raw: Record<string, unknown> | undefined): OptionBar | undefined {
  if (!raw) return undefined;
  const timestamp = raw.t instanceof Date ? raw.t.getTime() :
    typeof raw.t === "string" ? parseRfc3339ToMs(raw.t) : Number(raw.t);
  const bar = {
    timestamp,
    open: Number(raw.o),
    high: Number(raw.h),
    low: Number(raw.l),
    close: Number(raw.c),
    volume: Number(raw.v),
    ...(Number.isFinite(Number(raw.n)) ? { tradeCount: Number(raw.n) } : {}),
    ...(Number.isFinite(Number(raw.vw)) ? { vwap: Number(raw.vw) } : {}),
  };
  return [bar.timestamp, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
    ? bar : undefined;
}

/**
 * Presents one underlying to a strategy runtime while retaining one shared broker account.
 * Global account state stays shared; positions, orders, contracts, and snapshots are scoped.
 */
export class UnderlyingTradingRestClient implements MultiUnderlyingTradingRestClient {
  readonly #client: MultiUnderlyingTradingRestClient;
  readonly #underlying: UnderlyingSymbol;

  constructor(client: MultiUnderlyingTradingRestClient, underlying: UnderlyingSymbol) {
    this.#client = client;
    this.#underlying = underlying;
  }

  getAccount(): Promise<AccountState> { return this.#client.getAccount(); }
  getMarketClock(): Promise<{ timestamp: number; isOpen: boolean }> { return this.#client.getMarketClock(); }

  getLatestUnderlyingSipQuote(underlying: UnderlyingSymbol): Promise<StockQuote> {
    this.#assertUnderlying(underlying);
    return this.#client.getLatestUnderlyingSipQuote(this.#underlying);
  }

  getLatestSpySipQuote(): Promise<StockQuote> {
    this.#assertUnderlying("SPY");
    return this.#client.getLatestUnderlyingSipQuote("SPY");
  }

  listOptionContracts(underlying: UnderlyingSymbol = this.#underlying): Promise<OptionContract[]> {
    this.#assertUnderlying(underlying);
    return this.#client.listOptionContracts(this.#underlying);
  }

  async getOptionSnapshots(symbols: readonly string[]): Promise<OptionSnapshot[]> {
    for (const symbol of symbols) this.#assertOptionSymbol(symbol);
    const snapshots = await this.#client.getOptionSnapshots(symbols);
    for (const snapshot of snapshots) this.#assertOptionSymbol(snapshot.symbol);
    return snapshots;
  }

  async getLatestOptionQuotes(symbols: readonly string[]): Promise<OptionQuote[]> {
    for (const symbol of symbols) this.#assertOptionSymbol(symbol);
    const quotes = await this.#client.getLatestOptionQuotes?.(symbols) ?? [];
    for (const quote of quotes) this.#assertOptionSymbol(quote.symbol);
    return quotes;
  }

  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder> {
    this.#assertOptionSymbol(request.symbol);
    return this.#assertOrder(await this.#client.submitOrder(request));
  }

  async getOrder(orderId: string): Promise<BrokerOrder> {
    return this.#assertOrder(await this.#client.getOrder(orderId));
  }

  async getOrderByClientOrderId(clientOrderId: string): Promise<BrokerOrder> {
    return this.#assertOrder(await this.#client.getOrderByClientOrderId(clientOrderId));
  }

  async replaceOrder(orderId: string, limitPrice: number): Promise<BrokerOrder> {
    return this.#assertOrder(await this.#client.replaceOrder(orderId, limitPrice));
  }

  cancelOrder(orderId: string): Promise<void> { return this.#client.cancelOrder(orderId); }

  async listOpenOrders(): Promise<BrokerOrder[]> {
    return (await this.#client.listOpenOrders()).filter((order) => this.#matches(order.symbol));
  }

  async listPositions(): Promise<BrokerPosition[]> {
    return (await this.#client.listPositions()).filter((position) => this.#matches(position.symbol));
  }

  #assertOrder(order: BrokerOrder): BrokerOrder {
    this.#assertOptionSymbol(order.symbol);
    return order;
  }

  #matches(symbol: string): boolean { return parseOccSymbol(symbol)?.underlying === this.#underlying; }

  #assertOptionSymbol(symbol: string): void {
    if (!this.#matches(symbol)) throw new Error(`${this.#underlying} runtime rejected cross-underlying option ${symbol}`);
  }

  #assertUnderlying(underlying: UnderlyingSymbol): void {
    if (underlying !== this.#underlying) {
      throw new Error(`${this.#underlying} runtime cannot request ${underlying} market data`);
    }
  }
}

function mapOrder(raw: RawOrder): BrokerOrder {
  return {
    id: raw.id, clientOrderId: raw.client_order_id, symbol: raw.symbol, status: raw.status,
    filledQuantity: Number(raw.filled_qty),
    ...(raw.filled_avg_price != null ? { averageFillPrice: Number(raw.filled_avg_price) } : {}),
  };
}

export interface ReconciliationResult {
  matched: boolean;
  openOrders: BrokerOrder[];
  unknownOrders: BrokerOrder[];
  brokerPositions: BrokerPosition[];
  reasons: string[];
}

export async function reconcileBrokerState(
  client: TradingRestClient, localPosition?: PositionState, knownClientOrderIds: ReadonlySet<string> = new Set(),
): Promise<ReconciliationResult> {
  const [orders, positions] = await Promise.all([client.listOpenOrders(), client.listPositions()]);
  const unknownOrders = orders.filter((order) => !knownClientOrderIds.has(order.clientOrderId));
  const reasons: string[] = [];
  if (unknownOrders.length > 0) reasons.push("UNKNOWN_OPEN_ORDERS");
  if (positions.length > 1) reasons.push("DUPLICATE_OR_UNEXPECTED_POSITIONS");
  if (!!localPosition !== (positions.length === 1)) reasons.push("LOCAL_BROKER_POSITION_MISMATCH");
  if (localPosition && positions[0] && (positions[0].symbol !== localPosition.symbol || positions[0].quantity !== localPosition.quantity)) {
    reasons.push("POSITION_DETAILS_MISMATCH");
  }
  return { matched: reasons.length === 0, openOrders: orders, unknownOrders, brokerPositions: positions, reasons };
}
