import type { UnderlyingSymbol } from "../types.js";
import { marketDate } from "../utils/time.js";

export interface PortfolioRiskLimits {
  timeZone: string;
  maxConcurrentUnderlyings: number;
  maxAggregateRiskDollars: number;
  maxAggregatePremiumDollars: number;
  maxDailyLossDollars: number;
}

export interface PortfolioReservationRequest {
  underlying: UnderlyingSymbol;
  timestamp: number;
  riskDollars: number;
  premiumDollars: number;
  optionBuyingPowerDollars: number;
}

export interface PortfolioReservationDecision {
  allowed: boolean;
  reasons: string[];
}

export interface PortfolioRiskSnapshot {
  marketDate: string;
  realizedPnl: number;
  reservedRiskDollars: number;
  reservedPremiumDollars: number;
  activeUnderlyings: UnderlyingSymbol[];
}

interface Reservation {
  riskDollars: number;
  premiumDollars: number;
}

/** Atomic account-level protection shared by otherwise independent symbol engines. */
export class PortfolioRiskCoordinator {
  readonly #limits: PortfolioRiskLimits;
  readonly #reservations = new Map<UnderlyingSymbol, Reservation>();
  #date: string;
  #realizedPnl: number;
  #tail: Promise<void> = Promise.resolve();

  constructor(limits: PortfolioRiskLimits, timestamp = Date.now(), restoredRealizedPnl = 0) {
    this.#limits = limits;
    this.#date = marketDate(timestamp, limits.timeZone);
    this.#realizedPnl = restoredRealizedPnl;
  }

  reserveEntry(request: PortfolioReservationRequest): Promise<PortfolioReservationDecision> {
    return this.#serialize(() => {
      this.#rollDate(request.timestamp);
      const reasons: string[] = [];
      if (this.#reservations.has(request.underlying)) reasons.push("PORTFOLIO_UNDERLYING_EXPOSURE_EXISTS");
      if (this.#reservations.size >= this.#limits.maxConcurrentUnderlyings) {
        reasons.push("PORTFOLIO_MAX_CONCURRENT_UNDERLYINGS");
      }
      if (this.#realizedPnl <= -this.#limits.maxDailyLossDollars) reasons.push("PORTFOLIO_MAX_DAILY_LOSS");
      const reservedRisk = this.#sum("riskDollars");
      const reservedPremium = this.#sum("premiumDollars");
      if (!(request.riskDollars > 0) ||
          reservedRisk + request.riskDollars > this.#limits.maxAggregateRiskDollars) {
        reasons.push("PORTFOLIO_RISK_BUDGET_EXCEEDED");
      }
      if (!(request.premiumDollars > 0) ||
          reservedPremium + request.premiumDollars > this.#limits.maxAggregatePremiumDollars) {
        reasons.push("PORTFOLIO_PREMIUM_BUDGET_EXCEEDED");
      }
      if (!(request.optionBuyingPowerDollars >= 0) ||
          reservedPremium + request.premiumDollars > request.optionBuyingPowerDollars) {
        reasons.push("PORTFOLIO_BUYING_POWER_RESERVED");
      }
      if (reasons.length === 0) {
        this.#reservations.set(request.underlying, {
          riskDollars: request.riskDollars,
          premiumDollars: request.premiumDollars,
        });
      }
      return { allowed: reasons.length === 0, reasons };
    });
  }

  adoptExposure(
    underlying: UnderlyingSymbol, riskDollars: number, premiumDollars: number, timestamp: number,
  ): Promise<void> {
    return this.#serialize(() => {
      this.#rollDate(timestamp);
      this.#reservations.set(underlying, {
        riskDollars: Math.max(0, riskDollars),
        premiumDollars: Math.max(0, premiumDollars),
      });
    });
  }

  releaseExposure(underlying: UnderlyingSymbol): Promise<void> {
    return this.#serialize(() => { this.#reservations.delete(underlying); });
  }

  recordCompletedExit(underlying: UnderlyingSymbol, timestamp: number, realizedPnl: number): Promise<void> {
    return this.#serialize(() => {
      this.#rollDate(timestamp);
      this.#realizedPnl += realizedPnl;
      this.#reservations.delete(underlying);
    });
  }

  snapshot(timestamp = Date.now()): Promise<PortfolioRiskSnapshot> {
    return this.#serialize(() => {
      this.#rollDate(timestamp);
      return {
        marketDate: this.#date,
        realizedPnl: this.#realizedPnl,
        reservedRiskDollars: this.#sum("riskDollars"),
        reservedPremiumDollars: this.#sum("premiumDollars"),
        activeUnderlyings: [...this.#reservations.keys()],
      };
    });
  }

  #rollDate(timestamp: number): void {
    const date = marketDate(timestamp, this.#limits.timeZone);
    if (date === this.#date) return;
    this.#date = date;
    this.#realizedPnl = 0;
  }

  #sum(key: keyof Reservation): number {
    let total = 0;
    for (const reservation of this.#reservations.values()) total += reservation[key];
    return total;
  }

  #serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
