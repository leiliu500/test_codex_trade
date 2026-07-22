import type { StockQuote } from "../types.js";

export function midprice(bid: number, ask: number): number {
  return (bid + ask) / 2;
}

export function quoteImbalance(bidSize: number, askSize: number): number {
  return (bidSize - askSize) / (bidSize + askSize);
}

export function microprice(bid: number, ask: number, bidSize: number, askSize: number): number {
  return (ask * bidSize + bid * askSize) / (bidSize + askSize);
}

export function spreadBps(bid: number, ask: number): number {
  return 10_000 * (ask - bid) / midprice(bid, ask);
}

export function micropriceDisplacementBps(bid: number, ask: number, bidSize: number, askSize: number): number {
  const mid = midprice(bid, ask);
  return 10_000 * (microprice(bid, ask, bidSize, askSize) - mid) / mid;
}

/** Level-I OFI event contribution from consecutive, already winsorized quotes. */
export function orderFlowImbalanceEvent(previous: StockQuote, current: StockQuote): number {
  return (current.bidPrice >= previous.bidPrice ? current.bidSize : 0)
    - (current.bidPrice <= previous.bidPrice ? previous.bidSize : 0)
    - (current.askPrice <= previous.askPrice ? current.askSize : 0)
    + (current.askPrice >= previous.askPrice ? previous.askSize : 0);
}

export function optionMidAndSpreadPct(bid: number, ask: number): { mid: number; spreadPct: number } {
  const mid = midprice(bid, ask);
  return { mid, spreadPct: (ask - bid) / mid };
}
