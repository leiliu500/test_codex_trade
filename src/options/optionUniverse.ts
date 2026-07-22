import type { EngineConfig } from "../config.js";
import type { Direction, OptionContract } from "../types.js";
import { marketDate, secondsSinceMidnight, parseClock } from "../utils/time.js";
import { assertSameDaySpyOptionOrder, sameDaySpyOptionContractReasons } from "./tradingInvariants.js";

export function coarseUniverseFilter(
  contracts: readonly OptionContract[], direction: Direction, spot: number, now: number, config: EngineConfig,
): OptionContract[] {
  const date = marketDate(now, config.timeZone);
  const neededType = direction === "BULLISH" ? "call" : "put";
  return contracts.filter((contract) => {
    return contract.active && contract.tradable && contract.type === neededType &&
      contract.expirationDate === date && sameDaySpyOptionContractReasons(contract, now, config.timeZone).length === 0 &&
      Math.abs(contract.strike / spot - 1) <= config.options.strikeRangePct &&
      secondsSinceMidnight(now, config.timeZone) <= parseClock(config.options.zeroDteEntryCutoff);
  });
}

export function chooseSubscriptions(
  contracts: readonly OptionContract[], spot: number, now: number, config: EngineConfig,
  retainedSymbols: ReadonlySet<string> = new Set(),
): string[] {
  const calls = coarseUniverseFilter(contracts, "BULLISH", spot, now, config)
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .slice(0, config.options.subscriptionCandidatesPerSide);
  const puts = coarseUniverseFilter(contracts, "BEARISH", spot, now, config)
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .slice(0, config.options.subscriptionCandidatesPerSide);
  return [...new Set([...calls, ...puts].map((contract) => contract.symbol).concat([...retainedSymbols]))];
}

export class OptionUniverseManager {
  readonly #config: EngineConfig;
  #lastRefresh = -Infinity;
  readonly #retained = new Set<string>();
  constructor(config: EngineConfig) { this.#config = config; }
  retainOpenPosition(symbol: string, now: number): void {
    assertSameDaySpyOptionOrder(symbol, "sell", now, this.#config);
    this.#retained.add(symbol);
  }
  releaseClosedPosition(symbol: string): void { this.#retained.delete(symbol); }
  shouldRefresh(now: number): boolean { return now - this.#lastRefresh >= this.#config.options.chainRefreshSec * 1000; }
  refresh(contracts: readonly OptionContract[], spot: number, now: number): string[] {
    this.#lastRefresh = now;
    return chooseSubscriptions(contracts, spot, now, this.#config, this.#retained);
  }
}
