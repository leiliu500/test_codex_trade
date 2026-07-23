import type { EngineConfig } from "../config.js";
import { parseClock, secondsSinceMidnight } from "../utils/time.js";

export function lateEntryGuardActive(
  config: EngineConfig,
  timestamp: number,
): boolean {
  return config.signals.lateEntryGuard.mode === "ENFORCE" &&
    secondsSinceMidnight(timestamp, config.timeZone) >= parseClock(config.signals.lateEntryGuard.start);
}

export function lateEntryGuardAudit(
  config: EngineConfig,
  timestamp: number,
): Record<string, unknown> {
  return {
    mode: config.signals.lateEntryGuard.mode,
    active: lateEntryGuardActive(config, timestamp),
    start: config.signals.lateEntryGuard.start,
    minProjectedMoveBps: config.signals.lateEntryGuard.minProjectedMoveBps,
    minCostMarginBps: config.signals.lateEntryGuard.minCostMarginBps,
    maxOptionSpreadPct: config.signals.lateEntryGuard.maxOptionSpreadPct,
    followThroughMinSec: config.signals.lateEntryGuard.followThroughMinSec,
    followThroughMaxSec: config.signals.lateEntryGuard.followThroughMaxSec,
    followThroughMinimumBps: config.signals.lateEntryGuard.followThroughMinimumBps,
  };
}
