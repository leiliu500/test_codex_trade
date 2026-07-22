import type { EngineConfig } from "../config.js";
import type { Direction, FeatureSnapshot, RegimeDecision, SignalVote, TradeSignal } from "../types.js";
import { inSessionWindow } from "../utils/time.js";
import { hashString, stableStringify } from "../utils/statistics.js";
import { boundedProjectionBps } from "./projection.js";

export class SignalEngine {
  readonly #config: EngineConfig;
  #lastSignalTimestamp = -Infinity;
  readonly #lastEntries: Partial<Record<Direction, number>> = {};

  constructor(config: EngineConfig) { this.#config = config; }

  /** Cooldown begins on an actual entry, never on a rejected candidate. */
  recordEntry(direction: Direction, timestamp: number): void {
    this.#lastEntries[direction] = timestamp;
  }

  evaluate(feature: FeatureSnapshot, regime: RegimeDecision): TradeSignal | undefined {
    if (!feature.dataValid || !feature.openingRange.complete) return undefined;
    if (!inSessionWindow(feature.timestamp, this.#config.session.entryStart, this.#config.session.entryEnd, this.#config.timeZone)) return undefined;
    if (this.#config.signals.blockWhipsaw && regime.regime === "HIGH_VOL_WHIPSAW") return undefined;
    if (feature.timestamp - this.#lastSignalTimestamp < this.#config.signals.minimumSignalIntervalSec * 1000) return undefined;

    const candidates = (["BULLISH", "BEARISH"] as const)
      .map((direction) => this.#evaluateDirection(direction, feature, regime))
      .filter((signal): signal is TradeSignal => signal !== undefined);
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "IMPULSE" ? -1 : 1;
      return b.projectedMoveBps - a.projectedMoveBps;
    });
    this.#lastSignalTimestamp = feature.timestamp;
    return candidates[0];
  }

  #evaluateDirection(direction: Direction, f: FeatureSnapshot, regime: RegimeDecision): TradeSignal | undefined {
    const lastEntry = this.#lastEntries[direction];
    if (lastEntry !== undefined && f.timestamp - lastEntry < this.#config.signals.sameDirectionCooldownSec * 1000) return undefined;
    const s = direction === "BULLISH" ? 1 : -1;
    const sessionVwap = f.vwap.sessionVwap;
    if (sessionVwap === undefined) return undefined;
    const structuralGate =
      s * (f.price - sessionVwap) > 0 &&
      s * f.medium.normalizedSlope > 0 &&
      s * f.slow.normalizedSlope > 0 &&
      (f.efficiency60 >= f.thresholds.efficiency60 ||
       (f.medium.regression.r2 ?? -Infinity) >= this.#config.signals.minR2Medium);
    if (!structuralGate) return undefined;

    const projection = boundedProjectionBps(
      f.fast.regression.slopeBpsPerSec ?? 0,
      f.fast.regression.accelerationBpsPerSec2 ?? 0,
      this.#config.signals.projectionHorizonSec,
      f.fast.realizedVolatilityBps,
      this.#config.signals.projectionAccelerationRvCap,
    );
    const directionalProjection = s * projection.projectedMoveBps;
    if (!(directionalProjection > 0)) return undefined;

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
    const or = f.openingRange;
    const memory = this.#config.signals.breakoutMemorySec * 1000;
    const locationGate = direction === "BULLISH"
      ? or.nearHigh || f.price >= or.high! || or.bullishRetest ||
        (or.bullishBreakoutTimestamp !== undefined && f.timestamp - or.bullishBreakoutTimestamp <= memory)
      : or.nearLow || f.price <= or.low! || or.bearishRetest ||
        (or.bearishBreakoutTimestamp !== undefined && f.timestamp - or.bearishBreakoutTimestamp <= memory);
    const voteCount = votes.filter((vote) => vote.passed).length;
    if (locationGate && voteCount >= this.#config.signals.impulseVotesRequired) {
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
    return grind ? this.#makeSignal(direction, "GRIND", directionalProjection, votes, f, regime, [
      "structural gate passed", "persistent medium/slow slope", "rolling VWAP and OFI aligned", "acceleration within adverse limit",
    ]) : undefined;
  }

  #makeSignal(
    direction: Direction, kind: "IMPULSE" | "GRIND", projectedMoveBps: number,
    votes: SignalVote[], feature: FeatureSnapshot, regime: RegimeDecision, reasons: string[],
  ): TradeSignal {
    const id = `sig-${feature.timestamp}-${hashString(stableStringify({ direction, kind, price: feature.price }))}`;
    return { id, timestamp: feature.timestamp, direction, kind, regime: regime.regime, projectedMoveBps, votes, reasons, featureSnapshot: feature };
  }
}
