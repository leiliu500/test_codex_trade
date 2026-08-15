import type { OptionBar, OptionQuote, OptionSnapshot, OptionTrade } from "../types.js";

interface QuoteObservation extends OptionQuote {
  mid: number;
  spreadPct: number;
}

interface TradeObservation extends OptionTrade {
  side: -1 | 0 | 1;
}

interface ContractState {
  quotes: QuoteObservation[];
  trades: TradeObservation[];
  minuteBar?: OptionBar;
  dailyBar?: OptionBar;
  previousDailyBar?: OptionBar;
  latestQuoteFingerprint?: string;
  latestTradeFingerprint?: string;
}

export interface AlpacaOptionFeatures {
  symbol: string;
  timestamp: number;
  windowMs: number;
  dataFresh: boolean;
  quoteAgeMs: number;
  tradeAgeMs?: number;
  quoteEvents: number;
  tradeEvents: number;
  mid: number;
  microprice: number;
  micropriceDisplacementBps: number;
  quoteImbalance: number;
  quoteOfi: number;
  spreadPct: number;
  spreadExpansionRatio: number;
  premiumMomentumBps: number;
  bidMomentumBps: number;
  tradeVolume: number;
  buyVolume: number;
  sellVolume: number;
  neutralVolume: number;
  tradeImbalance: number;
  tradeVwap?: number;
  tradeMomentumBps: number;
  minuteBarReturnBps?: number;
  dailyBarReturnBps?: number;
  vwapDisplacementBps?: number;
  confirmationScore: number;
}

export interface AlpacaOptionFeatureEngineOptions {
  windowMs?: number;
  maximumQuoteAgeMs?: number;
  maximumObservationsPerContract?: number;
}

/**
 * Bounded, causal features built only from Alpaca's documented option quote,
 * trade, and snapshot payloads. No external option-data provider is involved.
 */
export class AlpacaOptionFeatureEngine {
  readonly #windowMs: number;
  readonly #maximumQuoteAgeMs: number;
  readonly #maximumObservationsPerContract: number;
  readonly #states = new Map<string, ContractState>();

