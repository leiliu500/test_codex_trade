import type {
  OptionAggregate,
  OptionChainConfirmation,
  OptionContract,
  OptionMicrostructureSnapshot,
  OptionQuote,
  OptionSnapshot,
  OptionTrade,
  OptionType,
} from "../types.js";
import { OptionMicrostructureEngine } from "./optionMicrostructure.js";

export interface OptionBookEntry {
  contract?: OptionContract;
  quote?: OptionQuote;
  snapshot?: OptionSnapshot;
}

export class OptionBook {
  readonly #entries = new Map<string, OptionBookEntry>();
  readonly #microstructure: OptionMicrostructureEngine;

  constructor(microstructureWindowMs = 5_000) {
    this.#microstructure = new OptionMicrostructureEngine(microstructureWindowMs);
  }

  upsertContract(contract: OptionContract): void {
    const entry = this.#entries.get(contract.symbol) ?? {};
    entry.contract = contract;
    if (contract.openInterest !== undefined) {
      entry.snapshot = { ...(entry.snapshot ?? { symbol: contract.symbol }), openInterest: contract.openInterest };
    }
    this.#entries.set(contract.symbol, entry);
  }

  updateQuote(quote: OptionQuote): boolean {
    const entry = this.#entries.get(quote.symbol) ?? {};
    if (entry.quote && quote.timestamp < entry.quote.timestamp) return false;
    if (entry.quote?.sequenceNumber !== undefined && quote.sequenceNumber !== undefined &&
        quote.sequenceNumber <= entry.quote.sequenceNumber) return false;
    entry.quote = quote;
    this.#entries.set(quote.symbol, entry);
    this.#microstructure.observeQuote(quote);
    return true;
  }

  observeQuote(quote: OptionQuote): boolean {
    return this.#microstructure.observeQuote(quote);
  }

  updateTrade(trade: OptionTrade): boolean {
    return this.#microstructure.observeTrade(trade);
  }

  updateAggregate(aggregate: OptionAggregate): boolean {
    return this.#microstructure.observeAggregate(aggregate);
  }

  updateSnapshot(snapshot: OptionSnapshot): boolean {
    const entry = this.#entries.get(snapshot.symbol) ?? {};
    if (entry.snapshot?.timestamp !== undefined && snapshot.timestamp !== undefined && snapshot.timestamp < entry.snapshot.timestamp) return false;
    entry.snapshot = {
      ...entry.snapshot,
      ...snapshot,
      ...(entry.snapshot?.greeks || snapshot.greeks
        ? { greeks: { ...entry.snapshot?.greeks, ...snapshot.greeks } }
        : {}),
    };
    this.#entries.set(snapshot.symbol, entry);
    return true;
  }

  get(symbol: string): OptionBookEntry | undefined { return this.#entries.get(symbol); }
  entries(): OptionBookEntry[] { return [...this.#entries.values()]; }
  contracts(): OptionContract[] { return this.entries().flatMap((entry) => entry.contract ? [entry.contract] : []); }

  microstructure(symbol: string, timestamp: number): OptionMicrostructureSnapshot | undefined {
    return this.#microstructure.snapshot(symbol, timestamp);
  }

  chainConfirmation(
    optionType: OptionType,
    timestamp: number,
    centerStrike?: number,
    strikeRangePct = 0.03,
  ): OptionChainConfirmation {
    const observations = this.entries().flatMap((entry) => {
      const contract = entry.contract;
      if (!contract || contract.type !== optionType) return [];
      if (centerStrike !== undefined &&
          Math.abs(contract.strike / centerStrike - 1) > strikeRangePct) return [];
      const snapshot = this.microstructure(contract.symbol, timestamp);
      if (!snapshot?.dataFresh) return [];
      return [{ snapshot, impliedVolatility: entry.snapshot?.impliedVolatility }];
    });
    const scores = observations.map((value) => value.snapshot.confirmationScore);
    const ivs = observations.flatMap((value) =>
      value.impliedVolatility !== undefined && Number.isFinite(value.impliedVolatility)
        ? [value.impliedVolatility] : []);
    return {
      timestamp,
      optionType,
      observedContracts: observations.length,
      confirmingContracts: scores.filter((score) => score > 0).length,
      confirmationFraction: scores.length > 0
        ? scores.filter((score) => score > 0).length / scores.length : 0,
      averageScore: scores.length > 0
        ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0,
      ...(ivs.length > 0 ? { nearbyIvMedian: median(ivs) } : {}),
    };
  }

  retainMicrostructureSymbols(symbols: ReadonlySet<string>): void {
    this.#microstructure.retainSymbols(symbols);
  }
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
}
