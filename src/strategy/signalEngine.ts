import type { EngineConfig } from "../config.js";
import type { Direction, FeatureSnapshot, RegimeDecision, SignalVote, TradeSignal } from "../types.js";
import { inSessionWindow, parseClock, secondsSinceMidnight } from "../utils/time.js";
import { hashString, stableStringify } from "../utils/statistics.js";
import { boundedProjectionBps } from "./projection.js";
import {
  activeStaticEntryGuard, isBullishTrendContinuationFeature, lateEntryGuardActive,
  morningEntryGuardActive, projectedMoveContinuationGuard,
} from "./lateEntryGuard.js";

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

export interface SignalRevalidation {
  valid: boolean;
  signal?: TradeSignal;
  reasons: string[];
}

export interface RestoredSignalState {
  lastSignalTimestamp?: number;
  lastEntries?: Partial<Record<Direction, number>>;
  lastProtectedExits?: Partial<Record<Direction, number>>;
}

export function isProtectedProfitExit(reason: unknown, realizedPnl: number): boolean {
  return realizedPnl > 0 &&
    (reason === "PROFIT_FLOOR_EXIT" || reason === "OPPOSITE_REGIME");
}

interface PendingFollowThrough {
  direction: Direction;
  kind: TradeSignal["kind"];
  armedAt: number;
  entryReferencePrice: number;
  entryNoiseFloorBps: number;
  maxSec: number;
  reasonPrefix: "" | "MORNING_ENTRY_" | "LATE_ENTRY_";
  armedViaBullishTrendContinuation: boolean;
}

interface FollowThroughRequirement {
  minSec: number;
  maxSec: number;
  minimumBps: number;
  noiseMultiplier: number;
  reasonPrefix: "" | "MORNING_ENTRY_" | "LATE_ENTRY_";
}

export class SignalEngine {
  readonly #config: EngineConfig;
  #lastSignalTimestamp = -Infinity;
  readonly #lastEntries: Partial<Record<Direction, number>> = {};
  readonly #lastProtectedExits: Partial<Record<Direction, number>> = {};
  #pendingFollowThrough: PendingFollowThrough | undefined;

  constructor(config: EngineConfig) { this.#config = config; }

  /** Cooldown begins on an actual entry, never on a rejected candidate. */
  recordEntry(direction: Direction, timestamp: number): void {
    this.#lastEntries[direction] = Math.max(this.#lastEntries[direction] ?? -Infinity, timestamp);
  }

  /** Opens one guarded cooldown exception after a profitable protective exit. */
  recordCompletedExit(
    direction: Direction, timestamp: number, reason: unknown, realizedPnl: number,
  ): void {
    if (!isProtectedProfitExit(reason, realizedPnl)) return;
    this.#lastProtectedExits[direction] = Math.max(
      this.#lastProtectedExits[direction] ?? -Infinity,
      timestamp,
    );
  }

