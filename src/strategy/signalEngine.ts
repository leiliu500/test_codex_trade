import type { EngineConfig } from "../config.js";
import type { Direction, FeatureSnapshot, RegimeDecision, SignalVote, TradeSignal } from "../types.js";
import { inSessionWindow, parseClock, secondsSinceMidnight } from "../utils/time.js";
import { hashString, stableStringify } from "../utils/statistics.js";
import { boundedProjectionBps } from "./projection.js";

export interface SignalDirectionEvaluation {
  direction: Direction;
  passed: boolean;
  reasons: string[];
  votes: SignalVote[];
  projectedMoveBps?: number;
}

export interface SignalEvaluation {
  passed: boolean;
  signal?: TradeSignal;
  reasons: string[];
  directions: SignalDirectionEvaluation[];
}

export interface RestoredSignalState {
  lastSignalTimestamp?: number;
  lastEntries?: Partial<Record<Direction, number>>;
}

export class SignalEngine {
  readonly #config: EngineConfig;
  #lastSignalTimestamp = -Infinity;
  readonly #lastEntries: Partial<Record<Direction, number>> = {};

  constructor(config: EngineConfig) { this.#config = config; }

  /** Cooldown begins on an actual entry, never on a rejected candidate. */
  recordEntry(direction: Direction, timestamp: number): void {
    this.#lastEntries[direction] = Math.max(this.#lastEntries[direction] ?? -Infinity, timestamp);
  }

  restoreState(state: RestoredSignalState): void {
    if (state.lastSignalTimestamp !== undefined && Number.isFinite(state.lastSignalTimestamp)) {
      this.#lastSignalTimestamp = Math.max(this.#lastSignalTimestamp, state.lastSignalTimestamp);
    }
    for (const direction of ["BULLISH", "BEARISH"] as const) {
      const timestamp = state.lastEntries?.[direction];
      if (timestamp !== undefined && Number.isFinite(timestamp)) this.recordEntry(direction, timestamp);
    }
  }

  evaluate(feature: FeatureSnapshot, regime: RegimeDecision): TradeSignal | undefined {
    return this.evaluateDetailed(feature, regime).signal;
  }

  evaluateDetailed(feature: FeatureSnapshot, regime: RegimeDecision): SignalEvaluation {
    const globalReasons: string[] = [];
    if (!feature.dataValid) globalReasons.push(...(feature.invalidReasons.length > 0 ? feature.invalidReasons : ["FEATURE_DATA_INVALID"]));
    if (!feature.openingRange.complete) globalReasons.push("OPENING_RANGE_INCOMPLETE");
    if (!inSessionWindow(feature.timestamp, this.#config.session.entryStart, this.#config.session.entryEnd, this.#config.timeZone)) {
      globalReasons.push("OUTSIDE_ENTRY_WINDOW");
    }
    if (this.#config.signals.blockWhipsaw && regime.regime === "HIGH_VOL_WHIPSAW") globalReasons.push("WHIPSAW_REGIME_BLOCKED");
    if (feature.timestamp - this.#lastSignalTimestamp < this.#config.signals.minimumSignalIntervalSec * 1000) {
      globalReasons.push("MINIMUM_SIGNAL_INTERVAL");
    }
    if (globalReasons.length > 0) return { passed: false, reasons: globalReasons, directions: [] };

    const directions = (["BULLISH", "BEARISH"] as const).map((direction) => {
      const reasons: string[] = [];
      const votes: SignalVote[] = [];
      const signal = this.#evaluateDirection(direction, feature, regime, reasons, votes);
      return {
        direction,
        passed: signal !== undefined,
        reasons: signal?.reasons ?? reasons,
        votes,
        ...(signal ? { projectedMoveBps: signal.projectedMoveBps, signal } : {}),
      };
    });
    const candidates = directions.flatMap((direction) => direction.signal ? [direction.signal] : []);
    if (candidates.length === 0) {
      return {
        passed: false,
        reasons: ["NO_DIRECTION_PASSED"],
        directions: directions.map(({ signal: _signal, ...direction }) => direction),
      };
    }
    candidates.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "IMPULSE" ? -1 : 1;
      return b.projectedMoveBps - a.projectedMoveBps;
    });
    const selected = candidates[0]!;
    this.#lastSignalTimestamp = feature.timestamp;
    return {
      passed: true,
      signal: selected,
      reasons: selected.reasons,
      directions: directions.map(({ signal: _signal, ...direction }) => direction),
    };
  }

  #evaluateDirection(
    direction: Direction,
    f: FeatureSnapshot,
    regime: RegimeDecision,
    blockedReasons: string[],
    evaluationVotes: SignalVote[],
  ): TradeSignal | undefined {
    const lastEntry = this.#lastEntries[direction];
    if (lastEntry !== undefined && f.timestamp - lastEntry < this.#config.signals.sameDirectionCooldownSec * 1000) {
      blockedReasons.push("SAME_DIRECTION_COOLDOWN");
      return undefined;
    }
    const s = direction === "BULLISH" ? 1 : -1;
    const sessionVwap = f.vwap.sessionVwap;
    if (sessionVwap === undefined) {
      blockedReasons.push("SESSION_VWAP_UNAVAILABLE");
      return undefined;
    }
    if (!(s * (f.price - sessionVwap) > 0)) blockedReasons.push("PRICE_WRONG_SIDE_OF_SESSION_VWAP");
    if (!(s * f.medium.normalizedSlope > 0)) blockedReasons.push("MEDIUM_SLOPE_MISALIGNED");
    if (!(s * f.slow.normalizedSlope > 0)) blockedReasons.push("SLOW_SLOPE_MISALIGNED");
    if (!(f.efficiency60 >= f.thresholds.efficiency60 ||
          (f.medium.regression.r2 ?? -Infinity) >= this.#config.signals.minR2Medium)) {
      blockedReasons.push("TREND_QUALITY_BELOW_THRESHOLD");
    }
    if (blockedReasons.length > 0) return undefined;

    const projection = boundedProjectionBps(
      f.fast.regression.slopeBpsPerSec ?? 0,
      f.fast.regression.accelerationBpsPerSec2 ?? 0,
      this.#config.signals.projectionHorizonSec,
      f.fast.realizedVolatilityBps,
      this.#config.signals.projectionAccelerationRvCap,
    );
    const directionalProjection = s * projection.projectedMoveBps;
    if (!(directionalProjection > 0)) {
      blockedReasons.push("PROJECTED_MOVE_NOT_DIRECTIONAL");
      return undefined;
    }

    const votes: SignalVote[] = [
      { name: "FAST_SLOPE", passed: s * f.fast.normalizedSlope >= f.thresholds.fastSlope,
        value: s * f.fast.normalizedSlope, threshold: f.thresholds.fastSlope },
      { name: "FAST_ACCELERATION", passed: s * f.fast.normalizedAcceleration >= f.thresholds.fastAcceleration,
        value: s * f.fast.normalizedAcceleration, threshold: f.thresholds.fastAcceleration },
      { name: "OFI_5", passed: s * f.ofi5 >= f.thresholds.absoluteOfi5,
        value: s * f.ofi5, threshold: f.thresholds.absoluteOfi5 },
      { name: "MICROPRICE_DISPLACEMENT", passed: s * f.micropriceDisplacementBps > 0,
        value: s * f.micropriceDisplacementBps, threshold: 0 },
    ];
    evaluationVotes.push(...votes);
    const or = f.openingRange;
    const memory = this.#config.signals.breakoutMemorySec * 1000;
    const locationGate = direction === "BULLISH"
      ? or.nearHigh || f.price >= or.high! || or.bullishRetest ||
        (or.bullishBreakoutTimestamp !== undefined && f.timestamp - or.bullishBreakoutTimestamp <= memory)
      : or.nearLow || f.price <= or.low! || or.bearishRetest ||
        (or.bearishBreakoutTimestamp !== undefined && f.timestamp - or.bearishBreakoutTimestamp <= memory);
    const voteCount = votes.filter((vote) => vote.passed).length;
    const impulsePassed = locationGate && voteCount >= this.#config.signals.impulseVotesRequired;
    const lateBullishImpulseNeedsConfirmation =
      this.#config.signals.lateBullishImpulseRequiresUpRegime &&
      direction === "BULLISH" &&
      secondsSinceMidnight(f.timestamp, this.#config.timeZone) >= parseClock(this.#config.signals.lateBullishImpulseStart) &&
      regime.regime !== "STRONG_UP" && regime.regime !== "GRIND_UP";
    if (impulsePassed && lateBullishImpulseNeedsConfirmation) {
      blockedReasons.push("LATE_BULLISH_IMPULSE_REQUIRES_UP_REGIME");
      return undefined;
    }
    if (impulsePassed) {
      return this.#makeSignal(direction, "IMPULSE", directionalProjection, votes, f, regime, [
        "structural gate passed", "opening-range break/proximity/retest", `${voteCount}/4 impulse votes passed`,
      ]);
    }

    const grind =
      s * f.medium.normalizedSlope >= this.#config.signals.grindMediumSlopeScore &&
      s * f.slow.normalizedSlope >= this.#config.signals.grindSlowSlopeScore &&
      s * (f.vwap.rollingVwapSlopeBpsPerSec ?? 0) > 0 &&
      s * f.fast.normalizedAcceleration >= this.#config.signals.grindNegativeAccelerationLimit &&
      s * f.ofi15 >= 0;
    if (grind) return this.#makeSignal(direction, "GRIND", directionalProjection, votes, f, regime, [
      "structural gate passed", "persistent medium/slow slope", "rolling VWAP and OFI aligned", "acceleration within adverse limit",
    ]);
    if (!locationGate) blockedReasons.push("OPENING_RANGE_LOCATION_NOT_CONFIRMED");
    if (voteCount < this.#config.signals.impulseVotesRequired) {
      blockedReasons.push(`IMPULSE_VOTES_${voteCount}_OF_${this.#config.signals.impulseVotesRequired}`);
    }
    if (!(s * f.medium.normalizedSlope >= this.#config.signals.grindMediumSlopeScore)) blockedReasons.push("GRIND_MEDIUM_SLOPE");
    if (!(s * f.slow.normalizedSlope >= this.#config.signals.grindSlowSlopeScore)) blockedReasons.push("GRIND_SLOW_SLOPE");
    if (!(s * (f.vwap.rollingVwapSlopeBpsPerSec ?? 0) > 0)) blockedReasons.push("GRIND_VWAP_SLOPE");
    if (!(s * f.fast.normalizedAcceleration >= this.#config.signals.grindNegativeAccelerationLimit)) {
      blockedReasons.push("GRIND_ACCELERATION");
    }
    if (!(s * f.ofi15 >= 0)) blockedReasons.push("GRIND_OFI_15");
    return undefined;
  }

  #makeSignal(
    direction: Direction, kind: "IMPULSE" | "GRIND", projectedMoveBps: number,
    votes: SignalVote[], feature: FeatureSnapshot, regime: RegimeDecision, reasons: string[],
  ): TradeSignal {
    const id = `sig-${feature.timestamp}-${hashString(stableStringify({ direction, kind, price: feature.price }))}`;
    return { id, timestamp: feature.timestamp, direction, kind, regime: regime.regime, projectedMoveBps, votes, reasons, featureSnapshot: feature };
  }
}
