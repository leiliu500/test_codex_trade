import type { EngineConfig } from "../config.js";
import type {
  ExitDecision, ExitReason, ExitTrigger, FeatureSnapshot, OptionQuote, OptionSnapshot, PositionState,
  RegimeDecision,
} from "../types.js";
import { isAtOrAfter } from "../utils/time.js";
import { estimateOptionContinuation } from "./optionContinuation.js";
import { firstPassageUpperProbability, TradeStateEstimator } from "./tradeStateEstimator.js";

export interface ExitContext {
  timestamp: number;
  position: PositionState;
  optionQuote?: OptionQuote;
  feature?: FeatureSnapshot;
  regime?: RegimeDecision;
  killSwitch: boolean;
  brokerStateReliable?: boolean;
  dailyRealizedPnl?: number;
  recoveryProbability?: number;
  continuationLcbDollars?: number;
  trendProbability?: number;
  optionSnapshot?: OptionSnapshot;
}

/**
 * Optimal-stopping controller. It emits one logical decision; broker order
 * retries belong to LiveOrderManager and may not turn this decision back into HOLD.
 */
export class ExitManager {
  readonly #config: EngineConfig;
  readonly #estimator: TradeStateEstimator;

  constructor(config: EngineConfig) {
    this.#config = config;
    this.#estimator = new TradeStateEstimator(config);
  }

