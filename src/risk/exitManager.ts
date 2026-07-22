import type { EngineConfig } from "../config.js";
import type { ExitDecision, FeatureSnapshot, OptionQuote, PositionState, RegimeDecision } from "../types.js";
import { isAtOrAfter } from "../utils/time.js";

export interface ExitContext {
  timestamp: number;
  position: PositionState;
  optionQuote?: OptionQuote;
  feature?: FeatureSnapshot;
  regime?: RegimeDecision;
  killSwitch: boolean;
}

export class ExitManager {
  readonly #config: EngineConfig;
  constructor(config: EngineConfig) { this.#config = config; }

  evaluate(context: ExitContext): ExitDecision {
    const position: PositionState = { ...context.position };
    const quote = context.optionQuote;
    const mark = quote ? (quote.bidPrice + quote.askPrice) / 2 : undefined;
    const finish = (reason: NonNullable<ExitDecision["reason"]>): ExitDecision => ({
      exit: true,
      reason,
      ...(mark !== undefined ? { markPrice: mark, liquidationPrice: quote!.bidPrice } : {}),
      updatedPosition: position,
    });

    // Emergency precedence is intentionally explicit and ordered.
    if (context.killSwitch) return finish("KILL_SWITCH");
    if (isAtOrAfter(context.timestamp, this.#config.session.forceExit, this.#config.timeZone)) return finish("FORCED_SESSION_EXIT");
    if (!quote || context.timestamp - quote.timestamp > this.#config.risk.staleDataEmergencySec * 1000) return finish("STALE_DATA");
    position.highWaterMark = Math.max(position.highWaterMark, mark!);
    position.lowWaterMark = Math.min(position.lowWaterMark, mark!);
    if (mark! <= position.stopPrice) return finish("HARD_STOP");
    if (mark! >= position.targetPrice) return finish("PROFIT_TARGET");

    if (position.highWaterMark >= position.averageEntryPrice * (1 + this.#config.risk.trailingActivationPct)) {
      const trailingStop = Math.max(
        position.highWaterMark * (1 - this.#config.risk.trailingDrawdownPct),
        position.averageEntryPrice * (1 + this.#config.risk.trailingProfitFloorPct),
      );
      if (mark! <= trailingStop) return finish("TRAILING_STOP");
    }

    const ageSec = (context.timestamp - position.entryTimestamp) / 1000;
    if (this.#config.signals.entryQualityMode === "ENFORCE" &&
        context.feature && position.underlyingEntryPrice !== undefined &&
        ageSec >= this.#config.risk.earlyScratchMinAgeSec &&
        ageSec <= this.#config.risk.earlyScratchMaxAgeSec) {
      const sign = position.direction === "BULLISH" ? 1 : -1;
      const favorableMoveReached = position.highWaterMark >=
        position.averageEntryPrice * (1 + this.#config.risk.earlyScratchMinimumFavorablePct);
      const underlyingMoveBps = sign *
        (context.feature.price / position.underlyingEntryPrice - 1) * 10_000;
      const underlyingReversed = underlyingMoveBps <= -this.#config.risk.earlyScratchUnderlyingReversalBps &&
        sign * context.feature.fast.normalizedSlope < 0;
      if (!favorableMoveReached && underlyingReversed) return finish("EARLY_SCRATCH");
    }
    if (context.timestamp - position.entryTimestamp >= this.#config.risk.maxHoldSec * 1000) return finish("MAX_HOLD");
    if (context.regime && isOppositeRegime(position.direction, context.regime.regime)) return finish("OPPOSITE_REGIME");

    if (context.feature) {
      const s = position.direction === "BULLISH" ? 1 : -1;
      const vwap = context.feature.vwap.sessionVwap;
      const valid = s * context.feature.medium.normalizedSlope > 0 &&
        (vwap === undefined || s * (context.feature.price - vwap) > 0);
      if (valid) delete position.invalidSince;
      else if (position.invalidSince === undefined) position.invalidSince = context.timestamp;
      else if (context.timestamp - position.invalidSince >= this.#config.risk.trendInvalidationGraceSec * 1000) {
        return finish("TREND_INVALIDATION");
      }
    }
    return {
      exit: false,
      ...(mark !== undefined ? { markPrice: mark, liquidationPrice: quote.bidPrice } : {}),
      updatedPosition: position,
    };
  }
}

function isOppositeRegime(direction: PositionState["direction"], regime: RegimeDecision["regime"]): boolean {
  const down = new Set(["STRONG_DOWN", "GRIND_DOWN", "GAP_AND_GO_DOWN", "REVERSAL_DOWN"]);
  const up = new Set(["STRONG_UP", "GRIND_UP", "GAP_AND_GO_UP", "REVERSAL_UP"]);
  return direction === "BULLISH" ? down.has(regime) : up.has(regime);
}
