import type { OptionContract, OptionQuote, OptionSnapshot } from "../types.js";

export interface OptionBookEntry {
  contract?: OptionContract;
  quote?: OptionQuote;
  snapshot?: OptionSnapshot;
}

export class OptionBook {
  readonly #entries = new Map<string, OptionBookEntry>();

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
    entry.quote = quote;
    this.#entries.set(quote.symbol, entry);
    return true;
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
}
