import type { EngineConfig } from "../config.js";
import type { OptionCandidateEvaluation, OptionContract, TradeSignal } from "../types.js";
import { marketDate, parseClock, secondsSinceMidnight, zonedDateTimeToEpoch } from "../utils/time.js";
import { validateOptionQuote } from "../features/quoteSanitizer.js";
import { blackScholes, impliedVolatility } from "./blackScholes.js";
import { evaluateOptionCost, gammaAwareProjectedOptionMove } from "./costGate.js";
import { OptionBook, type OptionBookEntry } from "./optionBook.js";
import { sameDayOptionContractReasons } from "./tradingInvariants.js";
import {
  activeSignalEntryGuard, projectedMoveContinuationGuard,
} from "../strategy/lateEntryGuard.js";

export interface SelectionResult {
  selected?: OptionCandidateEvaluation;
  evaluations: OptionCandidateEvaluation[];
  rejectionCounts: Record<string, number>;
}

const STATIC_SPREAD_REJECTION = /^(MORNING|LATE)_ENTRY_OPTION_SPREAD_TOO_WIDE$/;

export function isTransientOptionSelectionReason(reason: string): boolean {
  return reason.startsWith("QUOTE_") ||
    reason.startsWith("OPTION_MICROSTRUCTURE_") ||
    reason.startsWith("CHAIN_MICROSTRUCTURE_") ||
    reason === "PROJECTED_MOVE_FAILS_COST_GATE" ||
    reason.endsWith("_COST_MARGIN_BELOW_MINIMUM") ||
    STATIC_SPREAD_REJECTION.test(reason);
}

export function relevantOptionEvaluations(
  signal: TradeSignal,
  selection: SelectionResult,
  config: EngineConfig,
): OptionCandidateEvaluation[] {
  const expectedType = signal.direction === "BULLISH" ? "call" : "put";
  return selection.evaluations
    .filter((evaluation) => evaluation.contract?.type === expectedType)
    .sort((left, right) =>
      Number(right.eligible) - Number(left.eligible) ||
      (right.score ?? -Infinity) - (left.score ?? -Infinity) ||
      left.rejectionReasons.length - right.rejectionReasons.length ||
      Math.abs(Math.abs(left.delta ?? Infinity) - config.options.targetAbsDelta) -
        Math.abs(Math.abs(right.delta ?? Infinity) - config.options.targetAbsDelta) ||
      (right.costMarginBps ?? -Infinity) - (left.costMarginBps ?? -Infinity) ||
      left.symbol.localeCompare(right.symbol));
}

export function retryableOptionEvaluations(
  signal: TradeSignal,
  selection: SelectionResult,
  config: EngineConfig,
): OptionCandidateEvaluation[] {
  return relevantOptionEvaluations(signal, selection, config).filter((evaluation) =>
    evaluation.rejectionReasons.length > 0 &&
    evaluation.rejectionReasons.every(isTransientOptionSelectionReason));
}

