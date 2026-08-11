import type { UnderlyingSymbol } from "../types.js";
import { marketDate } from "../utils/time.js";

export interface PortfolioRiskLimits {
  timeZone: string;
  maxConcurrentUnderlyings?: number;
  maxConcurrentPositions?: number;
  maxPositionsPerUnderlying?: number;
  maxAggregateRiskDollars: number;
  maxAggregatePremiumDollars: number;
  maxDailyLossDollars: number;
}

export interface PortfolioReservationRequest {
  underlying: UnderlyingSymbol;
  reservationId?: string;
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
  activePositions: number;
}

interface Reservation {
  underlying: UnderlyingSymbol;
  riskDollars: number;
  premiumDollars: number;
}

/** Atomic account-level protection shared by otherwise independent symbol engines. */
export class PortfolioRiskCoordinator {
  readonly #limits: PortfolioRiskLimits;
  readonly #reservations = new Map<string, Reservation>();
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
      const reservationId = request.reservationId ?? request.underlying;
      const underlyingPositions = [...this.#reservations.values()].filter(
        (reservation) => reservation.underlying === request.underlying,
      ).length;
      const maxPositionsPerUnderlying = this.#limits.maxPositionsPerUnderlying ?? 1;
      const maxConcurrentPositions = this.#limits.maxConcurrentPositions ??
        this.#limits.maxConcurrentUnderlyings ?? 1;
      if (this.#reservations.has(reservationId)) reasons.push("PORTFOLIO_POSITION_EXPOSURE_EXISTS");
      if (underlyingPositions >= maxPositionsPerUnderlying) {
        reasons.push(maxPositionsPerUnderlying === 1
          ? "PORTFOLIO_UNDERLYING_EXPOSURE_EXISTS"
          : "PORTFOLIO_MAX_POSITIONS_PER_UNDERLYING");
      }
      if (this.#reservations.size >= maxConcurrentPositions) {
        reasons.push("PORTFOLIO_MAX_CONCURRENT_POSITIONS");
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
        this.#reservations.set(reservationId, {
          underlying: request.underlying,
          riskDollars: request.riskDollars,
          premiumDollars: request.premiumDollars,
        });
      }
      return { allowed: reasons.length === 0, reasons };
    });
  }

  adoptExposure(
    underlying: UnderlyingSymbol, riskDollars: number, premiumDollars: number, timestamp: number,
    reservationId: string = underlying,
  ): Promise<void> {
    return this.#serialize(() => {
      this.#rollDate(timestamp);
      this.#reservations.set(reservationId, {
        underlying,
        riskDollars: Math.max(0, riskDollars),
        premiumDollars: Math.max(0, premiumDollars),
      });
    });
  }

  releaseExposure(underlying: UnderlyingSymbol, reservationId: string = underlying): Promise<void> {
    return this.#serialize(() => { this.#reservations.delete(reservationId); });
  }

  recordCompletedExit(
    underlying: UnderlyingSymbol, timestamp: number, realizedPnl: number, reservationId: string = underlying,
  ): Promise<void> {
    return this.#serialize(() => {
      this.#rollDate(timestamp);
      this.#realizedPnl += realizedPnl;
      this.#reservations.delete(reservationId);
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
        activeUnderlyings: [...new Set(
          [...this.#reservations.values()].map((reservation) => reservation.underlying),
        )],
        activePositions: this.#reservations.size,
      };
    });
  }

  #rollDate(timestamp: number): void {
    const date = marketDate(timestamp, this.#limits.timeZone);
    if (date === this.#date) return;
    this.#date = date;
    this.#realizedPnl = 0;
  }

  #sum(key: "riskDollars" | "premiumDollars"): number {
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