  constructor(options: AlpacaOptionFeatureEngineOptions = {}) {
    this.#windowMs = options.windowMs ?? 5_000;
    this.#maximumQuoteAgeMs = options.maximumQuoteAgeMs ?? 2_000;
    this.#maximumObservationsPerContract = options.maximumObservationsPerContract ?? 2_048;
    if (!(Number.isFinite(this.#windowMs) && this.#windowMs >= 1_000)) {
      throw new Error("Alpaca option feature window must be at least one second");
    }
    if (!(Number.isFinite(this.#maximumQuoteAgeMs) && this.#maximumQuoteAgeMs > 0)) {
      throw new Error("Alpaca option feature quote age must be positive");
    }
  }

  observeQuote(quote: OptionQuote): boolean {
    if (!validQuote(quote)) return false;
    const state = this.#state(quote.symbol);
    const fingerprint = quoteFingerprint(quote);
    if (state.latestQuoteFingerprint === fingerprint) return false;
    state.latestQuoteFingerprint = fingerprint;
    const mid = (quote.bidPrice + quote.askPrice) / 2;
    insertOrdered(state.quotes, {
      ...quote,
      mid,
      spreadPct: (quote.askPrice - quote.bidPrice) / mid,
    });
    this.#trim(state, quote.timestamp);
    return true;
  }

  observeTrade(trade: OptionTrade): boolean {
    if (!validTrade(trade)) return false;
    const state = this.#state(trade.symbol);
    const fingerprint = tradeFingerprint(trade);
    if (state.latestTradeFingerprint === fingerprint) return false;
    state.latestTradeFingerprint = fingerprint;
    const quote = quoteAtOrBefore(state.quotes, trade.timestamp);
    insertOrdered(state.trades, { ...trade, side: classifyTrade(trade.price, quote) });
    this.#trim(state, trade.timestamp);
    return true;
  }

  observeSnapshot(snapshot: OptionSnapshot): void {
    if (snapshot.latestQuote) this.observeQuote(snapshot.latestQuote);
    if (snapshot.latestTrade) this.observeTrade(snapshot.latestTrade);
    const state = this.#state(snapshot.symbol);
    if (snapshot.minuteBar && newerBar(snapshot.minuteBar, state.minuteBar)) {
      state.minuteBar = snapshot.minuteBar;
    }
    if (snapshot.dailyBar && newerBar(snapshot.dailyBar, state.dailyBar)) {
      state.dailyBar = snapshot.dailyBar;
    }
    if (snapshot.previousDailyBar && newerBar(snapshot.previousDailyBar, state.previousDailyBar)) {
      state.previousDailyBar = snapshot.previousDailyBar;
    }
  }

  snapshot(symbol: string, timestamp: number): AlpacaOptionFeatures | undefined {
    const state = this.#states.get(symbol);
    if (!state) return undefined;
    const causalQuotes = state.quotes.filter((quote) => quote.timestamp <= timestamp);
    const latest = causalQuotes.at(-1);
    if (!latest) return undefined;
    const cutoff = timestamp - this.#windowMs;
    const quotes = causalQuotes.filter((quote) => quote.timestamp >= cutoff);
    const windowQuotes = quotes.length > 0 ? quotes : [latest];
    const trades = state.trades.filter((trade) =>
      trade.timestamp >= cutoff && trade.timestamp <= timestamp);
    const first = windowQuotes[0]!;
    const averageSpreadPct = average(windowQuotes.map((quote) => quote.spreadPct)) ?? latest.spreadPct;
    const quoteImbalance = ratio(
      latest.bidSize - latest.askSize,
      latest.bidSize + latest.askSize,
    );
    const microprice = latest.bidSize + latest.askSize > 0
      ? (latest.askPrice * latest.bidSize + latest.bidPrice * latest.askSize) /
        (latest.bidSize + latest.askSize)
      : latest.mid;
    let ofi = 0;
    let depth = 0;
    for (let index = 1; index < windowQuotes.length; index += 1) {
      const previous = windowQuotes[index - 1]!;
      const current = windowQuotes[index]!;
      ofi += quoteOfi(previous, current);
      depth += Math.max(1, current.bidSize + current.askSize);
    }
    const quoteOfiValue = clamp(depth > 0 ? ofi / depth : 0, -1, 1);
    const buyVolume = volumeBySide(trades, 1);
    const sellVolume = volumeBySide(trades, -1);
    const neutralVolume = volumeBySide(trades, 0);
    const tradeVolume = buyVolume + sellVolume + neutralVolume;
    const tradeImbalance = ratio(buyVolume - sellVolume, tradeVolume);
    const tradeVwap = tradeVolume > 0
      ? trades.reduce((sum, trade) => sum + trade.price * trade.size, 0) / tradeVolume
      : undefined;
    const premiumMomentumBps = logMoveBps(first.mid, latest.mid);
    const bidMomentumBps = logMoveBps(first.bidPrice, latest.bidPrice);
    const tradeMomentumBps = trades.length >= 2
      ? logMoveBps(trades[0]!.price, trades.at(-1)!.price)
      : 0;
    const minuteBarReturnBps = state.minuteBar
      ? logMoveBps(state.minuteBar.open, state.minuteBar.close) : undefined;
    const dailyReference = state.previousDailyBar?.close ?? state.dailyBar?.open;
    const dailyBarReturnBps = dailyReference && state.dailyBar
      ? logMoveBps(dailyReference, state.dailyBar.close) : undefined;
    const vwapReference = tradeVwap ?? state.minuteBar?.vwap ?? state.dailyBar?.vwap;
    const vwapDisplacementBps = vwapReference && vwapReference > 0
      ? logMoveBps(vwapReference, latest.mid) : undefined;
    const spreadExpansionRatio = averageSpreadPct > 0
      ? latest.spreadPct / averageSpreadPct : 1;
    const spreadPenalty = clamp((spreadExpansionRatio - 1) / 1.5, 0, 1);
    const confirmationScore = clamp(
      0.14 * quoteImbalance +
      0.20 * quoteOfiValue +
      0.10 * Math.tanh(((microprice - latest.mid) / latest.mid * 10_000) / 5) +
      0.15 * Math.tanh(bidMomentumBps / 25) +
      0.18 * tradeImbalance +
      0.10 * Math.tanh(tradeMomentumBps / 25) +
      0.08 * Math.tanh((vwapDisplacementBps ?? 0) / 25) +
      0.05 * Math.tanh((minuteBarReturnBps ?? 0) / 25) -
      0.15 * spreadPenalty,
      -1,
      1,
    );
    const latestTrade = trades.at(-1);
    const quoteAgeMs = Math.max(0, timestamp - latest.timestamp);
    return {
      symbol,
      timestamp,
      windowMs: this.#windowMs,
      dataFresh: latest.timestamp <= timestamp && quoteAgeMs <= this.#maximumQuoteAgeMs,
      quoteAgeMs,
      ...(latestTrade ? { tradeAgeMs: Math.max(0, timestamp - latestTrade.timestamp) } : {}),
      quoteEvents: windowQuotes.length,
      tradeEvents: trades.length,
      mid: latest.mid,
      microprice,
      micropriceDisplacementBps: (microprice - latest.mid) / latest.mid * 10_000,
      quoteImbalance,
      quoteOfi: quoteOfiValue,
      spreadPct: latest.spreadPct,
      spreadExpansionRatio,
      premiumMomentumBps,
      bidMomentumBps,
      tradeVolume,
      buyVolume,
      sellVolume,
      neutralVolume,
      tradeImbalance,
      ...(tradeVwap !== undefined ? { tradeVwap } : {}),
      tradeMomentumBps,
      ...(minuteBarReturnBps !== undefined ? { minuteBarReturnBps } : {}),
      ...(dailyBarReturnBps !== undefined ? { dailyBarReturnBps } : {}),
      ...(vwapDisplacementBps !== undefined ? { vwapDisplacementBps } : {}),
      confirmationScore,
    };
  }

  retainSymbols(symbols: ReadonlySet<string>): void {
    for (const symbol of this.#states.keys()) if (!symbols.has(symbol)) this.#states.delete(symbol);
  }

  reset(): void {
    this.#states.clear();
  }

  #state(symbol: string): ContractState {
    const existing = this.#states.get(symbol);
    if (existing) return existing;
    const created: ContractState = { quotes: [], trades: [] };
    this.#states.set(symbol, created);
    return created;
  }

  #trim(state: ContractState, timestamp: number): void {
    const cutoff = timestamp - this.#windowMs * 3;
    trim(state.quotes, cutoff, this.#maximumObservationsPerContract);
    trim(state.trades, cutoff, this.#maximumObservationsPerContract);
  }
}

function validQuote(quote: OptionQuote): boolean {
  return typeof quote.symbol === "string" && quote.symbol.length > 0 &&
    [quote.timestamp, quote.bidPrice, quote.askPrice, quote.bidSize, quote.askSize].every(Number.isFinite) &&
    quote.bidPrice > 0 && quote.askPrice > quote.bidPrice && quote.bidSize > 0 && quote.askSize > 0;
}

function validTrade(trade: OptionTrade): boolean {
  return typeof trade.symbol === "string" && trade.symbol.length > 0 &&
    [trade.timestamp, trade.price, trade.size].every(Number.isFinite) &&
    trade.price > 0 && trade.size > 0;
}

function quoteFingerprint(quote: OptionQuote): string {
  return [quote.symbol, quote.timestamp, quote.bidPrice, quote.askPrice, quote.bidSize, quote.askSize]
    .join("|");
}

function tradeFingerprint(trade: OptionTrade): string {
  return [trade.symbol, trade.timestamp, trade.price, trade.size, trade.exchange ?? "", trade.conditions?.join(",") ?? ""]
    .join("|");
}

function classifyTrade(price: number, quote: QuoteObservation | undefined): -1 | 0 | 1 {
  if (!quote) return 0;
  if (price >= quote.askPrice) return 1;
  if (price <= quote.bidPrice) return -1;
  if (price > quote.mid) return 1;
  if (price < quote.mid) return -1;
  return 0;
}

function quoteAtOrBefore(quotes: readonly QuoteObservation[], timestamp: number): QuoteObservation | undefined {
  for (let index = quotes.length - 1; index >= 0; index -= 1) {
    if (quotes[index]!.timestamp <= timestamp) return quotes[index];
  }
  return undefined;
}

function quoteOfi(previous: QuoteObservation, current: QuoteObservation): number {
  const bid = (current.bidPrice >= previous.bidPrice ? current.bidSize : 0) -
    (current.bidPrice <= previous.bidPrice ? previous.bidSize : 0);
  const ask = (current.askPrice <= previous.askPrice ? current.askSize : 0) -
    (current.askPrice >= previous.askPrice ? previous.askSize : 0);
  return bid - ask;
}

function volumeBySide(trades: readonly TradeObservation[], side: -1 | 0 | 1): number {
  return trades.filter((trade) => trade.side === side)
    .reduce((sum, trade) => sum + trade.size, 0);
}

function insertOrdered<T extends { timestamp: number }>(values: T[], value: T): void {
  if (values.length === 0 || values.at(-1)!.timestamp <= value.timestamp) {
    values.push(value);
    return;
  }
  const index = values.findIndex((candidate) => candidate.timestamp > value.timestamp);
  values.splice(index < 0 ? values.length : index, 0, value);
}

function trim<T extends { timestamp: number }>(values: T[], cutoff: number, maximum: number): void {
  while (values[0] && values[0].timestamp < cutoff) values.shift();
  if (values.length > maximum) values.splice(0, values.length - maximum);
}

function newerBar(next: OptionBar, current: OptionBar | undefined): boolean {
  return !current || next.timestamp >= current.timestamp;
}

function average(values: readonly number[]): number | undefined {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? clamp(numerator / denominator, -1, 1) : 0;
}

function logMoveBps(start: number, end: number): number {
  return start > 0 && end > 0 ? Math.log(end / start) * 10_000 : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
