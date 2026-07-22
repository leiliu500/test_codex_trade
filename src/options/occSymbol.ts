import type { OptionContract } from "../types.js";

export interface ParsedOccSymbol {
  underlying: string;
  expirationDate: string;
  type: "call" | "put";
  strike: number;
}

export function parseOccSymbol(symbol: string): ParsedOccSymbol | undefined {
  const compact = symbol.replace(/\s+/g, "").toUpperCase();
  const match = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/.exec(compact);
  if (!match) return undefined;
  const [, underlying, date, side, strikeRaw] = match;
  const year = 2000 + Number(date!.slice(0, 2));
  const month = Number(date!.slice(2, 4));
  const day = Number(date!.slice(4, 6));
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return undefined;
  return {
    underlying: underlying!,
    expirationDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    type: side === "C" ? "call" : "put",
    strike: Number(strikeRaw) / 1000,
  };
}

export function formatOccSymbol(contract: Pick<OptionContract, "underlying" | "expirationDate" | "type" | "strike">): string {
  const [year, month, day] = contract.expirationDate.split("-");
  if (!year || !month || !day || !Number.isFinite(contract.strike)) throw new Error("Invalid OCC contract fields");
  return `${contract.underlying}${year.slice(-2)}${month}${day}${contract.type === "call" ? "C" : "P"}${Math.round(contract.strike * 1000).toString().padStart(8, "0")}`;
}