  evaluate(context: ExitContext): ExitDecision {
    let position: PositionState = { ...context.position };
    const quote = context.optionQuote;
    const quoteStale = !quote ||
      context.timestamp - quote.timestamp > this.#config.risk.staleDataEmergencySec * 1000;
    const quoteInvalid = quote !== undefined && (
      !(quote.bidPrice > 0) ||
      !(quote.askPrice > quote.bidPrice) ||
      (quote.askPrice - quote.bidPrice) /
        Math.max(Number.EPSILON, (quote.askPrice + quote.bidPrice) / 2) >
          this.#config.dataQuality.maxOptionSpreadPct
    );
    const mark = quote ? (quote.bidPrice + quote.askPrice) / 2 : undefined;
    let liquidationPrice = quote?.bidPrice;
    let executablePnl = position.executablePnl;

    if (quote) {
      const estimate = this.#estimator.estimate(position, quote, context.timestamp, context.feature);
      position = estimate.position;
      liquidationPrice = estimate.liquidationPrice;
      executablePnl = estimate.executablePnl;
    }

    const triggers: ExitTrigger[] = [];
    const trigger = (value: ExitTrigger): void => {
      if (!triggers.includes(value)) triggers.push(value);
    };

    if (context.killSwitch || context.brokerStateReliable === false || quoteStale || quoteInvalid) {
      trigger("BROKER_OR_POSITION_RISK");
    }
    if (isAtOrAfter(context.timestamp, this.#config.session.forceExit, this.#config.timeZone)) {
      trigger("FORCED_TIME_EXIT");
    }
    if (context.dailyRealizedPnl !== undefined &&
        context.dailyRealizedPnl <= -this.#config.risk.maxDailyLossDollars) {
      trigger("DAILY_RISK_SHUTDOWN");
    }

    if (executablePnl !== undefined) {
      const riskBudget = 100 * position.quantity *
        Math.max(0, position.averageEntryPrice - position.stopPrice);
      if (executablePnl <= -riskBudget || liquidationPrice! <= position.stopPrice) {
        trigger("HARD_LOSS_BOUNDARY");
      }
      if (position.tradeState === "PROTECTED_SOFT" &&
          position.protectedFloorPnl !== undefined) {
        if (executablePnl > position.protectedFloorPnl) {
          delete position.softFloorBreachStartedAt;
          delete position.softFloorBreachCandidateObservationCount;
        } else if (
          executablePnl <= -this.#config.risk.softProtectionEmergencyLossDollars
        ) {
          trigger("PROFIT_FLOOR_BREACH");
        } else {
          if (position.softFloorBreachStartedAt === undefined ||
              position.softFloorBreachCandidateObservationCount === undefined) {
            position.softFloorBreachStartedAt = context.timestamp;
            position.softFloorBreachCandidateObservationCount =
              position.pnlObservationCount;
          }
          const breachObservations = 1 + Math.max(
            0,
            position.pnlObservationCount -
              position.softFloorBreachCandidateObservationCount,
          );
          if (
            context.timestamp - position.softFloorBreachStartedAt >=
              this.#config.risk.softFloorBreachConfirmationMs &&
            breachObservations >=
              this.#config.risk.softFloorBreachMinimumObservations
          ) {
            trigger("PROFIT_FLOOR_BREACH");
          }
        }
      } else {
        delete position.softFloorBreachStartedAt;
        delete position.softFloorBreachCandidateObservationCount;
        if ((position.tradeState === "PROTECTED_WINNER" ||
             position.tradeState === "PROTECTED_RECOVERED") &&
            position.protectedFloorPnl !== undefined &&
            executablePnl <= position.protectedFloorPnl) {
          trigger("PROFIT_FLOOR_BREACH");
        }
      }
    }

    const oppositeRegime = context.regime &&
      isOppositeRegime(position.direction, context.regime.regime);
    if (oppositeRegime) {
      const evidenceTimestamp = context.feature?.timestamp ?? context.timestamp;
      if (position.oppositeRegimeSince === undefined) {
        position.oppositeRegimeSince = evidenceTimestamp;
        position.oppositeRegimeObservationCount = 1;
        position.lastOppositeRegimeFeatureTimestamp = evidenceTimestamp;
      } else if (
        position.lastOppositeRegimeFeatureTimestamp === undefined ||
        evidenceTimestamp > position.lastOppositeRegimeFeatureTimestamp
      ) {
        position.oppositeRegimeObservationCount =
          (position.oppositeRegimeObservationCount ?? 0) + 1;
        position.lastOppositeRegimeFeatureTimestamp = evidenceTimestamp;
      }
      const oppositeRegimeSince = position.oppositeRegimeSince;
      const oppositeRegimeObservations = position.oppositeRegimeObservationCount ?? 0;
      if (
        context.timestamp - oppositeRegimeSince >=
          this.#config.risk.oppositeRegimeGraceSec * 1000 &&
        oppositeRegimeObservations >=
          this.#config.risk.oppositeRegimeMinimumObservations
      ) {
        trigger("STRUCTURAL_INVALIDATION");
      }
    } else if (context.regime) {
      delete position.oppositeRegimeSince;
      delete position.oppositeRegimeObservationCount;
      delete position.lastOppositeRegimeFeatureTimestamp;
    }

    if (context.feature) {
      const directionSign = position.direction === "BULLISH" ? 1 : -1;
      const vwap = context.feature.vwap.sessionVwap;
      const structureValid =
        directionSign * context.feature.medium.normalizedSlope > 0 &&
        (vwap === undefined || directionSign * (context.feature.price - vwap) > 0);
      if (structureValid) {
        delete position.invalidSince;
      } else if (position.invalidSince === undefined) {
        position.invalidSince = context.timestamp;
      } else if (
        context.timestamp - position.invalidSince >=
          this.#config.risk.trendInvalidationGraceSec * 1000
      ) {
        trigger("STRUCTURAL_INVALIDATION");
      }
    }

    if (position.reversalCusum >= this.#config.risk.reversalCusumThreshold &&
        isFullyProtected(position)) {
      trigger("REVERSAL_CUSUM");
    }

    const ageSec = (context.timestamp - position.entryTimestamp) / 1000;
    const usingFallbackRecoveryProbability = context.recoveryProbability === undefined;
    let recoveryProbability = context.recoveryProbability;
    if (recoveryProbability === undefined &&
        isRecoveryManaged(position) &&
        position.lowWaterPnl <=
          -this.#config.risk.meaningfulAdverseExcursionDollars &&
        position.executablePnl < 0 &&
        ageSec >= this.#config.risk.recoveryProbabilityMinAgeSec &&
        position.pnlObservationCount >=
          this.#config.risk.recoveryProbabilityMinObservations) {
      const riskBudget = positionRiskBudget(position);
      recoveryProbability = firstPassageUpperProbability(
        position.executablePnl,
        -riskBudget,
        this.#config.risk.recoveredActivationDollars,
        position.pnlEwmaDriftPerSec,
        position.pnlEwmaVariancePerSec,
      );
    }
    if (recoveryProbability !== undefined) {
      position.estimatedRecoveryProbability = recoveryProbability;
    }
    if (recoveryProbability !== undefined &&
        recoveryProbability <= minimumRecoveryProbability(position, this.#config)) {
      if (!usingFallbackRecoveryProbability) {
        trigger("RECOVERY_PROBABILITY_TOO_LOW");
      } else {
        position.recoveryProbabilityInvalidSince ??= context.timestamp;
        if (context.timestamp - position.recoveryProbabilityInvalidSince >=
            this.#config.risk.recoveryProbabilityGraceSec * 1000) {
          trigger("RECOVERY_PROBABILITY_TOO_LOW");
        }
      }
    } else {
      delete position.recoveryProbabilityInvalidSince;
    }

    let greeksContinuationFired = false;
    if (quote) {
      const continuation = estimateOptionContinuation(
        position,
        quote,
        context.optionSnapshot,
        context.feature,
        context.timestamp,
        this.#config,
      );
      position = continuation.position;
      if (continuation.exitReady) {
        greeksContinuationFired = true;
        trigger("CONTINUATION_LCB_NON_POSITIVE");
      }
    }
    if (context.continuationLcbDollars !== undefined) {
      position.optionContinuationLcbDollars = context.continuationLcbDollars;
      if (context.continuationLcbDollars <= 0) {
        trigger("CONTINUATION_LCB_NON_POSITIVE");
      }
    }
    if (context.trendProbability !== undefined &&
        context.trendProbability < 0.5 &&
        isFullyProtected(position)) {
      trigger("CONTINUATION_LCB_NON_POSITIVE");
    }

    const recoveryDeadlineFired = isRecoveryManaged(position) &&
      ageSec >= this.#config.risk.recoveryDeadlineSec;
    if (recoveryDeadlineFired) {
      trigger("RECOVERY_PROBABILITY_TOO_LOW");
    }
    const maxHoldFired = ageSec >= this.#config.risk.maxHoldSec;
    if (maxHoldFired) trigger("STALL_OR_OPPORTUNITY_COST");

    const timeSinceHighSec =
      (context.timestamp - position.lastHighTimestamp) / 1000;
    if (executablePnl !== undefined &&
        executablePnl > 0 &&
        isRecoveryManaged(position) &&
        timeSinceHighSec >= this.#config.risk.stallSec &&
        context.continuationLcbDollars !== undefined &&
        context.continuationLcbDollars <= 0) {
      trigger("STALL_OR_OPPORTUNITY_COST");
    }

    if (triggers.length === 0) {
      return {
        exit: false,
        ...(mark !== undefined ? { markPrice: mark } : {}),
        ...(liquidationPrice !== undefined ? { liquidationPrice } : {}),
        ...(executablePnl !== undefined ? { executablePnl } : {}),
        ...(position.protectedFloorPnl !== undefined
          ? { protectedFloorPnl: position.protectedFloorPnl }
          : {}),
        ...(position.estimatedRecoveryProbability !== undefined
          ? { recoveryProbability: position.estimatedRecoveryProbability }
          : {}),
        ...(position.optionContinuationLcbDollars !== undefined
          ? { continuationLcbDollars: position.optionContinuationLcbDollars }
          : {}),
        updatedPosition: position,
      };
    }

    triggers.sort((left, right) =>
      EXIT_TRIGGER_PRIORITY.indexOf(left) - EXIT_TRIGGER_PRIORITY.indexOf(right));
    const primary = triggers[0]!;
    return finish(
      position,
      reasonForTrigger(primary, context, {
        greeksContinuationFired,
        maxHoldFired,
        recoveryDeadlineFired,
        quoteStale,
        quoteInvalid,
      }),
      triggers,
      mark,
      liquidationPrice,
      executablePnl,
    );
  }
}

const EXIT_TRIGGER_PRIORITY: readonly ExitTrigger[] = [
  "BROKER_OR_POSITION_RISK",
  "FORCED_TIME_EXIT",
  "HARD_LOSS_BOUNDARY",
  "STRUCTURAL_INVALIDATION",
  "PROFIT_FLOOR_BREACH",
  "REVERSAL_CUSUM",
  "RECOVERY_PROBABILITY_TOO_LOW",
  "CONTINUATION_LCB_NON_POSITIVE",
  "STALL_OR_OPPORTUNITY_COST",
  "DAILY_RISK_SHUTDOWN",
];

function finish(
  position: PositionState,
  reason: ExitReason,
  triggers: ExitTrigger[],
  markPrice?: number,
  liquidationPrice?: number,
  executablePnl?: number,
): ExitDecision {
  return {
    exit: true,
    reason,
    triggers,
    ...(markPrice !== undefined ? { markPrice } : {}),
    ...(liquidationPrice !== undefined ? { liquidationPrice } : {}),
    ...(executablePnl !== undefined ? { executablePnl } : {}),
    ...(position.protectedFloorPnl !== undefined
      ? { protectedFloorPnl: position.protectedFloorPnl }
      : {}),
    ...(position.estimatedRecoveryProbability !== undefined
      ? { recoveryProbability: position.estimatedRecoveryProbability }
      : {}),
    ...(position.optionContinuationLcbDollars !== undefined
      ? { continuationLcbDollars: position.optionContinuationLcbDollars }
      : {}),
    updatedPosition: position,
  };
}

function reasonForTrigger(
  trigger: ExitTrigger,
  context: ExitContext,
  flags: {
    greeksContinuationFired: boolean;
    maxHoldFired: boolean;
    recoveryDeadlineFired: boolean;
    quoteStale: boolean;
    quoteInvalid: boolean;
  },
): ExitReason {
  switch (trigger) {
    case "BROKER_OR_POSITION_RISK":
      if (context.killSwitch) return "KILL_SWITCH";
      if (context.brokerStateReliable === false) return "BROKER_OR_POSITION_RISK";
      if (flags.quoteStale) return "STALE_DATA";
      if (flags.quoteInvalid) return "BROKER_OR_POSITION_RISK";
      return "BROKER_OR_POSITION_RISK";
    case "FORCED_TIME_EXIT": return "FORCED_SESSION_EXIT";
    case "HARD_LOSS_BOUNDARY": return "HARD_STOP";
    case "STRUCTURAL_INVALIDATION":
      return context.regime &&
        isOppositeRegime(context.position.direction, context.regime.regime)
        ? "OPPOSITE_REGIME"
        : "TREND_INVALIDATION";
    case "PROFIT_FLOOR_BREACH": return "PROFIT_FLOOR_EXIT";
    case "REVERSAL_CUSUM": return "REVERSAL_CUSUM";
    case "RECOVERY_PROBABILITY_TOO_LOW":
      return flags.recoveryDeadlineFired ? "RECOVERY_TIMEOUT" : "RECOVERY_PROBABILITY_TOO_LOW";
    case "CONTINUATION_LCB_NON_POSITIVE":
      if (flags.greeksContinuationFired) return "GREEKS_CONTINUATION_LCB_NON_POSITIVE";
      return "CONTINUATION_LCB_NON_POSITIVE";
    case "STALL_OR_OPPORTUNITY_COST":
      return flags.maxHoldFired ? "MAX_HOLD" : "STALL_OR_OPPORTUNITY_COST";
    case "DAILY_RISK_SHUTDOWN": return "DAILY_RISK_SHUTDOWN";
  }
}

function minimumRecoveryProbability(position: PositionState, config: EngineConfig): number {
  const current = position.executablePnl;
  const riskBudget = positionRiskBudget(position);
  const activationValue = config.risk.recoveredActivationDollars;
  return clamp(
    (current + riskBudget) / Math.max(Number.EPSILON, activationValue + riskBudget),
    0,
    1,
  );
}

function positionRiskBudget(position: PositionState): number {
  return 100 * position.quantity *
    Math.max(0, position.averageEntryPrice - position.stopPrice);
}

function isOppositeRegime(
  direction: PositionState["direction"],
  regime: RegimeDecision["regime"],
): boolean {
  const down = new Set(["STRONG_DOWN", "GRIND_DOWN", "GAP_AND_GO_DOWN", "REVERSAL_DOWN"]);
  const up = new Set(["STRONG_UP", "GRIND_UP", "GAP_AND_GO_UP", "REVERSAL_UP"]);
  return direction === "BULLISH" ? down.has(regime) : up.has(regime);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isFullyProtected(position: PositionState): boolean {
  return position.tradeState === "PROTECTED_WINNER" ||
    position.tradeState === "PROTECTED_RECOVERED";
}

function isRecoveryManaged(position: PositionState): boolean {
  return position.tradeState === "OPEN_UNPROTECTED" ||
    position.tradeState === "PROTECTED_SOFT";
}
