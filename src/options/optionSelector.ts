import type { EngineConfig } from "../config.js";
import type { OptionCandidateEvaluation, OptionContract, TradeSignal } from "../types.js";
import { marketDate, parseClock, secondsSinceMidnight, zonedDateTimeToEpoch } from "../utils/time.js";
import { validateOptionQuote } from "../features/quoteSanitizer.js";
import { blackScholes, impliedVolatility } from "./blackScholes.js";
import { evaluateOptionCost, gammaAwareProjectedOptionMove } from "./costGate.js";
import type { OptionBook, OptionBookEntry } from "./optionBook.js";
import { sameDaySpyOptionContractReasons } from "./tradingInvariants.js";

export interface SelectionResult {
  selected?: OptionCandidateEvaluation;
  evaluations: OptionCandidateEvaluation[];
  rejectionCounts: Record<string, number>;
}

export class OptionSelector {
  readonly #config: EngineConfig;
  constructor(config: EngineConfig) { this.#config = config; }

  select(signal: TradeSignal, contracts: readonly OptionContract[], book: OptionBook): SelectionResult {
    const evaluations = contracts.map((contract) => this.evaluate(contract, book.get(contract.symbol), signal));
    const eligible = evaluations.filter((candidate) => candidate.eligible)
      .sort((a, b) => b.score! - a.score!);
    const rejectionCounts: Record<string, number> = {};
    for (const candidate of evaluations) for (const reason of candidate.rejectionReasons) {
      rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
    }
    return {
      ...(eligible[0] ? { selected: eligible[0] } : {}),
      evaluations,
      rejectionCounts,
    };
  }

  evaluate(contract: OptionContract, entry: OptionBookEntry | undefined, signal: TradeSignal): OptionCandidateEvaluation {
    const rejectionReasons: string[] = [];
    const expectedType = signal.direction === "BULLISH" ? "call" : "put";
    const date = marketDate(signal.timestamp, this.#config.timeZone);
    if (!contract.active || !contract.tradable) rejectionReasons.push("INACTIVE_OR_NOT_TRADABLE");
    if (contract.type !== expectedType) rejectionReasons.push("WRONG_OPTION_TYPE");
    rejectionReasons.push(...sameDaySpyOptionContractReasons(contract, signal.timestamp, this.#config.timeZone));
    if (contract.expirationDate !== date) rejectionReasons.push("NOT_SAME_DAY_EXPIRATION");
    if (secondsSinceMidnight(signal.timestamp, this.#config.timeZone) > parseClock(this.#config.options.zeroDteEntryCutoff)) rejectionReasons.push("ZERO_DTE_CUTOFF");
    if (Math.abs(contract.strike / signal.featureSnapshot.price - 1) > this.#config.options.strikeRangePct) rejectionReasons.push("STRIKE_OUTSIDE_RANGE");
    const quoteValidation = entry?.quote
      ? validateOptionQuote(entry.quote, signal.timestamp, this.#config.dataQuality)
      : { usable: false, reasons: ["MISSING_QUOTE"] };
    if (!quoteValidation.usable) rejectionReasons.push(...quoteValidation.reasons.map((reason) => `QUOTE_${reason}`));
    const quote = entry?.quote;
    const mid = quote ? (quote.bidPrice + quote.askPrice) / 2 : undefined;
    const spreadPct = quote && mid ? (quote.askPrice - quote.bidPrice) / mid : undefined;
    if (mid !== undefined && (mid < this.#config.options.minOptionMid || mid > this.#config.options.maxOptionMid)) rejectionReasons.push("MIDPOINT_OUTSIDE_RANGE");
    if ((entry?.snapshot?.dailyVolume ?? -Infinity) < this.#config.options.minDailyVolume) rejectionReasons.push("INSUFFICIENT_DAILY_VOLUME");
    if ((entry?.snapshot?.openInterest ?? -Infinity) < this.#config.options.minOpenInterest) rejectionReasons.push("INSUFFICIENT_OPEN_INTEREST");

    let iv = entry?.snapshot?.impliedVolatility;
    const expiry = zonedDateTimeToEpoch(contract.expirationDate, "16:00:00", this.#config.timeZone);
    const tau = Math.max(1 / (365 * 24 * 60 * 60), (expiry - signal.timestamp) / (365 * 24 * 60 * 60 * 1000));
    const modelBase = {
      spot: signal.featureSnapshot.price,
      strike: contract.strike,
      timeToExpiryYears: tau,
      riskFreeRate: this.#config.options.riskFreeRate,
      dividendYield: this.#config.options.dividendYield,
      type: contract.type,
    } as const;
    if (!(iv !== undefined && iv > 0 && iv <= this.#config.options.maxImpliedVolatility) && mid !== undefined) {
      iv = impliedVolatility({ ...modelBase, marketPrice: mid, maximumVolatility: this.#config.options.maxImpliedVolatility });
    }
    // Versioned conservative fallback keeps replay deterministic when inversion is unavailable.
    if (!(iv !== undefined && iv > 0 && iv <= this.#config.options.maxImpliedVolatility)) iv = this.#config.options.fallbackImpliedVolatility;
    let delta = entry?.snapshot?.greeks?.delta;
    let gamma = entry?.snapshot?.greeks?.gamma;
    if (!(delta !== undefined && Number.isFinite(delta)) || !(gamma !== undefined && gamma >= 0)) {
      const greeks = blackScholes({ ...modelBase, volatility: iv });
      if (!(delta !== undefined && Number.isFinite(delta))) delta = greeks.delta;
      if (!(gamma !== undefined && gamma >= 0)) gamma = greeks.gamma;
    }
    const absoluteDelta = Math.abs(delta);
    if (!(absoluteDelta >= this.#config.options.minAbsDelta && absoluteDelta <= this.#config.options.maxAbsDelta)) rejectionReasons.push("DELTA_OUTSIDE_RANGE");

    let cost: ReturnType<typeof evaluateOptionCost> | undefined;
    if (quote && absoluteDelta > 0) {
      cost = evaluateOptionCost(
        quote.bidPrice, quote.askPrice, absoluteDelta, signal.featureSnapshot.price, signal.projectedMoveBps,
        this.#config.options.slippagePerSidePctOfSpread, this.#config.signals.costMultiplier,
      );
      if (!cost.passes) rejectionReasons.push("PROJECTED_MOVE_FAILS_COST_GATE");
    }
    const eligible = rejectionReasons.length === 0;
    const liquidity = 0.12 * (
      Math.log(1 + (entry?.snapshot?.dailyVolume ?? 0)) + 0.5 * Math.log(1 + (entry?.snapshot?.openInterest ?? 0))
    );
    const score = eligible
      ? 4 * cost!.costMarginBps - 15 * Math.abs(absoluteDelta - this.#config.options.targetAbsDelta)
        - 8 * spreadPct! + liquidity
      : undefined;
    return {
      symbol: contract.symbol,
      contract,
      delta,
      gamma,
      impliedVolatility: iv,
      ...(mid !== undefined ? { mid } : {}),
      ...(spreadPct !== undefined ? { spreadPct } : {}),
      ...(cost ? {
        roundTripCostPerShare: cost.roundTripCostPerShare,
        equivalentUnderlyingCostBps: cost.equivalentUnderlyingCostBps,
        requiredMoveBps: cost.requiredMoveBps,
        costMarginBps: cost.costMarginBps,
        gammaAwareProjectedOptionMove: gammaAwareProjectedOptionMove(signal.featureSnapshot.price, signal.projectedMoveBps, absoluteDelta, gamma),
      } : {}),
      ...(score !== undefined ? { score } : {}),
      eligible,
      rejectionReasons: [...new Set(rejectionReasons)],
    };
  }
}
