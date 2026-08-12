import type {
  OptionAggregate,
  OptionMicrostructureSnapshot,
  OptionQuote,
  OptionTrade,
} from "../types.js";

interface QuoteObservation {
  timestamp: number;
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
  mid: number;
  spreadPct: number;
  ofi: number;
  depth: number;
}

interface TradeObservation {
  timestamp: number;
  price: number;
  size: number;
  side: -1 | 0 | 1;
  disposition: OptionTradeFlowDisposition;
}

interface ContractState {
  quotes: QuoteObservation[];
  trades: TradeObservation[];
  aggregate?: OptionAggregate;
  lastQuoteFingerprint?: string;
  lastTradeFingerprint?: string;
  lastQuoteSequence?: number;
  lastTradeSequence?: number;
  lastAggregateFingerprint?: string;
}

export type OptionTradeFlowDisposition = "directional" | "neutral" | "excluded";

// OPRA conditions 201-208 are cancel/late reports whose print time does not
// represent current pressure. Crosses and complex/stock-option trades are real
// volume, but their package price does not identify a single-leg aggressor.
const NON_CURRENT_TRADE_CONDITIONS = new Set([201, 202, 203, 204, 205, 206, 207, 208]);
const NON_DIRECTIONAL_TRADE_CONDITIONS = new Set([
  229, 230,
  232, 233, 234, 235, 236, 237, 238, 239, 240,
  241, 242, 243, 244, 245, 246, 247, 248,
]);

const MAX_OBSERVATIONS_PER_CONTRACT = 4_096;

/**
 * Bounded, causal option microstructure state. It intentionally consumes raw provider
 * events before the execution quote coalescer, while exposing only compact snapshots.
 */
export class OptionMicrostructureEngine {
  readonly #windowMs: number;
  readonly #states = new Map<string, ContractState>();

  constructor(windowMs = 5_000) {
    if (!(Number.isFinite(windowMs) && windowMs >= 1_000)) {
      throw new Error("Option microstructure window must be at least one second");
    }
    this.#windowMs = windowMs;
  }

