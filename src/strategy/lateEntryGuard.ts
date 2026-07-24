import type { EngineConfig } from "../config.js";
import { parseClock, secondsSinceMidnight } from "../utils/time.js";

export type StaticEntryGuardReasonPrefix = "MORNING_ENTRY_" | "LATE_ENTRY_";

export interface ActiveStaticEntryGuard {
  reasonPrefix: StaticEntryGuardReasonPrefix;
  minProjectedMoveBps: number;
  minCostMarginBps: number;
  maxOptionSpreadPct: number;
}

export function morningEntryGuardActive(
  config: EngineConfig,
  timestamp: number,
): boolean {
  const seconds = secondsSinceMidnight(timestamp, config.timeZone);
  return config.signals.morningEntryGuard.mode === "ENFORCE" &&
    seconds >= parseClock(config.signals.morningEntryGuard.start) &&
    seconds < parseClock(config.signals.morningEntryGuard.end);
}

export function lateEntryGuardActive(
  config: EngineConfig,
  timestamp: number,
): boolean {
  return config.signals.lateEntryGuard.mode === "ENFORCE" &&
    secondsSinceMidnight(timestamp, config.timeZone) >= parseClock(config.signals.lateEntryGuard.start);
}

export function activeStaticEntryGuard(
  config: EngineConfig,
  timestamp: number,
): ActiveStaticEntryGuard | undefined {
  if (morningEntryGuardActive(config, timestamp)) {
    return {
      reasonPrefix: "MORNING_ENTRY_",
      minProjectedMoveBps: config.signals.morningEntryGuard.minProjectedMoveBps,
      minCostMarginBps: config.signals.morningEntryGuard.minCostMarginBps,
      maxOptionSpreadPct: config.signals.morningEntryGuard.maxOptionSpreadPct,
    };
  }
  if (lateEntryGuardActive(config, timestamp)) {
    return {
      reasonPrefix: "LATE_ENTRY_",
      minProjectedMoveBps: config.signals.lateEntryGuard.minProjectedMoveBps,
      minCostMarginBps: config.signals.lateEntryGuard.minCostMarginBps,
      maxOptionSpreadPct: config.signals.lateEntryGuard.maxOptionSpreadPct,
    };
  }
  return undefined;
}

export function morningEntryGuardAudit(
  config: EngineConfig,
  timestamp: number,
): Record<string, unknown> {
  return {
    mode: config.signals.morningEntryGuard.mode,
    active: morningEntryGuardActive(config, timestamp),
    start: config.signals.morningEntryGuard.start,
    end: config.signals.morningEntryGuard.end,
    minProjectedMoveBps: config.signals.morningEntryGuard.minProjectedMoveBps,
    minCostMarginBps: config.signals.morningEntryGuard.minCostMarginBps,
    maxOptionSpreadPct: config.signals.morningEntryGuard.maxOptionSpreadPct,
    followThrough: "DISABLED",
  };
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
