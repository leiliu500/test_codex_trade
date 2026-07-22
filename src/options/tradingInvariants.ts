import type { EngineConfig } from "../config.js";
import type { OptionContract } from "../types.js";
import { marketDate, parseClock, secondsSinceMidnight } from "../utils/time.js";
import { parseOccSymbol } from "./occSymbol.js";

export type OptionInvariantReason =
  | "NOT_OCC_OPTION_SYMBOL"
  | "WRONG_UNDERLYING"
  | "NOT_SAME_DAY_EXPIRATION"
  | "CONTRACT_SYMBOL_MISMATCH"
  | "ENTRY_CUTOFF_PASSED"
  | "ENTRY_WINDOW_CLOSED";

export function sameDaySpyOptionSymbolReasons(
  symbol: string,
  timestamp: number,
  timeZone: string,
): OptionInvariantReason[] {
  const parsed = parseOccSymbol(symbol);
  if (!parsed) return ["NOT_OCC_OPTION_SYMBOL"];
  const reasons: OptionInvariantReason[] = [];
  if (parsed.underlying !== "SPY") reasons.push("WRONG_UNDERLYING");
  if (parsed.expirationDate !== marketDate(timestamp, timeZone)) reasons.push("NOT_SAME_DAY_EXPIRATION");
  return reasons;
}

export function sameDaySpyOptionContractReasons(
  contract: OptionContract,
  timestamp: number,
  timeZone: string,
): OptionInvariantReason[] {
  const reasons = sameDaySpyOptionSymbolReasons(contract.symbol, timestamp, timeZone);
  if (contract.underlying !== "SPY" && !reasons.includes("WRONG_UNDERLYING")) reasons.push("WRONG_UNDERLYING");
  if (contract.expirationDate !== marketDate(timestamp, timeZone) && !reasons.includes("NOT_SAME_DAY_EXPIRATION")) {
    reasons.push("NOT_SAME_DAY_EXPIRATION");
  }
  const parsed = parseOccSymbol(contract.symbol);
  if (parsed && (
    parsed.underlying !== contract.underlying ||
    parsed.expirationDate !== contract.expirationDate ||
    parsed.type !== contract.type ||
    Math.abs(parsed.strike - contract.strike) > 0.0005
  )) reasons.push("CONTRACT_SYMBOL_MISMATCH");
  return [...new Set(reasons)];
}

export function assertSameDaySpyOptionOrder(
  symbol: string,
  side: "buy" | "sell",
  timestamp: number,
  config: Pick<EngineConfig, "timeZone" | "session" | "options">,
): void {
  const reasons = sameDaySpyOptionSymbolReasons(symbol, timestamp, config.timeZone);
  if (side === "buy") {
    const now = secondsSinceMidnight(timestamp, config.timeZone);
    if (now < parseClock(config.session.entryStart)) reasons.push("ENTRY_WINDOW_CLOSED");
    if (now > parseClock(config.options.zeroDteEntryCutoff)) reasons.push("ENTRY_CUTOFF_PASSED");
  }
  if (reasons.length > 0) {
    throw new Error(`Option-only order rejected for ${symbol}: ${[...new Set(reasons)].join(",")}`);
  }
}