  observeQuote(quote: OptionQuote): boolean {
    if (!validQuote(quote)) return false;
    const state = this.#state(quote.symbol);
    if (quote.sequenceNumber !== undefined && state.lastQuoteSequence !== undefined &&
        quote.sequenceNumber <= state.lastQuoteSequence) return false;
    const fingerprint = quoteFingerprint(quote);
    if (state.lastQuoteFingerprint === fingerprint) return false;
    state.lastQuoteFingerprint = fingerprint;
    if (quote.sequenceNumber !== undefined) state.lastQuoteSequence = quote.sequenceNumber;
    const mid = (quote.bidPrice + quote.askPrice) / 2;
    const spreadPct = mid > 0 ? (quote.askPrice - quote.bidPrice) / mid : Infinity;
    const observation: QuoteObservation = {
      timestamp: quote.timestamp,
      bidPrice: quote.bidPrice,
      askPrice: quote.askPrice,
      bidSize: quote.bidSize,
      askSize: quote.askSize,
      mid,
      spreadPct,
      ofi: 0,
      depth: Math.max(1, quote.bidSize + quote.askSize),
    };
    insertOrdered(state.quotes, observation);
    const index = state.quotes.indexOf(observation);
    const previous = index > 0 ? state.quotes[index - 1] : undefined;
    const next = index >= 0 ? state.quotes[index + 1] : undefined;
    observation.ofi = previous ? quoteOfi(previous, observation) : 0;
    if (next) next.ofi = quoteOfi(observation, next);
    trim(state.quotes, quote.timestamp - this.#windowMs * 3);
    return true;
  }

  observeTrade(trade: OptionTrade): boolean {
    if (!validTrade(trade)) return false;
    const state = this.#state(trade.symbol);
    if (trade.sequenceNumber !== undefined && state.lastTradeSequence !== undefined &&
        trade.sequenceNumber <= state.lastTradeSequence) return false;
    const fingerprint = tradeFingerprint(trade);
    if (state.lastTradeFingerprint === fingerprint) return false;
    state.lastTradeFingerprint = fingerprint;
    if (trade.sequenceNumber !== undefined) state.lastTradeSequence = trade.sequenceNumber;
    const quote = quoteAtOrBefore(state.quotes, trade.timestamp);
    const disposition = optionTradeFlowDisposition(trade);
    const side = disposition === "directional" ? classifyTrade(trade.price, quote) : 0;
    insertOrdered(state.trades, {
      timestamp: trade.timestamp,
      price: trade.price,
      size: trade.size,
      side,
      disposition,
    });
    trim(state.trades, trade.timestamp - this.#windowMs * 3);
    return true;
  }

  observeAggregate(aggregate: OptionAggregate): boolean {
    if (!validAggregate(aggregate)) return false;
    const state = this.#state(aggregate.symbol);
    if (state.aggregate && aggregate.endTimestamp < state.aggregate.endTimestamp) return false;
    const fingerprint = aggregateFingerprint(aggregate);
    if (state.lastAggregateFingerprint === fingerprint) return false;
    state.lastAggregateFingerprint = fingerprint;
    state.aggregate = aggregate;
    return true;
  }

  snapshot(symbol: string, timestamp: number): OptionMicrostructureSnapshot | undefined {
    const state = this.#states.get(symbol);
    if (!state) return undefined;
    const cutoff = timestamp - this.#windowMs;
    const causalQuotes = state.quotes.filter((value) => value.timestamp <= timestamp);
    const lastCausalQuote = causalQuotes[causalQuotes.length - 1];
    if (!lastCausalQuote) return undefined;
    const windowQuotes = causalQuotes.filter((value) => value.timestamp >= cutoff);
    // Preserve the latest causal observation outside the active window so callers can
    // distinguish stale data from a contract that has never produced a quote.
    const quotes = windowQuotes.length > 0 ? windowQuotes : [lastCausalQuote];
    const trades = state.trades.filter((value) => value.timestamp >= cutoff && value.timestamp <= timestamp);
    const latest = quotes[quotes.length - 1]!;
    const first = quotes[0]!;
    const depthTotal = quotes.reduce((sum, value) => sum + value.depth, 0);
    const quoteOfiValue = depthTotal > 0
      ? clamp(quotes.reduce((sum, value) => sum + value.ofi, 0) / depthTotal, -1, 1)
      : 0;
    const quoteImbalance = ratio(latest.bidSize - latest.askSize, latest.bidSize + latest.askSize);
    const microprice = latest.bidSize + latest.askSize > 0
      ? (latest.askPrice * latest.bidSize + latest.bidPrice * latest.askSize) /
        (latest.bidSize + latest.askSize)
      : latest.mid;
    const averageSpreadPct = average(quotes.map((value) => value.spreadPct)) ?? latest.spreadPct;
    const spreadExpansionRatio = averageSpreadPct > 0
      ? latest.spreadPct / averageSpreadPct : 1;
    const qualifiedTrades = trades.filter((value) => value.disposition !== "excluded");
    const directionalTrades = trades.filter((value) => value.disposition === "directional");
    const excludedTrades = trades.filter((value) => value.disposition === "excluded");
    const buyVolume = sumBySide(qualifiedTrades, 1);
    const sellVolume = sumBySide(qualifiedTrades, -1);
    const neutralVolume = sumBySide(qualifiedTrades, 0);
    const tradeVolume = buyVolume + sellVolume + neutralVolume;
    const excludedTradeVolume = excludedTrades.reduce((sum, value) => sum + value.size, 0);
    // Neutral package/cross volume deliberately dilutes one-sided pressure.
    const tradeImbalance = ratio(buyVolume - sellVolume, tradeVolume);
    const tradeNotional = qualifiedTrades.reduce((sum, value) => sum + value.price * value.size, 0);
    const tradeVwap = tradeVolume > 0 ? tradeNotional / tradeVolume : undefined;
    const aggregate = state.aggregate &&
      state.aggregate.endTimestamp >= cutoff && state.aggregate.endTimestamp <= timestamp
      ? state.aggregate : undefined;
    const aggregateVwap = aggregate?.vwap ?? aggregate?.sessionVwap;
    const vwapReference = tradeVwap ?? aggregateVwap;
    const premiumMomentumBps = logMoveBps(first.mid, latest.mid);
    const bidMomentumBps = logMoveBps(first.bidPrice, latest.bidPrice);
    const vwapDisplacementBps = vwapReference && vwapReference > 0
      ? logMoveBps(vwapReference, latest.mid) : 0;
    const micropriceDisplacementBps = latest.mid > 0
      ? (microprice - latest.mid) / latest.mid * 10_000 : 0;
    const bidDepthTrend = ratio(latest.bidSize - first.bidSize, latest.bidSize + first.bidSize);
    const askDepthTrend = ratio(latest.askSize - first.askSize, latest.askSize + first.askSize);
    const momentumScore = Math.tanh(premiumMomentumBps / 25);
    const bidMomentumScore = Math.tanh(bidMomentumBps / 25);
    const vwapScore = Math.tanh(vwapDisplacementBps / 25);
    const spreadPenalty = clamp((spreadExpansionRatio - 1) / 1.5, 0, 1);
    const confirmationScore = clamp(
      0.15 * quoteImbalance +
      0.25 * quoteOfiValue +
      0.20 * momentumScore +
      0.10 * bidMomentumScore +
      0.20 * tradeImbalance +
      0.10 * vwapScore -
      0.20 * spreadPenalty,
      -1,
      1,
    );
    return {
      symbol,
      timestamp,
      quoteTimestamp: latest.timestamp,
      ...(trades[trades.length - 1]?.timestamp !== undefined
        ? { tradeTimestamp: trades[trades.length - 1]!.timestamp } : {}),
      ...(aggregate ? { aggregateEndTimestamp: aggregate.endTimestamp } : {}),
      windowMs: this.#windowMs,
      quoteEvents: quotes.length,
      tradeEvents: trades.length,
      qualifiedTradeEvents: qualifiedTrades.length,
      directionalTradeEvents: directionalTrades.length,
      excludedTradeEvents: excludedTrades.length,
      mid: latest.mid,
      microprice,
      micropriceDisplacementBps,
      quoteImbalance,
      quoteOfi: quoteOfiValue,
      premiumMomentumBps,
      bidMomentumBps,
      spreadPct: latest.spreadPct,
      spreadExpansionRatio,
      bidDepthTrend,
      askDepthTrend,
      tradeVolume,
      buyVolume,
      sellVolume,
      neutralVolume,
      excludedTradeVolume,
      tradeImbalance,
      ...(tradeVwap !== undefined ? { tradeVwap } : {}),
      ...(aggregateVwap !== undefined ? { aggregateVwap } : {}),
      vwapDisplacementBps,
      confirmationScore,
      dataFresh: timestamp >= latest.timestamp && timestamp - latest.timestamp <= this.#windowMs,
    };
  }

  retainSymbols(symbols: ReadonlySet<string>): void {
    for (const symbol of this.#states.keys()) if (!symbols.has(symbol)) this.#states.delete(symbol);
  }

  #state(symbol: string): ContractState {
    let state = this.#states.get(symbol);
    if (!state) {
      state = { quotes: [], trades: [] };
      this.#states.set(symbol, state);
    }
    return state;
  }
}

/** Maps documented Massive/OPRA conditions into causal flow eligibility. */
export function optionTradeFlowDisposition(
  trade: Pick<OptionTrade, "conditions" | "correction">,
): OptionTradeFlowDisposition {
  if (trade.correction !== undefined && trade.correction !== 0) return "excluded";
  const conditions = trade.conditions ?? [];
  if (conditions.some((condition) => NON_CURRENT_TRADE_CONDITIONS.has(condition))) return "excluded";
  if (conditions.some((condition) => NON_DIRECTIONAL_TRADE_CONDITIONS.has(condition))) return "neutral";
  return "directional";
}

function quoteOfi(
  previous: Pick<QuoteObservation, "bidPrice" | "askPrice" | "bidSize" | "askSize">,
  quote: Pick<QuoteObservation, "bidPrice" | "askPrice" | "bidSize" | "askSize">,
): number {
  const bidContribution = quote.bidPrice > previous.bidPrice
    ? quote.bidSize
    : quote.bidPrice < previous.bidPrice
      ? -previous.bidSize
      : quote.bidSize - previous.bidSize;
  const askContribution = quote.askPrice < previous.askPrice
    ? quote.askSize
    : quote.askPrice > previous.askPrice
      ? -previous.askSize
      : quote.askSize - previous.askSize;
  return bidContribution - askContribution;
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
    const quote = quotes[index]!;
    if (quote.timestamp <= timestamp) return quote;
  }
  return undefined;
}

function insertOrdered<T extends { timestamp: number }>(values: T[], value: T): void {
  if (values.length === 0 || values[values.length - 1]!.timestamp <= value.timestamp) values.push(value);
  else {
    let index = values.length - 1;
    while (index >= 0 && values[index]!.timestamp > value.timestamp) index -= 1;
    values.splice(index + 1, 0, value);
  }
  if (values.length > MAX_OBSERVATIONS_PER_CONTRACT) {
    values.splice(0, values.length - MAX_OBSERVATIONS_PER_CONTRACT);
  }
}

function trim<T extends { timestamp: number }>(values: T[], cutoff: number): void {
  let remove = 0;
  while (remove < values.length && values[remove]!.timestamp < cutoff) remove += 1;
  if (remove > 0) values.splice(0, remove);
}

function validQuote(quote: OptionQuote): boolean {
  return quote.symbol.length > 0 &&
    [quote.timestamp, quote.bidPrice, quote.askPrice, quote.bidSize, quote.askSize].every(Number.isFinite) &&
    quote.timestamp >= 0 && quote.bidPrice >= 0 && quote.askPrice >= quote.bidPrice &&
    quote.bidSize >= 0 && quote.askSize >= 0 && quote.askPrice > 0;
}

function validTrade(trade: OptionTrade): boolean {
  return trade.symbol.length > 0 &&
    [trade.timestamp, trade.price, trade.size].every(Number.isFinite) &&
    trade.timestamp >= 0 && trade.price > 0 && trade.size > 0;
}

function validAggregate(aggregate: OptionAggregate): boolean {
  return aggregate.symbol.length > 0 &&
    [aggregate.startTimestamp, aggregate.endTimestamp, aggregate.open, aggregate.high,
      aggregate.low, aggregate.close, aggregate.volume].every(Number.isFinite) &&
    aggregate.startTimestamp <= aggregate.endTimestamp && aggregate.volume >= 0 &&
    aggregate.low >= 0 && aggregate.high >= aggregate.low;
}

function quoteFingerprint(quote: OptionQuote): string {
  return `${quote.sequenceNumber ?? ""}:${quote.timestamp}:${quote.bidPrice}:${quote.askPrice}:` +
    `${quote.bidSize}:${quote.askSize}`;
}

function tradeFingerprint(trade: OptionTrade): string {
  return `${trade.sequenceNumber ?? ""}:${trade.timestamp}:${trade.price}:${trade.size}:` +
    `${trade.exchange ?? ""}:${trade.conditions?.join(",") ?? ""}:${trade.correction ?? ""}`;
}

function aggregateFingerprint(aggregate: OptionAggregate): string {
  return `${aggregate.startTimestamp}:${aggregate.endTimestamp}:${aggregate.open}:${aggregate.high}:` +
    `${aggregate.low}:${aggregate.close}:${aggregate.volume}:${aggregate.accumulatedVolume ?? ""}:` +
    `${aggregate.vwap ?? ""}:${aggregate.sessionVwap ?? ""}`;
}

function sumBySide(values: readonly TradeObservation[], side: -1 | 0 | 1): number {
  return values.reduce((sum, value) => sum + (value.side === side ? value.size : 0), 0);
}

function average(values: readonly number[]): number | undefined {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function logMoveBps(from: number, to: number): number {
  return from > 0 && to > 0 ? Math.log(to / from) * 10_000 : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? clamp(numerator / denominator, -1, 1) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
