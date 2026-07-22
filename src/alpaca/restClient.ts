import type { AccountState, OptionContract, OptionSnapshot, PositionState, StockQuote } from "../types.js";
import type { OrderSide } from "../execution/orderExecutor.js";
import { parseOccSymbol } from "../options/occSymbol.js";
import { assertSameDaySpyOptionOrder, sameDaySpyOptionContractReasons, sameDaySpyOptionSymbolReasons } from "../options/tradingInvariants.js";
import { marketDate } from "../utils/time.js";
import { defaultConfig } from "../config.js";
import { adaptAlpacaStockQuote } from "./stockStream.js";

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

export interface TradingRestClient {
  getAccount(): Promise<AccountState>;
  getMarketClock(): Promise<{ timestamp: number; isOpen: boolean }>;
  listOptionContracts(): Promise<OptionContract[]>;
  getOptionSnapshots(symbols: readonly string[]): Promise<OptionSnapshot[]>;
  submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder>;
  getOrder(orderId: string): Promise<BrokerOrder>;
  getOrderByClientOrderId(clientOrderId: string): Promise<BrokerOrder>;
  replaceOrder(orderId: string, limitPrice: number): Promise<BrokerOrder>;
  cancelOrder(orderId: string): Promise<void>;
  listOpenOrders(): Promise<BrokerOrder[]>;
  listPositions(): Promise<PositionState[]>;
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
}

interface RawOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  status: string;
  filled_qty: string;
  filled_avg_price?: string | null;
}

export class AlpacaTradingRestClient implements TradingRestClient {
  readonly #config: Required<Omit<AlpacaRestConfig, "tradingBaseUrl" | "dataBaseUrl" | "fetch" | "now" | "timeZone">> & {
    tradingBaseUrl: string; dataBaseUrl: string; fetch: typeof fetch;
  };
  readonly #now: () => number;
  readonly #timeZone: string;
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
    const raw = await this.#request<{ quote: Record<string, unknown>; symbol?: string }>(
      this.#config.dataBaseUrl,
      "/v2/stocks/SPY/quotes/latest?feed=sip",
    );
    return adaptAlpacaStockQuote({ ...raw.quote, S: raw.symbol ?? "SPY" });
  }

  async listOptionContracts(): Promise<OptionContract[]> {
    const now = this.#now();
    const today = marketDate(now, this.#timeZone);
    let pageToken: string | undefined;
    const contracts: OptionContract[] = [];
    do {
      const query = new URLSearchParams({
        underlying_symbols: "SPY", status: "active", expiration_date_gte: today,
        expiration_date_lte: today, limit: "10000",
      });
      if (pageToken) query.set("page_token", pageToken);
      const raw = await this.#request<{ option_contracts: Array<Record<string, unknown>>; next_page_token?: string; page_token?: string }>(
        this.#config.tradingBaseUrl, `/v2/options/contracts?${query}`,
      );
      for (const item of raw.option_contracts) {
        if (item.underlying_symbol !== "SPY" || (item.type !== "call" && item.type !== "put")) continue;
        const contract: OptionContract = {
          symbol: String(item.symbol), underlying: "SPY", expirationDate: String(item.expiration_date),
          strike: Number(item.strike_price), type: item.type, tradable: item.tradable === true,
          active: item.status === "active",
          ...(Number.isFinite(Number(item.open_interest)) ? { openInterest: Number(item.open_interest) } : {}),
        };
        if (sameDaySpyOptionContractReasons(contract, now, this.#timeZone).length === 0) contracts.push(contract);
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
        const latestQuote = item.latestQuote as Record<string, unknown> | undefined;
        snapshots.push({
          symbol,
          ...(latestQuote?.t ? { timestamp: Date.parse(String(latestQuote.t)) } : {}),
          ...(Number.isFinite(Number(item.impliedVolatility)) ? { impliedVolatility: Number(item.impliedVolatility) } : {}),
          ...(greeks ? { greeks: {
            ...(Number.isFinite(Number(greeks.delta)) ? { delta: Number(greeks.delta) } : {}),
            ...(Number.isFinite(Number(greeks.gamma)) ? { gamma: Number(greeks.gamma) } : {}),
            ...(Number.isFinite(Number(greeks.theta)) ? { theta: Number(greeks.theta) } : {}),
            ...(Number.isFinite(Number(greeks.vega)) ? { vega: Number(greeks.vega) } : {}),
          } } : {}),
          ...(Number.isFinite(Number(dailyBar?.v)) ? { dailyVolume: Number(dailyBar?.v) } : {}),
        });
      }
    }
    return snapshots;
  }

  async submitOrder(request: BrokerOrderRequest): Promise<BrokerOrder> {
    assertSameDaySpyOptionOrder(request.symbol, request.side, this.#now(), {
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
    if (raw.symbol !== request.symbol) throw new Error("Broker returned a different symbol than the submitted SPY option");
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
    if (!this.#validatedOrderIds.has(orderId)) throw new Error("Cannot replace an order that was not validated as a same-day SPY option");
    const raw = await this.#request<RawOrder>(this.#config.tradingBaseUrl, `/v2/orders/${encodeURIComponent(orderId)}`, {
      method: "PATCH", body: JSON.stringify({ limit_price: limitPrice.toFixed(2) }),
    });
    this.#assertSameDaySymbol(raw.symbol);
    this.#validatedOrderIds.add(raw.id);
    return mapOrder(raw);
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!this.#validatedOrderIds.has(orderId)) {
      throw new Error("Cannot cancel an order that was not validated as a same-day SPY option");
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

  async listPositions(): Promise<PositionState[]> {
    const raw = await this.#request<Array<Record<string, unknown>>>(this.#config.tradingBaseUrl, "/v2/positions");
    return raw.map((item) => {
      const symbol = String(item.symbol);
      this.#assertSameDaySymbol(symbol);
      const price = Number(item.avg_entry_price);
      const type = parseOccSymbol(symbol)!.type === "put" ? "BEARISH" : "BULLISH";
      return {
        symbol, direction: type, quantity: Math.abs(Number(item.qty)), averageEntryPrice: price,
        entryTimestamp: 0, stopPrice: 0, targetPrice: Number.POSITIVE_INFINITY, highWaterMark: price,
      };
    });
  }

  #assertSameDaySymbol(symbol: string): void {
    const reasons = sameDaySpyOptionSymbolReasons(symbol, this.#now(), this.#timeZone);
    if (reasons.length > 0) throw new Error(`Broker state contains a non-compliant position/order ${symbol}: ${reasons.join(",")}`);
  }

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
  brokerPositions: PositionState[];
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
