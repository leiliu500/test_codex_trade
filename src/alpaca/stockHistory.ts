import type { HistoricalMarketEvent } from "../history/types.js";
import type { UnderlyingSymbol } from "../types.js";
import { marketDate } from "../utils/time.js";

interface AlpacaHistoricalQuote {
  t?: string;
  bp?: number;
  ap?: number;
  bs?: number;
  as?: number;
  bx?: string;
  ax?: string;
  c?: string[];
}

interface AlpacaHistoricalTrade {
  t?: string;
  p?: number;
  s?: number;
  x?: string;
  c?: string[];
}

interface AlpacaHistoricalPage<T> {
  quotes?: T[];
  trades?: T[];
  next_page_token?: string | null;
}

export interface AlpacaStockHistoryRestClientOptions {
  apiKey: string;
  apiSecret: string;
  feed?: "sip";
  timeZone: string;
  baseUrl?: string;
  pageLimit?: number;
  fetchImpl?: typeof fetch;
}

/** Downloads a bounded stock-tape prefix and emits quotes/trades in provider-time order. */
export class AlpacaStockHistoryRestClient {
  readonly #apiKey: string;
  readonly #apiSecret: string;
  readonly #feed: "sip";
  readonly #timeZone: string;
  readonly #baseUrl: string;
  readonly #pageLimit: number;
  readonly #fetch: typeof fetch;

  constructor(options: AlpacaStockHistoryRestClientOptions) {
    this.#apiKey = options.apiKey;
    this.#apiSecret = options.apiSecret;
    this.#feed = options.feed ?? "sip";
    this.#timeZone = options.timeZone;
    this.#baseUrl = (options.baseUrl ?? "https://data.alpaca.markets").replace(/\/$/, "");
    this.#pageLimit = Math.max(100, Math.min(10_000, Math.floor(options.pageLimit ?? 10_000)));
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async *streamStockEvents(
    symbol: UnderlyingSymbol,
    startTimestamp: number,
    endTimestamp: number,
    quoteSampleIntervalMs: number,
    batchSize = 20_000,
  ): AsyncIterable<readonly HistoricalMarketEvent[]> {
    if (!(endTimestamp > startTimestamp)) return;
    const boundedBatchSize = Math.max(100, Math.min(50_000, Math.floor(batchSize)));
    const quotes = this.#quoteEvents(symbol, startTimestamp, endTimestamp, quoteSampleIntervalMs);
    const trades = this.#tradeEvents(symbol, startTimestamp, endTimestamp);
    const quoteIterator = quotes[Symbol.asyncIterator]();
    const tradeIterator = trades[Symbol.asyncIterator]();
    let quote = await quoteIterator.next();
    let trade = await tradeIterator.next();
    let batch: HistoricalMarketEvent[] = [];

    while (!quote.done || !trade.done) {
      const takeQuote = !quote.done && (trade.done ||
        quote.value.providerTimestamp <= trade.value.providerTimestamp);
      if (takeQuote) {
        batch.push(quote.value);
        quote = await quoteIterator.next();
      } else if (!trade.done) {
        batch.push(trade.value);
        trade = await tradeIterator.next();
      }
      if (batch.length >= boundedBatchSize) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  }

  async *#quoteEvents(
    symbol: UnderlyingSymbol,
    startTimestamp: number,
    endTimestamp: number,
    quoteSampleIntervalMs: number,
  ): AsyncIterable<HistoricalMarketEvent> {
    let lastSampleTimestamp: number | undefined;
    for await (const raw of this.#pages<AlpacaHistoricalQuote>(
      symbol, "quotes", startTimestamp, endTimestamp,
    )) {
      const timestamp = raw.t ? Date.parse(raw.t) : Number.NaN;
      if (!Number.isFinite(timestamp) || timestamp < startTimestamp || timestamp >= endTimestamp) continue;
      if (lastSampleTimestamp !== undefined && quoteSampleIntervalMs > 0 &&
          timestamp - lastSampleTimestamp < quoteSampleIntervalMs) continue;
      if (![raw.bp, raw.ap, raw.bs, raw.as].every((value) => typeof value === "number" && Number.isFinite(value))) {
        continue;
      }
      lastSampleTimestamp = timestamp;
      yield {
        type: "stock_quote",
        providerTimestamp: timestamp,
        receivedTimestamp: timestamp,
        marketDate: marketDate(timestamp, this.#timeZone),
        symbol,
        data: {
          symbol,
          timestamp,
          bidPrice: raw.bp!,
          askPrice: raw.ap!,
          bidSize: raw.bs!,
          askSize: raw.as!,
          ...(raw.bx ? { bidExchange: raw.bx } : {}),
          ...(raw.ax ? { askExchange: raw.ax } : {}),
          ...(raw.c ? { conditions: raw.c } : {}),
        },
      };
    }
  }

  async *#tradeEvents(
    symbol: UnderlyingSymbol,
    startTimestamp: number,
    endTimestamp: number,
  ): AsyncIterable<HistoricalMarketEvent> {
    for await (const raw of this.#pages<AlpacaHistoricalTrade>(
      symbol, "trades", startTimestamp, endTimestamp,
    )) {
      const timestamp = raw.t ? Date.parse(raw.t) : Number.NaN;
      if (!Number.isFinite(timestamp) || timestamp < startTimestamp || timestamp >= endTimestamp ||
          typeof raw.p !== "number" || !Number.isFinite(raw.p) ||
          typeof raw.s !== "number" || !Number.isFinite(raw.s)) continue;
      yield {
        type: "stock_trade",
        providerTimestamp: timestamp,
        receivedTimestamp: timestamp,
        marketDate: marketDate(timestamp, this.#timeZone),
        symbol,
        data: {
          symbol,
          timestamp,
          price: raw.p,
          size: raw.s,
          ...(raw.x ? { exchange: raw.x } : {}),
          ...(raw.c ? { conditions: raw.c } : {}),
        },
      };
    }
  }

  async *#pages<T>(
    symbol: UnderlyingSymbol,
    eventType: "quotes" | "trades",
    startTimestamp: number,
    endTimestamp: number,
  ): AsyncIterable<T> {
    let pageToken: string | undefined;
    const seenTokens = new Set<string>();
    do {
      const query = new URLSearchParams({
        start: new Date(startTimestamp).toISOString(),
        end: new Date(endTimestamp).toISOString(),
        feed: this.#feed,
        sort: "asc",
        limit: String(this.#pageLimit),
      });
      if (pageToken) query.set("page_token", pageToken);
      const response = await this.#fetch(
        `${this.#baseUrl}/v2/stocks/${symbol}/${eventType}?${query}`,
        { headers: { "APCA-API-KEY-ID": this.#apiKey, "APCA-API-SECRET-KEY": this.#apiSecret } },
      );
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`Alpaca historical SIP ${symbol} ${eventType} HTTP ${response.status}: ${detail}`);
      }
      const body = await response.json() as AlpacaHistoricalPage<T>;
      for (const event of body[eventType] ?? []) yield event;
      const nextToken = typeof body.next_page_token === "string" && body.next_page_token
        ? body.next_page_token : undefined;
      if (nextToken && seenTokens.has(nextToken)) {
        throw new Error(`Alpaca historical SIP ${symbol} ${eventType} repeated its page token`);
      }
      if (nextToken) seenTokens.add(nextToken);
      pageToken = nextToken;
    } while (pageToken);
  }
}
