import type { EngineConfig } from "../config.js";
import type { AccountState, Direction, PositionState, RiskDecision } from "../types.js";
import { marketDate } from "../utils/time.js";
import { sameDaySpyOptionSymbolReasons } from "../options/tradingInvariants.js";

export interface DailyRiskState {
  marketDate: string;
  entries: number;
  realizedPnl: number;
}

export interface RiskRequest {
  timestamp: number;
  optionMid: number;
  account: AccountState;
  hasOpenPosition: boolean;
}

export class RiskManager {
  readonly #config: EngineConfig;
  #daily?: DailyRiskState;

  constructor(config: EngineConfig) { this.#config = config; }

  evaluate(request: RiskRequest): RiskDecision {
    const daily = this.#forDate(request.timestamp);
    const reasons: string[] = [];
    if (!(request.optionMid > 0)) reasons.push("INVALID_ENTRY_PRICE");
    if (!request.account.active) reasons.push("ACCOUNT_INACTIVE_OR_BLOCKED");
    if (!request.account.optionsApproved) reasons.push("OPTIONS_APPROVAL_INSUFFICIENT");
    if (request.account.killSwitch) reasons.push("KILL_SWITCH_ACTIVE");
    if (daily.entries >= this.#config.risk.maxTradesPerDay) reasons.push("MAX_DAILY_ENTRIES_REACHED");
    if (daily.realizedPnl <= -this.#config.risk.maxDailyLossDollars) reasons.push("MAX_DAILY_LOSS_REACHED");
    if (this.#config.risk.onePositionAtATime && request.hasOpenPosition) reasons.push("POSITION_ALREADY_OPEN");

    const maxLossPerContract = 100 * Math.max(0, request.optionMid) * this.#config.risk.hardOptionStopPct;
    const budget = Math.min(
      this.#config.risk.riskFractionOfEquity * request.account.equity,
      this.#config.risk.maxRiskDollarsPerTrade,
    );
    const riskQuantity = maxLossPerContract > 0 ? Math.floor(budget / maxLossPerContract) : 0;
    const premiumQuantity = request.optionMid > 0
      ? Math.floor(this.#config.risk.maxPremiumDollarsPerTrade / (100 * request.optionMid)) : 0;
    const buyingPowerQuantity = request.optionMid > 0
      ? Math.floor(request.account.optionBuyingPower / (100 * request.optionMid)) : 0;
    const quantity = Math.max(0, Math.min(
      this.#config.risk.maxContracts, riskQuantity, premiumQuantity, buyingPowerQuantity,
    ));
    if (quantity < 1) reasons.push("QUANTITY_BELOW_ONE");
    return {
      allowed: reasons.length === 0,
      quantity: reasons.length === 0 ? quantity : 0,
      maxLossPerContract,
      stopPrice: Math.max(0.01, request.optionMid * (1 - this.#config.risk.hardOptionStopPct)),
      targetPrice: request.optionMid * (1 + this.#config.risk.optionProfitTargetPct),
      reasons,
    };
  }

  recordEntry(timestamp: number): void { this.#forDate(timestamp).entries += 1; }
  recordRealizedPnl(timestamp: number, pnl: number): void { this.#forDate(timestamp).realizedPnl += pnl; }
  state(timestamp: number): Readonly<DailyRiskState> { return { ...this.#forDate(timestamp) }; }

  restoreState(state: DailyRiskState): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(state.marketDate) || !Number.isInteger(state.entries) || state.entries < 0 ||
        !Number.isFinite(state.realizedPnl)) {
      throw new Error("Invalid restored daily risk state");
    }
    this.#daily = { ...state };
  }

  createFilledPosition(
    symbol: string, direction: Direction, quantity: number, averageFillPrice: number, timestamp: number,
  ): PositionState {
    const invariantReasons = sameDaySpyOptionSymbolReasons(symbol, timestamp, this.#config.timeZone);
    if (invariantReasons.length > 0) {
      throw new Error(`Cannot create a non-0DTE SPY option position for ${symbol}: ${invariantReasons.join(",")}`);
    }
    return {
      symbol,
      direction,
      quantity,
      averageEntryPrice: averageFillPrice,
      entryTimestamp: timestamp,
      stopPrice: Math.max(0.01, averageFillPrice * (1 - this.#config.risk.hardOptionStopPct)),
      targetPrice: averageFillPrice * (1 + this.#config.risk.optionProfitTargetPct),
      highWaterMark: averageFillPrice,
      lowWaterMark: averageFillPrice,
    };
  }

  #forDate(timestamp: number): DailyRiskState {
    const date = marketDate(timestamp, this.#config.timeZone);
    if (!this.#daily || this.#daily.marketDate !== date) this.#daily = { marketDate: date, entries: 0, realizedPnl: 0 };
    return this.#daily;
  }
}

export function fractionalKelly(winProbability: number, averageWin: number, averageLoss: number): number {
  if (!(averageLoss > 0) || !(averageWin > 0)) return 0;
  const b = averageWin / averageLoss;
  return (b * winProbability - (1 - winProbability)) / b;
}