export class OptionSelector {
  readonly #config: EngineConfig;
  constructor(config: EngineConfig) { this.#config = config; }

  select(
    signal: TradeSignal,
    contracts: readonly OptionContract[],
    book: OptionBook,
    decisionTimestamp = signal.timestamp,
  ): SelectionResult {
    const evaluations = contracts.map((contract) =>
      this.evaluate(contract, book.get(contract.symbol), signal, decisionTimestamp, book));
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

  evaluate(
    contract: OptionContract,
    entry: OptionBookEntry | undefined,
    signal: TradeSignal,
    decisionTimestamp = signal.timestamp,
    sourceBook?: OptionBook,
  ): OptionCandidateEvaluation {
    const rejectionReasons: string[] = [];
    const expectedType = signal.direction === "BULLISH" ? "call" : "put";
    const date = marketDate(signal.timestamp, this.#config.timeZone);
    if (!contract.active || !contract.tradable) rejectionReasons.push("INACTIVE_OR_NOT_TRADABLE");
    if (contract.type !== expectedType) rejectionReasons.push("WRONG_OPTION_TYPE");
    rejectionReasons.push(...sameDayOptionContractReasons(
      contract, signal.timestamp, this.#config.timeZone, this.#config.symbol,
    ));
    if (contract.expirationDate !== date) rejectionReasons.push("NOT_SAME_DAY_EXPIRATION");
    if (secondsSinceMidnight(signal.timestamp, this.#config.timeZone) > parseClock(this.#config.options.zeroDteEntryCutoff)) rejectionReasons.push("ZERO_DTE_CUTOFF");
    if (Math.abs(contract.strike / signal.featureSnapshot.price - 1) > this.#config.options.strikeRangePct) rejectionReasons.push("STRIKE_OUTSIDE_RANGE");
    const quoteValidation = entry?.quote
      ? validateOptionQuote(entry.quote, decisionTimestamp, this.#config.dataQuality)
      : { usable: false, reasons: ["MISSING_QUOTE"] };
    if (!quoteValidation.usable) rejectionReasons.push(...quoteValidation.reasons.map((reason) => `QUOTE_${reason}`));
    const quote = entry?.quote;
    const mid = quote ? (quote.bidPrice + quote.askPrice) / 2 : undefined;
    const spreadPct = quote && mid ? (quote.askPrice - quote.bidPrice) / mid : undefined;
    const staticEntryGuard = activeSignalEntryGuard(this.#config, signal);
    if (mid !== undefined && (mid < this.#config.options.minOptionMid || mid > this.#config.options.maxOptionMid)) rejectionReasons.push("MIDPOINT_OUTSIDE_RANGE");
    const optionSpread = quote ? quote.askPrice - quote.bidPrice : undefined;
    const exceedsSpreadTicks = staticEntryGuard?.maxOptionSpreadTicks !== undefined &&
      optionSpread !== undefined &&
      optionSpread > staticEntryGuard.maxOptionSpreadTicks * this.#config.execution.optionTickSize + 1e-9;
    if (staticEntryGuard && spreadPct !== undefined &&
        (spreadPct > staticEntryGuard.maxOptionSpreadPct || exceedsSpreadTicks)) {
      rejectionReasons.push(`${staticEntryGuard.reasonPrefix}OPTION_SPREAD_TOO_WIDE`);
    }
    const dailyVolume = entry?.snapshot?.dailyVolume ?? -Infinity;
    const openInterest = entry?.snapshot?.openInterest ?? -Infinity;
    if (dailyVolume < this.#config.options.minDailyVolume) {
      rejectionReasons.push("INSUFFICIENT_DAILY_VOLUME");
    }
    if (openInterest < this.#config.options.minOpenInterest &&
        dailyVolume < this.#config.options.minDailyVolumeForOpenInterestFallback) {
      rejectionReasons.push("INSUFFICIENT_OPEN_INTEREST");
    }

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
    let theta = entry?.snapshot?.greeks?.theta;
    let vega = entry?.snapshot?.greeks?.vega;
    if (!(delta !== undefined && Number.isFinite(delta)) || !(gamma !== undefined && gamma >= 0) ||
        !(theta !== undefined && Number.isFinite(theta)) || !(vega !== undefined && vega >= 0)) {
      const greeks = blackScholes({ ...modelBase, volatility: iv });
      if (!(delta !== undefined && Number.isFinite(delta))) delta = greeks.delta;
      if (!(gamma !== undefined && gamma >= 0)) gamma = greeks.gamma;
      if (!(theta !== undefined && Number.isFinite(theta))) theta = greeks.thetaPerCalendarDay;
      if (!(vega !== undefined && vega >= 0)) vega = greeks.vegaPerVolPoint;
    }
    const absoluteDelta = Math.abs(delta);
    if (!(absoluteDelta >= this.#config.options.minAbsDelta && absoluteDelta <= this.#config.options.maxAbsDelta)) rejectionReasons.push("DELTA_OUTSIDE_RANGE");

    const microstructureConfig = this.#config.options.microstructure;
    const evaluationBook = sourceBook ?? evaluationBookFor(
      contract,
      entry,
      microstructureConfig.windowSec * 1_000,
    );
    const optionMicrostructure = evaluationBook.microstructure(contract.symbol, decisionTimestamp);
    const chainConfirmation = evaluationBook.chainConfirmation(
      contract.type,
      decisionTimestamp,
      contract.strike,
      this.#config.options.strikeRangePct * 2,
    );
    if (microstructureConfig.enabled) {
      if (!optionMicrostructure) rejectionReasons.push("OPTION_MICROSTRUCTURE_UNAVAILABLE");
      else {
        if (!optionMicrostructure.dataFresh) rejectionReasons.push("OPTION_MICROSTRUCTURE_STALE");
        if (optionMicrostructure.quoteEvents < microstructureConfig.minimumQuoteEvents) {
          rejectionReasons.push("OPTION_MICROSTRUCTURE_INSUFFICIENT_QUOTES");
        }
        if (optionMicrostructure.confirmationScore < microstructureConfig.minimumEntryScore) {
          rejectionReasons.push("OPTION_MICROSTRUCTURE_ADVERSE");
        }
        if (optionMicrostructure.spreadExpansionRatio >
            microstructureConfig.maximumSpreadExpansionRatio) {
          rejectionReasons.push("OPTION_MICROSTRUCTURE_SPREAD_EXPANDING");
        }
      }
      if (chainConfirmation.observedContracts < microstructureConfig.minimumChainObservedContracts) {
        rejectionReasons.push("CHAIN_MICROSTRUCTURE_UNAVAILABLE");
      } else if (chainConfirmation.averageScore < microstructureConfig.minimumChainAverageScore) {
        rejectionReasons.push("CHAIN_MICROSTRUCTURE_ADVERSE");
      }
    }

    const expectedThetaCostPerShare = Math.max(0, -(theta ?? 0)) *
      this.#config.signals.projectionHorizonSec / 86_400 *
      microstructureConfig.thetaCostMultiplier;
    const expectedVegaRiskPerShare = Math.max(0, vega ?? 0) *
      microstructureConfig.adverseIvMovePoints;
    const holdingCostPerShare = expectedThetaCostPerShare + expectedVegaRiskPerShare;

    let cost: ReturnType<typeof evaluateOptionCost> | undefined;
    if (quote && absoluteDelta > 0) {
      cost = evaluateOptionCost(
        quote.bidPrice, quote.askPrice, absoluteDelta, signal.featureSnapshot.price, signal.projectedMoveBps,
        this.#config.options.slippagePerSidePctOfSpread, this.#config.signals.costMultiplier,
        holdingCostPerShare,
      );
      if (!cost.passes) rejectionReasons.push("PROJECTED_MOVE_FAILS_COST_GATE");
      if (staticEntryGuard && cost.costMarginBps < staticEntryGuard.minCostMarginBps) {
        rejectionReasons.push(`${staticEntryGuard.reasonPrefix}COST_MARGIN_BELOW_MINIMUM`);
      }
    }
    if (staticEntryGuard && signal.projectedMoveBps < staticEntryGuard.minProjectedMoveBps &&
        !projectedMoveContinuationGuard(this.#config, signal)) {
      rejectionReasons.push(`${staticEntryGuard.reasonPrefix}PROJECTED_MOVE_BELOW_MINIMUM`);
    }
    const eligible = rejectionReasons.length === 0;
    const liquidity = 0.12 * (
      Math.log(1 + (entry?.snapshot?.dailyVolume ?? 0)) + 0.5 * Math.log(1 + (entry?.snapshot?.openInterest ?? 0))
    );
    const gammaProjectedMove = gammaAwareProjectedOptionMove(
      signal.featureSnapshot.price, signal.projectedMoveBps, absoluteDelta, gamma,
    );
    const expectedNetOptionMove = cost
      ? gammaProjectedMove - cost.roundTripCostPerShare
      : undefined;
    const ivSkewVsNearby = chainConfirmation.nearbyIvMedian !== undefined
      ? iv - chainConfirmation.nearbyIvMedian : undefined;
    const score = eligible
      ? 4 * cost!.costMarginBps - 15 * Math.abs(absoluteDelta - this.#config.options.targetAbsDelta)
        - 8 * spreadPct! + liquidity +
        microstructureConfig.scoreWeight * (optionMicrostructure?.confirmationScore ?? 0) +
        microstructureConfig.chainScoreWeight * chainConfirmation.averageScore
      : undefined;
    return {
      symbol: contract.symbol,
      contract,
      delta,
      gamma,
      impliedVolatility: iv,
      expectedThetaCostPerShare,
      expectedVegaRiskPerShare,
      ...(expectedNetOptionMove !== undefined ? { expectedNetOptionMove } : {}),
      ...(optionMicrostructure ? { optionMicrostructure } : {}),
      chainConfirmation,
      ...(ivSkewVsNearby !== undefined ? { ivSkewVsNearby } : {}),
      ...(mid !== undefined ? { mid } : {}),
      ...(spreadPct !== undefined ? { spreadPct } : {}),
      ...(cost ? {
        roundTripCostPerShare: cost.roundTripCostPerShare,
        equivalentUnderlyingCostBps: cost.equivalentUnderlyingCostBps,
        requiredMoveBps: cost.requiredMoveBps,
        costMarginBps: cost.costMarginBps,
        gammaAwareProjectedOptionMove: gammaProjectedMove,
      } : {}),
      ...(score !== undefined ? { score } : {}),
      eligible,
      rejectionReasons: [...new Set(rejectionReasons)],
    };
  }

}

function evaluationBookFor(
  contract: OptionContract,
  entry: OptionBookEntry | undefined,
  windowMs: number,
): OptionBook {
  const book = new OptionBook(windowMs);
  book.upsertContract(entry?.contract ?? contract);
  if (entry?.snapshot) book.updateSnapshot(entry.snapshot);
  if (entry?.quote) book.updateQuote(entry.quote);
  return book;
}