  restoreState(state: RestoredSignalState): void {
    if (state.lastSignalTimestamp !== undefined && Number.isFinite(state.lastSignalTimestamp)) {
      this.#lastSignalTimestamp = Math.max(this.#lastSignalTimestamp, state.lastSignalTimestamp);
    }
    for (const direction of ["BULLISH", "BEARISH"] as const) {
      const timestamp = state.lastEntries?.[direction];
      if (timestamp !== undefined && Number.isFinite(timestamp)) this.recordEntry(direction, timestamp);
      const protectedExitTimestamp = state.lastProtectedExits?.[direction];
      if (protectedExitTimestamp !== undefined && Number.isFinite(protectedExitTimestamp)) {
        this.#lastProtectedExits[direction] = Math.max(
          this.#lastProtectedExits[direction] ?? -Infinity,
          protectedExitTimestamp,
        );
      }
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
    if (globalReasons.length > 0) {
      this.#pendingFollowThrough = undefined;
      return { passed: false, reasons: globalReasons, directions: [] };
    }

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
      const pendingExpired = this.#pendingFollowThrough !== undefined &&
        feature.timestamp - this.#pendingFollowThrough.armedAt >= this.#pendingFollowThrough.maxSec * 1000;
      const expiredReason = `${this.#pendingFollowThrough?.reasonPrefix ?? ""}FOLLOW_THROUGH_EXPIRED`;
      if (pendingExpired) this.#pendingFollowThrough = undefined;
      return {
        passed: false,
        reasons: [pendingExpired ? expiredReason : "NO_DIRECTION_PASSED"],
        directions: directions.map(({ signal: _signal, ...direction }) => direction),
      };
    }
    candidates.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "IMPULSE" ? -1 : 1;
      return b.projectedMoveBps - a.projectedMoveBps;
    });
    const selected = candidates[0]!;
    const directionEvaluations = directions.map(({ signal: _signal, ...direction }) => direction);
    const followThrough = this.#followThroughRequirement(selected);
    if (followThrough && followThrough.minSec > 0) {
      const confirmation = this.#confirmFollowThrough(selected, feature, followThrough);
      if (!confirmation.confirmed) {
        return { passed: false, reasons: confirmation.reasons, directions: directionEvaluations };
      }
      selected.reasons.push(
        `causal follow-through confirmed after ${confirmation.elapsedSec.toFixed(1)}s at ` +
        `${confirmation.moveBps.toFixed(3)} bps versus ${confirmation.requiredMoveBps.toFixed(3)} bps required`,
      );
      if (confirmation.armedViaBullishTrendContinuation) {
        selected.reasons.push(
          "causal confirmation was armed by an aligned bullish continuation below the static projection minimum",
        );
      }
    } else {
      this.#pendingFollowThrough = undefined;
    }
    this.#lastSignalTimestamp = feature.timestamp;
    return {
      passed: true,
      signal: selected,
      reasons: selected.reasons,
      directions: directionEvaluations,
    };
  }

  /**
   * Rechecks a fired setup against the latest causal feature without advancing
   * signal cadence or follow-through state. Used only during the bounded option
   * quote retry window before an entry order exists.
   */
  revalidateForEntry(
    original: TradeSignal,
    feature: FeatureSnapshot,
    regime: RegimeDecision,
  ): SignalRevalidation {
    const reasons: string[] = [];
    if (feature.timestamp < original.timestamp) reasons.push("REVALIDATION_FEATURE_PRECEDES_SIGNAL");
    if (!feature.dataValid) {
      reasons.push(...(feature.invalidReasons.length > 0 ? feature.invalidReasons : ["FEATURE_DATA_INVALID"]));
    }
    if (!feature.openingRange.complete) reasons.push("OPENING_RANGE_INCOMPLETE");
    if (!inSessionWindow(
      feature.timestamp,
      this.#config.session.entryStart,
      this.#config.session.entryEnd,
      this.#config.timeZone,
    )) reasons.push("OUTSIDE_ENTRY_WINDOW");
    if (this.#config.signals.blockWhipsaw && regime.regime === "HIGH_VOL_WHIPSAW") {
      reasons.push("WHIPSAW_REGIME_BLOCKED");
    }
    if (reasons.length > 0) return { valid: false, reasons: [...new Set(reasons)] };

    const votes: SignalVote[] = [];
    const current = this.#evaluateDirection(original.direction, feature, regime, reasons, votes);
    if (!current) return { valid: false, reasons: [...new Set(reasons)] };
    if (current.kind !== original.kind) {
      return { valid: false, reasons: [`SIGNAL_KIND_CHANGED_${original.kind}_TO_${current.kind}`] };
    }
    return {
      valid: true,
      signal: {
        ...current,
        id: original.id,
        timestamp: original.timestamp,
        reasons: [...original.reasons, "setup structure revalidated during option quote retry"],
      },
      reasons: [],
    };
  }

  #confirmFollowThrough(
    selected: TradeSignal, feature: FeatureSnapshot, requirement: FollowThroughRequirement,
  ): {
    confirmed: true;
    elapsedSec: number;
    moveBps: number;
    requiredMoveBps: number;
    armedViaBullishTrendContinuation: boolean;
  } | { confirmed: false; reasons: string[] } {
    const pending = this.#pendingFollowThrough;
    const prefix = requirement.reasonPrefix;
    if (!pending || pending.direction !== selected.direction || pending.kind !== selected.kind ||
        pending.reasonPrefix !== prefix) {
      this.#pendingFollowThrough = {
        direction: selected.direction,
        kind: selected.kind,
        armedAt: feature.timestamp,
        entryReferencePrice: feature.price,
        entryNoiseFloorBps: feature.fast.noiseFloorBps,
        maxSec: requirement.maxSec,
        reasonPrefix: prefix,
        armedViaBullishTrendContinuation:
          projectedMoveContinuationGuard(this.#config, selected) !== undefined,
      };
      return {
        confirmed: false,
        reasons: [`${prefix}${pending ? "FOLLOW_THROUGH_DIRECTION_CHANGED" : "FOLLOW_THROUGH_PENDING"}`],
      };
    }
    const elapsedMs = feature.timestamp - pending.armedAt;
    const elapsedSec = elapsedMs / 1000;
    if (elapsedMs < requirement.minSec * 1000) {
      return { confirmed: false, reasons: [`${prefix}FOLLOW_THROUGH_PENDING`] };
    }
    const sign = selected.direction === "BULLISH" ? 1 : -1;
    const moveBps = sign * (feature.price / pending.entryReferencePrice - 1) * 10_000;
    const requiredMoveBps = Math.max(
      requirement.minimumBps,
      requirement.noiseMultiplier *
        Math.max(pending.entryNoiseFloorBps, feature.fast.noiseFloorBps),
    );
    if (elapsedMs <= requirement.maxSec * 1000 && moveBps >= requiredMoveBps) {
      this.#pendingFollowThrough = undefined;
      return {
        confirmed: true,
        elapsedSec,
        moveBps,
        requiredMoveBps,
        armedViaBullishTrendContinuation: pending.armedViaBullishTrendContinuation,
      };
    }
    if (elapsedMs < requirement.maxSec * 1000) {
      return { confirmed: false, reasons: [`${prefix}FOLLOW_THROUGH_NOT_CONFIRMED`] };
    }
    this.#pendingFollowThrough = {
      direction: selected.direction,
      kind: selected.kind,
      armedAt: feature.timestamp,
      entryReferencePrice: feature.price,
      entryNoiseFloorBps: feature.fast.noiseFloorBps,
      maxSec: requirement.maxSec,
      reasonPrefix: prefix,
      armedViaBullishTrendContinuation:
        projectedMoveContinuationGuard(this.#config, selected) !== undefined,
    };
    return { confirmed: false, reasons: [`${prefix}FOLLOW_THROUGH_FAILED`] };
  }

  #followThroughRequirement(signal: TradeSignal): FollowThroughRequirement | undefined {
    const continuationGuard = projectedMoveContinuationGuard(this.#config, signal);
    if (continuationGuard) {
      const profile = continuationGuard.reasonPrefix === "LATE_ENTRY_"
        ? this.#config.signals.lateEntryGuard
        : this.#config.signals;
      return {
        minSec: profile.followThroughMinSec,
        maxSec: profile.followThroughMaxSec,
        minimumBps: profile.followThroughMinimumBps,
        noiseMultiplier: this.#config.signals.followThroughNoiseMultiplier,
        reasonPrefix: continuationGuard.reasonPrefix,
      };
    }
    if (morningEntryGuardActive(this.#config, signal.timestamp) &&
        this.#config.signals.entryConfirmationMode === "ENFORCE" &&
        this.#config.signals.morningEntryGuard.ofiConflictRequiresFollowThrough &&
        signal.kind === "IMPULSE" &&
        hasDirectionalOfiConflict(signal)) {
      return {
        minSec: this.#config.signals.followThroughMinSec,
        maxSec: this.#config.signals.followThroughMaxSec,
        minimumBps: this.#config.signals.followThroughMinimumBps,
        noiseMultiplier: this.#config.signals.followThroughNoiseMultiplier,
        reasonPrefix: "MORNING_ENTRY_",
      };
    }
    if (lateEntryGuardActive(this.#config, signal.timestamp)) {
      const guard = this.#config.signals.lateEntryGuard;
      if (isLateBullishLowNoiseGrind(this.#config, signal)) {
        signal.reasons.push("late low-noise bullish grind profile passed");
        return undefined;
      }
      if (signal.direction === "BEARISH" && signal.kind === "GRIND" &&
          !guard.bearishGrindRequiresFollowThrough) {
        return undefined;
      }
      if (signal.direction === "BEARISH" && signal.kind === "IMPULSE" &&
          signal.regime === "UNCLASSIFIED" &&
          secondsSinceMidnight(signal.timestamp, this.#config.timeZone) <
            parseClock(guard.bearishUnclassifiedImpulseFollowThroughStart)) {
        return undefined;
      }
      const profile = signal.direction === "BEARISH" &&
        signal.kind === "IMPULSE" &&
        signal.regime === "STRONG_DOWN"
        ? guard.bearishStrongDownImpulse
        : guard;
      return {
        minSec: profile.followThroughMinSec,
        maxSec: profile.followThroughMaxSec,
        minimumBps: profile.followThroughMinimumBps,
        noiseMultiplier: this.#config.signals.followThroughNoiseMultiplier,
        reasonPrefix: "LATE_ENTRY_",
      };
    }
    if (this.#config.signals.entryConfirmationMode !== "ENFORCE" || !this.#requiresStandardFollowThrough(signal)) {
      return undefined;
    }
    return {
      minSec: this.#config.signals.followThroughMinSec,
      maxSec: this.#config.signals.followThroughMaxSec,
      minimumBps: this.#config.signals.followThroughMinimumBps,
      noiseMultiplier: this.#config.signals.followThroughNoiseMultiplier,
      reasonPrefix: "",
    };
  }

  #requiresStandardFollowThrough(signal: TradeSignal): boolean {
    const scope = this.#config.signals.followThroughScope;
    if (scope === "ALL") return true;
    if (scope === "IMPULSE") return signal.kind === "IMPULSE";
    return signal.direction === "BULLISH" && signal.kind === "IMPULSE";
  }

  #evaluateDirection(
    direction: Direction,
    f: FeatureSnapshot,
    regime: RegimeDecision,
    blockedReasons: string[],
    evaluationVotes: SignalVote[],
  ): TradeSignal | undefined {
    const lastEntry = this.#lastEntries[direction];
    const sameDirectionCooldownSec =
      isLateBullishLowNoiseGrindFeature(this.#config, direction, f)
        ? this.#config.signals.lateEntryGuard.bullishLowNoiseGrind.reentryCooldownSec
        : this.#config.signals.sameDirectionCooldownSec;
    const protectedExitReentry = this.#protectedExitReentryAllowed(
      direction, f.timestamp, regime, lastEntry,
    );
    if (lastEntry !== undefined && f.timestamp - lastEntry < sameDirectionCooldownSec * 1000 &&
        !protectedExitReentry) {
      blockedReasons.push("SAME_DIRECTION_COOLDOWN");
      return undefined;
    }
    const reentryReasons = protectedExitReentry ? [
      "guarded same-direction re-entry allowed after a profitable protective exit",
    ] : [];
    const oppositeDirection: Direction = direction === "BULLISH" ? "BEARISH" : "BULLISH";
    const oppositeEntry = this.#lastEntries[oppositeDirection];
    if (oppositeEntry !== undefined &&
        f.timestamp - oppositeEntry < this.#config.signals.oppositeDirectionCooldownSec * 1000) {
      blockedReasons.push("OPPOSITE_DIRECTION_COOLDOWN");
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
    const staticEntryGuard = activeStaticEntryGuard(this.#config, f.timestamp);
    const bullishTrendContinuation = isBullishTrendContinuationFeature(
      this.#config,
      direction,
      f,
      regime.regime,
      directionalProjection,
    );
    const projectedMoveException = staticEntryGuard !== undefined &&
      directionalProjection < staticEntryGuard.minProjectedMoveBps &&
      bullishTrendContinuation;
    if (staticEntryGuard && directionalProjection < staticEntryGuard.minProjectedMoveBps &&
        !projectedMoveException) {
      blockedReasons.push(`${staticEntryGuard.reasonPrefix}PROJECTED_MOVE_BELOW_MINIMUM`);
      return undefined;
    }
    const continuationReasons = projectedMoveException ? [
      `aligned bullish continuation accepted ${directionalProjection.toFixed(3)} bps projection below ` +
        `${staticEntryGuard!.minProjectedMoveBps.toFixed(3)} bps static minimum; causal confirmation required`,
    ] : [];

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
    const weakLateBearishImpulsePersistence =
      impulsePassed &&
      lateEntryGuardActive(this.#config, f.timestamp) &&
      direction === "BEARISH" &&
      regime.regime === "UNCLASSIFIED" &&
      s * f.medium.normalizedSlope <
        this.#config.signals.lateEntryGuard.bearishUnclassifiedImpulseMinMediumToFastRatio *
          Math.max(0, s * f.fast.normalizedSlope);
    if (weakLateBearishImpulsePersistence) {
      blockedReasons.push("LATE_ENTRY_BEARISH_IMPULSE_MEDIUM_PERSISTENCE");
      return undefined;
    }
    if (impulsePassed && lateBullishImpulseNeedsConfirmation) {
      blockedReasons.push("LATE_BULLISH_IMPULSE_REQUIRES_UP_REGIME");
      return undefined;
    }
    const bullishImpulseCutoffPassed = this.#config.signals.entryConfirmationMode === "ENFORCE" &&
      direction === "BULLISH" &&
      secondsSinceMidnight(f.timestamp, this.#config.timeZone) > parseClock(this.#config.signals.bullishImpulseCutoff);
    if (impulsePassed && bullishImpulseCutoffPassed) {
      blockedReasons.push("BULLISH_IMPULSE_CUTOFF_PASSED");
      return undefined;
    }
    if (impulsePassed) {
      return this.#makeSignal(direction, "IMPULSE", directionalProjection, votes, f, regime, [
        "structural gate passed", "opening-range break/proximity/retest", `${voteCount}/4 impulse votes passed`,
        ...reentryReasons,
      ]);
    }

    const grind =
      s * f.medium.normalizedSlope >= this.#config.signals.grindMediumSlopeScore &&
      s * f.slow.normalizedSlope >= this.#config.signals.grindSlowSlopeScore &&
      s * (f.vwap.rollingVwapSlopeBpsPerSec ?? 0) > 0 &&
      s * f.fast.normalizedAcceleration >= this.#config.signals.grindNegativeAccelerationLimit &&
      (s * f.ofi15 >= 0 || projectedMoveException);
    if (grind) {
      if (lateEntryGuardActive(this.#config, f.timestamp) &&
          direction === "BULLISH" &&
          f.medium.normalizedSlope <
            this.#config.signals.lateEntryGuard.bullishGrindMinMediumNormalizedSlope) {
        blockedReasons.push("LATE_ENTRY_BULLISH_GRIND_MEDIUM_PERSISTENCE");
        return undefined;
      }
      if (morningEntryGuardActive(this.#config, f.timestamp)) {
        const guard = this.#config.signals.morningEntryGuard;
        if (direction === "BULLISH" && guard.bullishGrindRequiresUpRegime &&
            regime.regime !== "STRONG_UP" && regime.regime !== "GRIND_UP") {
          blockedReasons.push("MORNING_ENTRY_BULLISH_GRIND_REQUIRES_UP_REGIME");
          return undefined;
        }
      }
      return this.#makeSignal(direction, "GRIND", directionalProjection, votes, f, regime, [
        "structural gate passed", "persistent medium/slow slope", "rolling VWAP and OFI aligned", "acceleration within adverse limit",
        ...continuationReasons, ...reentryReasons,
      ]);
    }
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

  #protectedExitReentryAllowed(
    direction: Direction,
    timestamp: number,
    regime: RegimeDecision,
    lastEntry: number | undefined,
  ): boolean {
    const profile = this.#config.signals.protectedExitReentry;
    const exitTimestamp = this.#lastProtectedExits[direction];
    if (!profile.enabled || lastEntry === undefined || exitTimestamp === undefined ||
        exitTimestamp < lastEntry) return false;
    const elapsedMs = timestamp - exitTimestamp;
    if (elapsedMs < profile.cooldownSec * 1000 || elapsedMs > profile.windowSec * 1000) return false;
    if (!profile.requiresStrongRegime) return true;
    return direction === "BULLISH"
      ? regime.regime === "STRONG_UP"
      : regime.regime === "STRONG_DOWN";
  }

  #makeSignal(
    direction: Direction, kind: "IMPULSE" | "GRIND", projectedMoveBps: number,
    votes: SignalVote[], feature: FeatureSnapshot, regime: RegimeDecision, reasons: string[],
  ): TradeSignal {
    const prefix = feature.symbol === "SPY" ? "sig" : `sig-${feature.symbol.toLowerCase()}`;
    const id = `${prefix}-${feature.timestamp}-${hashString(stableStringify({ direction, kind, price: feature.price }))}`;
    return { id, timestamp: feature.timestamp, direction, kind, regime: regime.regime, projectedMoveBps, votes, reasons, featureSnapshot: feature };
  }
}

function hasDirectionalOfiConflict(signal: TradeSignal): boolean {
  const direction = signal.direction === "BULLISH" ? 1 : -1;
  return direction * signal.featureSnapshot.ofi5 > 0 &&
    direction * signal.featureSnapshot.ofi15 < 0;
}

function isLateBullishLowNoiseGrind(
  config: EngineConfig,
  signal: TradeSignal,
): boolean {
  return signal.kind === "GRIND" &&
    isLateBullishLowNoiseGrindFeature(config, signal.direction, signal.featureSnapshot);
}

function isLateBullishLowNoiseGrindFeature(
  config: EngineConfig,
  direction: Direction,
  feature: FeatureSnapshot,
): boolean {
  if (direction !== "BULLISH" || !lateEntryGuardActive(config, feature.timestamp)) {
    return false;
  }
  const profile = config.signals.lateEntryGuard.bullishLowNoiseGrind;
  return profile.enabled &&
    !isBullishImpulseSetup(config, feature) &&
    feature.fast.noiseFloorBps <= profile.maxFastNoiseFloorBps &&
    feature.fast.normalizedSlope >= profile.minFastNormalizedSlope &&
    feature.medium.normalizedSlope >= profile.minMediumNormalizedSlope &&
    (feature.medium.regression.r2 ?? -Infinity) >= profile.minMediumR2 &&
    feature.slow.normalizedSlope >= profile.minSlowNormalizedSlope &&
    (feature.slow.regression.r2 ?? -Infinity) >= profile.minSlowR2 &&
    (feature.vwap.rollingVwapSlopeBpsPerSec ?? -Infinity) > 0 &&
    feature.fast.normalizedAcceleration >= config.signals.grindNegativeAccelerationLimit &&
    feature.ofi15 >= 0;
}

function isBullishImpulseSetup(config: EngineConfig, feature: FeatureSnapshot): boolean {
  const openingRange = feature.openingRange;
  const breakoutMemoryMs = config.signals.breakoutMemorySec * 1000;
  const locationGate =
    openingRange.nearHigh ||
    feature.price >= openingRange.high! ||
    openingRange.bullishRetest ||
    (openingRange.bullishBreakoutTimestamp !== undefined &&
      feature.timestamp - openingRange.bullishBreakoutTimestamp <= breakoutMemoryMs);
  const voteCount = [
    feature.fast.normalizedSlope >= feature.thresholds.fastSlope,
    feature.fast.normalizedAcceleration >= feature.thresholds.fastAcceleration,
    feature.ofi5 >= feature.thresholds.absoluteOfi5,
    feature.micropriceDisplacementBps > 0,
  ].filter(Boolean).length;
  return locationGate && voteCount >= config.signals.impulseVotesRequired;
}
