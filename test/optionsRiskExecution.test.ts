import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, qqqConfig, validateConfig } from "../src/config.js";
import { blackScholes, impliedVolatility, noArbitrageBounds } from "../src/options/blackScholes.js";
import { evaluateOptionCost, gammaAwareProjectedOptionMove } from "../src/options/costGate.js";
import { formatOccSymbol, parseOccSymbol } from "../src/options/occSymbol.js";
import { RiskManager } from "../src/risk/riskManager.js";
import { ExitManager } from "../src/risk/exitManager.js";
import { estimateOptionContinuation } from "../src/risk/optionContinuation.js";
import type { AlpacaOptionFeatures } from "../src/alpaca/optionFeatures.js";
import { TradeStateEstimator } from "../src/risk/tradeStateEstimator.js";
import { OrderExecutor, aggressionAtReplacement, limitInsideSpread, reconcileEntryExposure } from "../src/execution/orderExecutor.js";
import { zonedDateTimeToEpoch } from "../src/utils/time.js";
import type { FeatureSnapshot, PositionState, RegimeDecision } from "../src/types.js";

test("configuration cannot enable later-dated or overnight option trading", () => {
  assert.doesNotThrow(() => validateConfig(defaultConfig));
  const laterDated = structuredClone(defaultConfig);
  laterDated.options.expirationDaysMax = 1;
  assert.throws(() => validateConfig(laterDated), /0DTE/);
  const afterClose = structuredClone(defaultConfig);
  afterClose.session.forceExit = "16:00:00";
  assert.throws(() => validateConfig(afterClose), /forceExit < 16:00/);
  const invalidLiquidityFallback = structuredClone(defaultConfig);
  invalidLiquidityFallback.options.minDailyVolumeForOpenInterestFallback =
    invalidLiquidityFallback.options.minDailyVolume - 1;
  assert.throws(() => validateConfig(invalidLiquidityFallback), /Option liquidity thresholds/);
  const invalidOptionSelectionRetry = structuredClone(defaultConfig);
  invalidOptionSelectionRetry.execution.optionSelectionRetryMs =
    invalidOptionSelectionRetry.execution.entrySignalTtlMs + 1;
  assert.throws(() => validateConfig(invalidOptionSelectionRetry), /Order-management TTL/);
  const invalidConfirmation = structuredClone(defaultConfig);
  invalidConfirmation.signals.followThroughMinSec = 16;
  invalidConfirmation.signals.followThroughMaxSec = 15;
  assert.throws(() => validateConfig(invalidConfirmation), /Follow-through confirmation/);
  const invalidNoiseMultiplier = structuredClone(defaultConfig);
  invalidNoiseMultiplier.signals.followThroughNoiseMultiplier = -0.01;
  assert.throws(() => validateConfig(invalidNoiseMultiplier), /Follow-through confirmation/);
  const invalidBullishContinuation = structuredClone(defaultConfig);
  invalidBullishContinuation.signals.bullishTrendContinuation.minSlowR2 = 1.01;
  assert.throws(() => validateConfig(invalidBullishContinuation), /Bullish trend-continuation/);
  const invalidOppositeCooldown = structuredClone(defaultConfig);
  invalidOppositeCooldown.signals.oppositeDirectionCooldownSec = -1;
  assert.throws(() => validateConfig(invalidOppositeCooldown), /Signal cooldowns/);
  const invalidProtectedExitReentryWindow = structuredClone(defaultConfig);
  invalidProtectedExitReentryWindow.signals.protectedExitReentry.windowSec =
    invalidProtectedExitReentryWindow.signals.sameDirectionCooldownSec + 1;
  assert.throws(() => validateConfig(invalidProtectedExitReentryWindow), /Signal cooldowns/);
  const invalidScope = structuredClone(defaultConfig);
  invalidScope.signals.followThroughScope = "INVALID" as typeof invalidScope.signals.followThroughScope;
  assert.throws(() => validateConfig(invalidScope), /Follow-through scope/);
  const invalidMode = structuredClone(defaultConfig);
  invalidMode.signals.entryConfirmationMode =
    "INVALID" as typeof invalidMode.signals.entryConfirmationMode;
  assert.throws(() => validateConfig(invalidMode), /Entry-confirmation mode/);
  const invalidLateMode = structuredClone(defaultConfig);
  invalidLateMode.signals.lateEntryGuard.mode =
    "INVALID" as typeof invalidLateMode.signals.lateEntryGuard.mode;
  assert.throws(() => validateConfig(invalidLateMode), /Late-entry guard mode/);
  const invalidLateStart = structuredClone(defaultConfig);
  invalidLateStart.signals.lateEntryGuard.start = "15:00:00";
  assert.throws(() => validateConfig(invalidLateStart), /Late-entry guard must start/);
  const invalidLateUnclassifiedStart = structuredClone(defaultConfig);
  invalidLateUnclassifiedStart.signals.lateEntryGuard.bearishUnclassifiedImpulseFollowThroughStart = "11:59:59";
  assert.throws(() => validateConfig(invalidLateUnclassifiedStart), /unclassified impulse confirmation/);
  const invalidLateWindow = structuredClone(defaultConfig);
  invalidLateWindow.signals.lateEntryGuard.followThroughMinSec = 16;
  assert.throws(() => validateConfig(invalidLateWindow), /Late-entry guard thresholds/);
  const invalidLateCap = structuredClone(defaultConfig);
  invalidLateCap.signals.lateEntryGuard.maxDailyEntries = 0;
  assert.throws(() => validateConfig(invalidLateCap), /Late-entry guard thresholds/);
  const invalidLateBullishReentry = structuredClone(defaultConfig);
  invalidLateBullishReentry.signals.lateEntryGuard.bullishLowNoiseGrind.reentryCooldownSec =
    invalidLateBullishReentry.signals.sameDirectionCooldownSec + 1;
  assert.throws(() => validateConfig(invalidLateBullishReentry), /Late-entry guard thresholds/);
  const invalidLateBullishReentryEnabled = structuredClone(defaultConfig);
  invalidLateBullishReentryEnabled.signals.lateEntryGuard.bullishLowNoiseGrind.enabled =
    "INVALID" as unknown as boolean;
  assert.throws(() => validateConfig(invalidLateBullishReentryEnabled), /Late-entry guard thresholds/);
  const invalidLateBullishSlowFit = structuredClone(defaultConfig);
  invalidLateBullishSlowFit.signals.lateEntryGuard.bullishLowNoiseGrind.minSlowR2 = 1.01;
  assert.throws(() => validateConfig(invalidLateBullishSlowFit), /Late-entry guard thresholds/);
  const invalidLateBearishProfile = structuredClone(defaultConfig);
  invalidLateBearishProfile.signals.lateEntryGuard.bearishStrongDownImpulse.followThroughMinSec = 6;
  assert.throws(() => validateConfig(invalidLateBearishProfile), /Late-entry guard thresholds/);
  const invalidLateBearishPersistence = structuredClone(defaultConfig);
  invalidLateBearishPersistence.signals.lateEntryGuard
    .bearishUnclassifiedImpulseMinMediumToFastRatio = 1.01;
  assert.throws(() => validateConfig(invalidLateBearishPersistence), /Late-entry guard thresholds/);
  const invalidLateBullishPersistence = structuredClone(defaultConfig);
  invalidLateBullishPersistence.signals.lateEntryGuard.bullishGrindMinMediumNormalizedSlope = 0;
  assert.throws(() => validateConfig(invalidLateBullishPersistence), /Late-entry guard thresholds/);
  const invalidLateBullishEfficiency = structuredClone(defaultConfig);
  invalidLateBullishEfficiency.signals.lateEntryGuard.bullishGrindMinEfficiency60 = 1.01;
  assert.throws(() => validateConfig(invalidLateBullishEfficiency), /Late-entry guard thresholds/);
  const invalidLateSpread = structuredClone(defaultConfig);
  invalidLateSpread.signals.lateEntryGuard.maxOptionSpreadPct =
    defaultConfig.dataQuality.maxOptionSpreadPct + 0.01;
  assert.throws(() => validateConfig(invalidLateSpread), /Late-entry guard thresholds/);
  const invalidMorningMode = structuredClone(defaultConfig);
  invalidMorningMode.signals.morningEntryGuard.mode =
    "INVALID" as typeof invalidMorningMode.signals.morningEntryGuard.mode;
  assert.throws(() => validateConfig(invalidMorningMode), /Morning-entry guard mode/);
  const invalidMorningWindow = structuredClone(defaultConfig);
  invalidMorningWindow.signals.morningEntryGuard.end = "12:01:00";
  assert.throws(() => validateConfig(invalidMorningWindow), /Morning-entry guard must satisfy/);
  const invalidMorningSpread = structuredClone(defaultConfig);
  invalidMorningSpread.signals.morningEntryGuard.maxOptionSpreadPct =
    defaultConfig.dataQuality.maxOptionSpreadPct + 0.01;
  assert.throws(() => validateConfig(invalidMorningSpread), /Morning-entry guard thresholds/);
  const invalidMorningOfiConfirmation = structuredClone(defaultConfig);
  invalidMorningOfiConfirmation.signals.morningEntryGuard.ofiConflictRequiresFollowThrough =
    "true" as unknown as boolean;
  assert.throws(() => validateConfig(invalidMorningOfiConfirmation), /Morning-entry guard thresholds/);
  const excessiveContracts = structuredClone(defaultConfig);
  excessiveContracts.risk.maxContracts = 4;
  assert.throws(() => validateConfig(excessiveContracts), /integer in \[1, 3\]/);
  const invalidSoftActivation = structuredClone(defaultConfig);
  invalidSoftActivation.risk.softProtectionActivationDollars =
    invalidSoftActivation.risk.directWinnerActivationDollars;
  assert.throws(() => validateConfig(invalidSoftActivation), /stopping-controller/);
  const invalidRecoverySoftActivation = structuredClone(defaultConfig);
  invalidRecoverySoftActivation.risk.softProtectionRecoveryActivationDollars =
    invalidRecoverySoftActivation.risk.softProtectionActivationDollars + 1;
  assert.throws(() => validateConfig(invalidRecoverySoftActivation), /stopping-controller/);
  const invalidSoftConfirmation = structuredClone(defaultConfig);
  invalidSoftConfirmation.risk.softProtectionConfirmationObservations = 0;
  assert.throws(() => validateConfig(invalidSoftConfirmation), /stopping-controller/);
  const invalidProfitRetention = structuredClone(defaultConfig);
  invalidProfitRetention.risk.profitRetentionMax = 1.01;
  assert.throws(() => validateConfig(invalidProfitRetention), /fraction outside/);
  const invalidProtectedGreeksGrace = structuredClone(defaultConfig);
  invalidProtectedGreeksGrace.risk.protectedGreeksExitGraceSec =
    invalidProtectedGreeksGrace.risk.greeksExitGraceSec + 1;
  assert.throws(() => validateConfig(invalidProtectedGreeksGrace), /stopping-controller/);
  const invalidSoftRetention = structuredClone(defaultConfig);
  invalidSoftRetention.risk.softProtectionRetentionRatio = 0;
  assert.throws(() => validateConfig(invalidSoftRetention), /stopping-controller/);
  const invalidSoftFloor = structuredClone(defaultConfig);
  invalidSoftFloor.risk.softProtectionMaximumFloorDollars =
    invalidSoftFloor.risk.minimumProfitFloorDollars + 1;
  assert.throws(() => validateConfig(invalidSoftFloor), /stopping-controller/);
  const invalidSoftBreachTime = structuredClone(defaultConfig);
  invalidSoftBreachTime.risk.softFloorBreachConfirmationMs = 0;
  assert.throws(() => validateConfig(invalidSoftBreachTime), /stopping-controller/);
  const invalidSoftBreachObservations = structuredClone(defaultConfig);
  invalidSoftBreachObservations.risk.softFloorBreachMinimumObservations = 1;
  assert.throws(() => validateConfig(invalidSoftBreachObservations), /stopping-controller/);
  const invalidSoftEmergencyLoss = structuredClone(defaultConfig);
  invalidSoftEmergencyLoss.risk.softProtectionEmergencyLossDollars = -1;
  assert.throws(() => validateConfig(invalidSoftEmergencyLoss), /stopping-controller/);
  const invalidOppositeRegimeGrace = structuredClone(defaultConfig);
  invalidOppositeRegimeGrace.risk.oppositeRegimeGraceSec = -1;
  assert.throws(() => validateConfig(invalidOppositeRegimeGrace), /stopping-controller/);
  const invalidOppositeRegimeObservations = structuredClone(defaultConfig);
  invalidOppositeRegimeObservations.risk.oppositeRegimeMinimumObservations = 1;
  assert.throws(() => validateConfig(invalidOppositeRegimeObservations), /stopping-controller/);
});

test("Black-Scholes values/Greeks and IV bisection are internally consistent", () => {
  const input = { spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0, dividendYield: 0, volatility: 0.2, type: "call" as const };
  const result = blackScholes(input);
  assert.ok(Math.abs(result.value - 7.9656) < 0.001);
  assert.ok(Math.abs(result.delta - 0.53983) < 0.001);
  assert.ok(Math.abs(result.gamma - 0.01985) < 0.001);
  const { volatility: _volatility, ...ivInput } = input;
  const recovered = impliedVolatility({ ...ivInput, marketPrice: result.value });
  assert.ok(Math.abs(recovered! - 0.2) < 1e-5);
  const bounds = noArbitrageBounds(input);
  assert.equal(impliedVolatility({ ...ivInput, marketPrice: bounds.upper + 1 }), undefined);
});

test("OCC symbols round trip exactly", () => {
  const symbol = formatOccSymbol({ underlying: "SPY", expirationDate: "2026-07-24", type: "put", strike: 599.5 });
  assert.equal(symbol, "SPY260724P00599500");
  assert.deepEqual(parseOccSymbol(symbol), { underlying: "SPY", expirationDate: "2026-07-24", type: "put", strike: 599.5 });
});

test("delta-adjusted cost implements spread/slippage/multiple mathematics", () => {
  const cost = evaluateOptionCost(1, 1.10, 0.5, 500, 10, 0.2, 1.75);
  assert.ok(Math.abs(cost.roundTripCostPerShare - 0.14) < 1e-12);
  assert.ok(Math.abs(cost.equivalentUnderlyingCostBps - 5.6) < 1e-10);
  assert.ok(Math.abs(cost.requiredMoveBps - 9.8) < 1e-10);
  assert.ok(Math.abs(cost.costMarginBps - 0.2) < 1e-10);
  assert.equal(cost.passes, true);
  assert.ok(gammaAwareProjectedOptionMove(500, 10, 0.5, 0.02) > 0.25);
});

test("risk sizing honors every cap and resets the hard stop from actual fill", () => {
  const riskConfig = structuredClone(defaultConfig);
  riskConfig.risk.maxTradesPerDay = 3;
  const manager = new RiskManager(riskConfig);
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const decision = manager.evaluate({
    timestamp, optionMid: 2, hasOpenPosition: false,
    account: { equity: 100_000, optionBuyingPower: 10_000, active: true, optionsApproved: true, killSwitch: false },
  });
  // The production contract cap is lower than the five-contract risk budget.
  assert.equal(decision.maxLossPerContract, 50);
  assert.equal(decision.quantity, 3);
  const cappedDecision = manager.evaluate({
    timestamp, optionMid: 1, hasOpenPosition: false,
    account: { equity: 1_000_000, optionBuyingPower: 100_000, active: true, optionsApproved: true, killSwitch: false },
  });
  assert.equal(cappedDecision.quantity, 3);
  const filled = manager.createFilledPosition("SPY260722C00500000", "BULLISH", 1, 2.20, timestamp);
  assert.ok(Math.abs(filled.stopPrice - 1.65) < 1e-12);
  for (let i = 0; i < riskConfig.risk.maxTradesPerDay - 1; i += 1) manager.recordEntry(timestamp);
  assert.equal(manager.evaluate({ timestamp, optionMid: 2, hasOpenPosition: false, account: {
    equity: 100_000, optionBuyingPower: 10_000, active: true, optionsApproved: true, killSwitch: false,
  } }).allowed, true);
  manager.recordEntry(timestamp);
  assert.equal(manager.evaluate({ timestamp, optionMid: 2, hasOpenPosition: false, account: {
    equity: 100_000, optionBuyingPower: 10_000, active: true, optionsApproved: true, killSwitch: false,
  } }).allowed, false);
});

test("the high daily safety limit permits another entry after six restored fills", () => {
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const restored = { marketDate: "2026-07-22", entries: 6, realizedPnl: 0 };
  const request = {
    timestamp, optionMid: 2, hasOpenPosition: false,
    account: { equity: 100_000, optionBuyingPower: 10_000, active: true, optionsApproved: true, killSwitch: false },
  };
  const manager = new RiskManager(defaultConfig);
  manager.restoreState(restored);
  assert.equal(manager.evaluate(request).allowed, true);
});

test("the high late-entry cap leaves six restored fills executable", () => {
  const restored = { marketDate: "2026-07-22", entries: 6, realizedPnl: 0 };
  const account = {
    equity: 100_000, optionBuyingPower: 10_000, active: true, optionsApproved: true, killSwitch: false,
  };
  const manager = new RiskManager(defaultConfig);
  manager.restoreState(restored);

  const morning = manager.evaluate({
    timestamp: zonedDateTimeToEpoch("2026-07-22", "11:59:59"),
    optionMid: 2,
    hasOpenPosition: false,
    account,
  });
  assert.equal(morning.allowed, true);

  const late = manager.evaluate({
    timestamp: zonedDateTimeToEpoch("2026-07-22", "12:00:00"),
    optionMid: 2,
    hasOpenPosition: false,
    account,
  });
  assert.equal(late.allowed, true);

  const isolatedCapConfig = structuredClone(defaultConfig);
  isolatedCapConfig.risk.maxTradesPerDay = 2_000;
  const capped = new RiskManager(isolatedCapConfig);
  capped.restoreState({ ...restored, entries: defaultConfig.signals.lateEntryGuard.maxDailyEntries });
  const cappedDecision = capped.evaluate({
    timestamp: zonedDateTimeToEpoch("2026-07-22", "12:00:00"),
    optionMid: 2,
    hasOpenPosition: false,
    account,
  });
  assert.equal(cappedDecision.allowed, false);
  assert.ok(cappedDecision.reasons.includes("LATE_ENTRY_MAX_DAILY_ENTRIES_REACHED"));
});

const exitContext = (position: PositionState, timestamp: number, mid: number) => ({
  timestamp, position, optionQuote: { symbol: position.symbol, timestamp, bidPrice: mid - 0.01, askPrice: mid + 0.01, bidSize: 10, askSize: 10 }, killSwitch: false,
});

function alpacaFlow(symbol: string, timestamp: number, confirmationScore: number): AlpacaOptionFeatures {
  return {
    symbol,
    timestamp,
    windowMs: 5_000,
    dataFresh: true,
    quoteAgeMs: 0,
    tradeAgeMs: 0,
    quoteEvents: 3,
    tradeEvents: 2,
    mid: 2,
    microprice: 2,
    micropriceDisplacementBps: 0,
    quoteImbalance: confirmationScore,
    quoteOfi: confirmationScore,
    spreadPct: 0.02,
    spreadExpansionRatio: 1,
    premiumMomentumBps: 0,
    bidMomentumBps: 0,
    tradeVolume: 100,
    buyVolume: confirmationScore > 0 ? 100 : 0,
    sellVolume: confirmationScore < 0 ? 100 : 0,
    neutralVolume: 0,
    tradeImbalance: confirmationScore,
    tradeMomentumBps: 0,
    confirmationScore,
  };
}

function unifiedPosition(entryTimestamp: number, overrides: Partial<PositionState> = {}): PositionState {
  return {
    symbol: "OPT",
    direction: "BULLISH",
    quantity: 1,
    averageEntryPrice: 2,
    entryTimestamp,
    stopPrice: 1.5,
    tradeState: "OPEN_UNPROTECTED",
    executablePnl: 0,
    highWaterPnl: 0,
    lowWaterPnl: 0,
    lastPnlTimestamp: entryTimestamp,
    lastHighTimestamp: entryTimestamp,
    previousExecutablePnl: 0,
    pnlEwmaDriftPerSec: 0,
    pnlEwmaVariancePerSec: 0,
    reversalCusum: 0,
    zeroCrossings: 0,
    previousPnlSign: 0,
    pnlObservationCount: 0,
    ...overrides,
  };
}

test("exit manager enforces emergency precedence and protects a strong winner", () => {
  const manager = new ExitManager(defaultConfig);
  const entry = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const position = unifiedPosition(entry);
  assert.equal(manager.evaluate({ ...exitContext(position, entry + 1000, 1.4), killSwitch: true }).reason, "KILL_SWITCH");
  const hardStop = manager.evaluate(exitContext(position, entry + 1000, 1.4));
  assert.equal(hardStop.reason, "HARD_STOP");
  assert.ok(hardStop.updatedPosition.lowWaterPnl < 0);
  const winner = manager.evaluate(exitContext(position, entry + 1000, 2.8));
  assert.equal(winner.exit, false);
  assert.equal(winner.updatedPosition.tradeState, "PROTECTED_WINNER");
  assert.ok(winner.updatedPosition.highWaterPnl > 0);
  assert.equal(
    manager.evaluate(exitContext(position, entry + defaultConfig.risk.maxHoldSec * 1000, 2)).reason,
    "RECOVERY_TIMEOUT",
  );
  const protectedPosition: PositionState = {
    ...position,
    tradeState: "PROTECTED_WINNER",
    executablePnl: 20,
    highWaterPnl: 20,
    protectedFloorPnl: 7,
  };
  assert.equal(
    manager.evaluate(exitContext(protectedPosition, entry + defaultConfig.risk.maxHoldSec * 1000, 2.2)).reason,
    "MAX_HOLD",
  );
  const forced = zonedDateTimeToEpoch("2026-07-22", "15:50:00");
  assert.equal(manager.evaluate(exitContext(position, forced, 2)).reason, "FORCED_SESSION_EXIT");
  assert.equal(manager.evaluate({ timestamp: entry + 11_000, position, killSwitch: false }).reason, "STALE_DATA");
});

test("exit manager distinguishes a fresh invalid quote from genuinely stale data", () => {
  const manager = new ExitManager(defaultConfig);
  const entry = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const position = unifiedPosition(entry);
  const validQuote = {
    symbol: position.symbol,
    timestamp: entry,
    bidPrice: 1.99,
    askPrice: 2.01,
    bidSize: 10,
    askSize: 10,
  };
  const fresh = manager.evaluate({
    timestamp: entry + 57,
    position,
    optionQuote: validQuote,
    killSwitch: false,
  });
  assert.equal(fresh.exit, false);
  assert.equal(fresh.reason, undefined);

  const locked = manager.evaluate({
    timestamp: entry + 57,
    position,
    optionQuote: {
      ...validQuote,
      timestamp: entry + 50,
      bidPrice: 1.94,
      askPrice: 1.94,
    },
    killSwitch: false,
  });
  assert.equal(locked.exit, true);
  assert.equal(locked.reason, "BROKER_OR_POSITION_RISK");
  assert.ok(locked.triggers?.includes("BROKER_OR_POSITION_RISK"));

  const stale = manager.evaluate({
    timestamp: entry + defaultConfig.risk.staleDataEmergencySec * 1_000 + 1,
    position,
    optionQuote: validQuote,
    killSwitch: false,
  });
  assert.equal(stale.reason, "STALE_DATA");
});

test("opposite regimes require distinct persistent evidence and reset after alignment", () => {
  const manager = new ExitManager(defaultConfig);
  const entry = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  let position = unifiedPosition(entry);
  const down: RegimeDecision = { regime: "STRONG_DOWN", confidence: 1, reasons: [] };
  const up: RegimeDecision = { regime: "STRONG_UP", confidence: 1, reasons: [] };
  const featureAt = (timestamp: number) => ({
    timestamp,
    medium: { normalizedSlope: 1 },
    price: 501,
    vwap: { sessionVwap: 500 },
  }) as unknown as FeatureSnapshot;

  let decision = manager.evaluate({
    ...exitContext(position, entry + 1_000, 2),
    regime: down,
    feature: featureAt(entry + 1_000),
  });
  assert.equal(decision.exit, false);
  assert.equal(decision.updatedPosition.oppositeRegimeObservationCount, 1);
  position = decision.updatedPosition;

  decision = manager.evaluate({
    ...exitContext(position, entry + 3_500, 2),
    regime: down,
    feature: featureAt(entry + 1_000),
  });
  assert.equal(decision.exit, false);
  assert.equal(decision.updatedPosition.oppositeRegimeObservationCount, 1);
  position = decision.updatedPosition;

  decision = manager.evaluate({
    ...exitContext(position, entry + 4_000, 2),
    regime: up,
    feature: featureAt(entry + 4_000),
  });
  assert.equal(decision.exit, false);
  assert.equal(decision.updatedPosition.oppositeRegimeSince, undefined);
  position = decision.updatedPosition;

  for (const offsetMs of [5_000, 6_000, 7_000]) {
    decision = manager.evaluate({
      ...exitContext(position, entry + offsetMs, 2),
      regime: down,
      feature: featureAt(entry + offsetMs),
    });
    position = decision.updatedPosition;
  }
  assert.equal(decision.reason, "OPPOSITE_REGIME");
});

test("medium-structure invalidation retains its independent 8-second grace", () => {
  const manager = new ExitManager(defaultConfig);
  const entry = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const position = unifiedPosition(entry);
  const feature = { medium: { normalizedSlope: -1 }, price: 499, vwap: { sessionVwap: 500 } } as unknown as FeatureSnapshot;
  const first = manager.evaluate({ ...exitContext(position, entry + 1000, 2), feature });
  assert.equal(first.exit, false);
  const later = manager.evaluate({ ...exitContext(first.updatedPosition, entry + 9000, 2), feature });
  assert.equal(later.reason, "TREND_INVALIDATION");
});

test("unified exit manager waits for mature invalidation evidence on a brief reversal", () => {
  const manager = new ExitManager(defaultConfig);
  const entry = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const position = unifiedPosition(entry, { underlyingEntryPrice: 500 });
  const reversed = {
    price: 499.99,
    fast: { normalizedSlope: -0.5 },
    medium: { normalizedSlope: 0.5 },
    vwap: { sessionVwap: 499 },
  } as unknown as FeatureSnapshot;
  const decision = manager.evaluate({
    ...exitContext(position, entry + 5_000, 2), feature: reversed,
  });
  assert.equal(decision.exit, false);
  assert.equal(decision.reason, undefined);
});

test("unified trade state uses executable bid P&L and distinguishes recovered from direct winners", () => {
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const risk = new RiskManager(defaultConfig);
  const estimator = new TradeStateEstimator(defaultConfig);
  const direct = risk.createFilledPosition(
    "SPY260722C00500000", "BULLISH", 1, 2, timestamp, 500,
  );

  const falseMidpoint = estimator.estimate(direct, {
    symbol: direct.symbol,
    timestamp: timestamp + 1_000,
    bidPrice: 1.99,
    askPrice: 2.21,
    bidSize: 10,
    askSize: 10,
  }, timestamp + 1_000);
  assert.ok(falseMidpoint.midpointPnl > 0);
  assert.ok(falseMidpoint.executablePnl < 0);
  assert.equal(falseMidpoint.position.tradeState, "OPEN_UNPROTECTED");

  const belowDirectWinner = estimator.estimate(direct, {
    symbol: direct.symbol,
    timestamp: timestamp + 1_000,
    bidPrice: 2.10,
    askPrice: 2.12,
    bidSize: 10,
    askSize: 10,
  }, timestamp + 1_000);
  assert.ok(belowDirectWinner.executablePnl < defaultConfig.risk.directWinnerActivationDollars);
  assert.notEqual(belowDirectWinner.position.tradeState, "PROTECTED_WINNER");

  const directWinner = estimator.estimate(direct, {
    symbol: direct.symbol,
    timestamp: timestamp + 1_000,
    bidPrice: 2.11,
    askPrice: 2.13,
    bidSize: 10,
    askSize: 10,
  }, timestamp + 1_000);
  assert.ok(directWinner.executablePnl >= defaultConfig.risk.directWinnerActivationDollars);
  assert.ok(directWinner.executablePnl < 12);
  assert.equal(directWinner.position.tradeState, "PROTECTED_WINNER");
  assert.ok(directWinner.position.protectedFloorPnl! >= defaultConfig.risk.minimumProfitFloorDollars);

  let recovered = risk.createFilledPosition(
    "SPY260722C00500000", "BULLISH", 1, 2, timestamp, 500,
  );
  recovered = estimator.estimate(recovered, {
    symbol: recovered.symbol,
    timestamp: timestamp + 1_000,
    bidPrice: 1.90,
    askPrice: 1.92,
    bidSize: 10,
    askSize: 10,
  }, timestamp + 1_000).position;
  recovered = estimator.estimate(recovered, {
    symbol: recovered.symbol,
    timestamp: timestamp + 2_000,
    bidPrice: 2.23,
    askPrice: 2.25,
    bidSize: 10,
    askSize: 10,
  }, timestamp + 2_000).position;
  assert.equal(recovered.tradeState, "PROTECTED_RECOVERED");
});

test("trade-state observations and reversal CUSUM advance only on new market evidence", () => {
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const estimator = new TradeStateEstimator(defaultConfig);
  let position = new RiskManager(defaultConfig).createFilledPosition(
    "SPY260722C00500000", "BULLISH", 1, 2, timestamp, 500,
  );
  const feature = {
    timestamp: timestamp + 1_000,
    fast: { normalizedSlope: -1 },
  } as unknown as FeatureSnapshot;
  const first = estimator.estimate(position, {
    symbol: position.symbol,
    timestamp: timestamp + 1_000,
    bidPrice: 1.98,
    askPrice: 2,
    bidSize: 10,
    askSize: 10,
  }, timestamp + 1_000, feature);
  position = first.position;
  assert.equal(position.pnlObservationCount, 1);
  assert.ok(position.reversalCusum > 0);
  const firstCusum = position.reversalCusum;
  const firstPnlTimestamp = position.lastPnlTimestamp;

  const duplicate = estimator.estimate(position, {
    symbol: position.symbol,
    timestamp: timestamp + 1_100,
    bidPrice: 1.98,
    askPrice: 2,
    bidSize: 12,
    askSize: 12,
  }, timestamp + 1_100, feature);
  position = duplicate.position;
  assert.equal(position.pnlObservationCount, 1);
  assert.equal(position.lastPnlTimestamp, firstPnlTimestamp);
  assert.equal(position.reversalCusum, firstCusum);

  const later = estimator.estimate(position, {
    symbol: position.symbol,
    timestamp: timestamp + 2_000,
    bidPrice: 1.97,
    askPrice: 1.99,
    bidSize: 10,
    askSize: 10,
  }, timestamp + 2_000, {
    ...feature,
    timestamp: timestamp + 2_000,
  });
  assert.equal(later.position.pnlObservationCount, 2);
  assert.equal(later.position.lastPnlTimestamp, timestamp + 2_000);
  assert.ok(later.position.reversalCusum > firstCusum);
});

test("winner protection never lowers an established executable profit floor", () => {
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const risk = new RiskManager(defaultConfig);
  const manager = new ExitManager(defaultConfig);
  let position = risk.createFilledPosition(
    "SPY260722C00500000", "BULLISH", 1, 2, timestamp, 500,
  );
  const firstWinner = manager.evaluate(exitContext(position, timestamp + 1_000, 2.80));
  assert.equal(firstWinner.exit, false);
  assert.equal(firstWinner.updatedPosition.tradeState, "PROTECTED_WINNER");
  const firstFloor = firstWinner.updatedPosition.protectedFloorPnl!;

  const ordinaryPullback = manager.evaluate(
    exitContext(firstWinner.updatedPosition, timestamp + 2_000, 2.70),
  );
  assert.equal(ordinaryPullback.exit, false);
  assert.ok(ordinaryPullback.updatedPosition.protectedFloorPnl! >= firstFloor);
  position = ordinaryPullback.updatedPosition;

  const newHigh = manager.evaluate(exitContext(position, timestamp + 3_000, 3.20));
  assert.equal(newHigh.exit, false);
  assert.ok(newHigh.updatedPosition.protectedFloorPnl! >= position.protectedFloorPnl!);
});

test("QQQ full-winner tuning protects the August 18 recovered winner one bid step earlier", () => {
  const timestamp = zonedDateTimeToEpoch("2026-08-18", "11:09:07");
  const baselineConfig = structuredClone(qqqConfig);
  baselineConfig.risk.profitRetentionPeakScaleDollars = 100;
  const position = new RiskManager(qqqConfig).createFilledPosition(
    "QQQ260818P00717000", "BEARISH", 3, 1.74, timestamp, 717,
  );
  position.lowWaterPnl = -7.5;
  // The retained live path reached this peak through many small observations;
  // avoid manufacturing a one-sample volatility spike in the focused fixture.
  position.lastPnlTimestamp = timestamp + 6_000;

  const peakQuote = {
    symbol: position.symbol,
    timestamp: timestamp + 6_000,
    bidPrice: 1.82,
    askPrice: 1.83,
    bidSize: 55,
    askSize: 146,
  };
  const tunedPeak = new ExitManager(qqqConfig).evaluate({
    timestamp: peakQuote.timestamp,
    position,
    optionQuote: peakQuote,
    killSwitch: false,
  });
  const baselinePeak = new ExitManager(baselineConfig).evaluate({
    timestamp: peakQuote.timestamp,
    position,
    optionQuote: peakQuote,
    killSwitch: false,
  });

  assert.equal(tunedPeak.updatedPosition.tradeState, "PROTECTED_RECOVERED");
  assert.ok(
    tunedPeak.updatedPosition.protectedFloorPnl! >
      baselinePeak.updatedPosition.protectedFloorPnl!,
  );
  const pullbackQuote = {
    ...peakQuote,
    timestamp: timestamp + 6_900,
    bidPrice: 1.80,
    askPrice: 1.83,
  };
  const tunedPullback = new ExitManager(qqqConfig).evaluate({
    timestamp: pullbackQuote.timestamp,
    position: tunedPeak.updatedPosition,
    optionQuote: pullbackQuote,
    killSwitch: false,
  });
  const baselinePullback = new ExitManager(baselineConfig).evaluate({
    timestamp: pullbackQuote.timestamp,
    position: baselinePeak.updatedPosition,
    optionQuote: pullbackQuote,
    killSwitch: false,
  });

  assert.equal(tunedPullback.reason, "PROFIT_FLOOR_EXIT");
  assert.equal(baselinePullback.exit, false);
});

test("soft protection resets quote flicker and exits only a persistent buffered-floor breach", () => {
  const timestamp = zonedDateTimeToEpoch("2026-07-29", "10:54:32");
  const manager = new ExitManager(defaultConfig);
  let position = unifiedPosition(timestamp);

  let decision = manager.evaluate(exitContext(position, timestamp + 1_000, 2.0525));
  assert.equal(decision.exit, false);
  assert.equal(decision.updatedPosition.tradeState, "OPEN_UNPROTECTED");
  assert.equal(
    decision.updatedPosition.softProtectionCandidateObservationCount,
    decision.updatedPosition.pnlObservationCount,
  );
  position = decision.updatedPosition;

  decision = manager.evaluate(exitContext(position, timestamp + 2_000, 2.04));
  assert.equal(decision.updatedPosition.tradeState, "OPEN_UNPROTECTED");
  assert.equal(
    decision.updatedPosition.softProtectionCandidateObservationCount,
    undefined,
  );
  position = decision.updatedPosition;

  decision = manager.evaluate(exitContext(position, timestamp + 3_000, 2.0475));
  assert.equal(decision.updatedPosition.tradeState, "OPEN_UNPROTECTED");
  position = decision.updatedPosition;

  decision = manager.evaluate(exitContext(position, timestamp + 4_000, 2.0525));
  assert.equal(decision.updatedPosition.tradeState, "OPEN_UNPROTECTED");
  position = decision.updatedPosition;

  decision = manager.evaluate(exitContext(position, timestamp + 5_000, 2.0625));
  assert.equal(decision.exit, false);
  assert.equal(decision.updatedPosition.tradeState, "PROTECTED_SOFT");
  assert.ok(Math.abs(
    decision.updatedPosition.protectedFloorPnl! -
      decision.updatedPosition.highWaterPnl *
        defaultConfig.risk.softProtectionRetentionRatio,
  ) < 1e-9);
  assert.ok(decision.updatedPosition.highWaterPnl < defaultConfig.risk.directWinnerActivationDollars);
  position = decision.updatedPosition;

  decision = manager.evaluate(exitContext(position, timestamp + 6_000, 2.03));
  assert.equal(decision.exit, false);
  assert.ok(decision.executablePnl! > decision.protectedFloorPnl!);
  position = decision.updatedPosition;

  decision = manager.evaluate(exitContext(position, timestamp + 7_000, 2.025));
  assert.equal(decision.exit, false);
  assert.equal(
    decision.updatedPosition.softFloorBreachCandidateObservationCount,
    decision.updatedPosition.pnlObservationCount,
  );
  position = decision.updatedPosition;

  decision = manager.evaluate(exitContext(position, timestamp + 7_100, 2.03));
  assert.equal(decision.exit, false);
  assert.equal(decision.updatedPosition.softFloorBreachStartedAt, undefined);
  assert.equal(
    decision.updatedPosition.softFloorBreachCandidateObservationCount,
    undefined,
  );
  position = decision.updatedPosition;

  decision = manager.evaluate(exitContext(position, timestamp + 7_200, 2.025));
  assert.equal(decision.exit, false);
  position = decision.updatedPosition;

  decision = manager.evaluate(exitContext(position, timestamp + 7_300, 2.0225));
  assert.equal(decision.exit, false);
  position = decision.updatedPosition;

  decision = manager.evaluate(exitContext(position, timestamp + 7_800, 2.0225));
  assert.equal(decision.exit, true);
  assert.equal(decision.reason, "PROFIT_FLOOR_EXIT");
  assert.ok(decision.executablePnl! > 0);
});

test("recovery-specific soft protection arms earlier without tightening clean developing trades", () => {
  const timestamp = zonedDateTimeToEpoch("2026-07-30", "11:23:00");
  const manager = new ExitManager(defaultConfig);
  let recovered = unifiedPosition(timestamp);

  let decision = manager.evaluate(exitContext(recovered, timestamp + 1_000, 1.96));
  assert.equal(decision.exit, false);
  assert.ok(
    decision.updatedPosition.lowWaterPnl <=
      -defaultConfig.risk.meaningfulAdverseExcursionDollars,
  );
  recovered = decision.updatedPosition;

  for (const [offsetMs, mid] of [
    [2_000, 2.035],
    [3_000, 2.0375],
    [4_000, 2.04],
  ] as const) {
    decision = manager.evaluate(exitContext(recovered, timestamp + offsetMs, mid));
    assert.equal(decision.exit, false);
    recovered = decision.updatedPosition;
  }
  assert.equal(recovered.tradeState, "PROTECTED_SOFT");
  assert.ok(recovered.highWaterPnl < defaultConfig.risk.softProtectionActivationDollars);

  decision = manager.evaluate(exitContext(recovered, timestamp + 5_000, 2.01));
  assert.equal(decision.exit, true);
  assert.equal(decision.reason, "PROFIT_FLOOR_EXIT");

  let clean = unifiedPosition(timestamp);
  for (const [offsetMs, mid] of [
    [2_000, 2.035],
    [3_000, 2.0375],
    [4_000, 2.04],
  ] as const) {
    decision = manager.evaluate(exitContext(clean, timestamp + offsetMs, mid));
    assert.equal(decision.exit, false);
    clean = decision.updatedPosition;
  }
  assert.equal(clean.tradeState, "OPEN_UNPROTECTED");
  assert.equal(clean.softProtectionCandidateObservationCount, undefined);
});

test("soft protection preserves the newest July 29 winner through sub-500ms quote flicker", () => {
  const timestamp = zonedDateTimeToEpoch("2026-07-29", "11:30:01");
  const manager = new ExitManager(defaultConfig);
  let position = unifiedPosition(timestamp, {
    tradeState: "PROTECTED_SOFT",
    executablePnl: 1.75,
    highWaterPnl: 4.75,
    lowWaterPnl: -6.5,
    protectedFloorPnl: 0.7125,
    pnlObservationCount: 50,
  });

  // Actual critical path: +$0.50, +$0.75, +$0.50, then +$4.50
  // 404 ms later. Every recovery above the floor resets confirmation.
  for (const [offsetMs, mid] of [
    [5, 2.02],
    [75, 2.0225],
    [124, 2.02],
    [528, 2.06],
  ] as const) {
    const decision = manager.evaluate(exitContext(position, timestamp + offsetMs, mid));
    assert.equal(decision.exit, false);
    position = decision.updatedPosition;
  }
  assert.equal(position.tradeState, "PROTECTED_SOFT");
  assert.equal(position.softFloorBreachStartedAt, undefined);
  assert.equal(position.softFloorBreachCandidateObservationCount, undefined);
  assert.ok(Math.abs(position.executablePnl - 4.5) < 1e-9);

  const recoveredWinner = manager.evaluate(
    exitContext(position, timestamp + 45_000, 2.17),
  );
  assert.equal(recoveredWinner.exit, false);
  assert.equal(recoveredWinner.updatedPosition.tradeState, "PROTECTED_RECOVERED");
  assert.ok(
    recoveredWinner.updatedPosition.protectedFloorPnl! >=
      defaultConfig.risk.minimumProfitFloorDollars,
  );
});

test("an unconfirmed pullback is not promoted into a stale giveback exit before recovery", () => {
  const timestamp = zonedDateTimeToEpoch("2026-07-29", "11:05:14");
  const manager = new ExitManager(defaultConfig);
  let position = unifiedPosition(timestamp, {
    executablePnl: 3.75,
    highWaterPnl: 3.75,
    lowWaterPnl: -2,
    lastHighTimestamp: timestamp,
    pnlObservationCount: 10,
  });

  let decision = manager.evaluate(exitContext(position, timestamp + 4_000, 2.02));
  assert.equal(decision.exit, false);
  assert.equal(decision.updatedPosition.tradeState, "OPEN_UNPROTECTED");
  position = decision.updatedPosition;

  decision = manager.evaluate(exitContext(position, timestamp + 5_000, 2.1425));
  assert.equal(decision.exit, false);
  assert.equal(decision.updatedPosition.tradeState, "PROTECTED_WINNER");
});

test("a capped soft floor keeps its buffer through the July 24 big-winner pullback", () => {
  const timestamp = zonedDateTimeToEpoch("2026-07-24", "10:50:11");
  const manager = new ExitManager(defaultConfig);
  let position = unifiedPosition(timestamp, {
    tradeState: "PROTECTED_SOFT",
    executablePnl: 6.75,
    highWaterPnl: 6.75,
    protectedFloorPnl: defaultConfig.risk.softProtectionMaximumFloorDollars,
    pnlObservationCount: 20,
    lastHighTimestamp: timestamp,
  });

  let decision = manager.evaluate(exitContext(position, timestamp + 1_000, 2.0325));
  assert.equal(decision.exit, false);
  assert.equal(
    decision.updatedPosition.softFloorBreachCandidateObservationCount,
    decision.updatedPosition.pnlObservationCount,
  );
  position = decision.updatedPosition;

  decision = manager.evaluate(exitContext(position, timestamp + 1_400, 2.05));
  assert.equal(decision.exit, false);
  assert.equal(decision.updatedPosition.softFloorBreachStartedAt, undefined);
  position = decision.updatedPosition;

  decision = manager.evaluate(exitContext(position, timestamp + 2_000, 2.1425));
  assert.equal(decision.exit, false);
  assert.equal(decision.updatedPosition.tradeState, "PROTECTED_WINNER");
});

test("soft protection keeps a separate immediate emergency-loss escape", () => {
  const timestamp = zonedDateTimeToEpoch("2026-07-29", "11:30:01");
  const manager = new ExitManager(defaultConfig);
  const position = unifiedPosition(timestamp, {
    tradeState: "PROTECTED_SOFT",
    executablePnl: 1,
    highWaterPnl: 5,
    protectedFloorPnl: 0.75,
    pnlObservationCount: 10,
  });
  const decision = manager.evaluate(exitContext(position, timestamp + 1, 2.01));
  assert.equal(decision.exit, true);
  assert.equal(decision.reason, "PROFIT_FLOOR_EXIT");
  assert.ok(
    decision.executablePnl! <=
      -defaultConfig.risk.softProtectionEmergencyLossDollars,
  );
});

test("buffered soft protection preserves the July 29 $14.75 winner path", () => {
  const timestamp = zonedDateTimeToEpoch("2026-07-29", "11:05:14");
  const manager = new ExitManager(defaultConfig);
  let position = unifiedPosition(timestamp);

  // The observed winner first touched +$3.75, then pulled back below zero.
  // That failed touch must reset instead of arming a stale protection latch.
  for (const [offsetMs, mid] of [
    [1_000, 2.0525],
    [2_000, 2.04],
    [3_000, 2.01],
  ] as const) {
    const decision = manager.evaluate(exitContext(position, timestamp + offsetMs, mid));
    assert.equal(decision.exit, false);
    position = decision.updatedPosition;
  }
  assert.equal(position.tradeState, "OPEN_UNPROTECTED");
  assert.equal(position.softProtectionCandidateObservationCount, undefined);

  // Its sustained advance confirmed soft protection, peaked at +$7.75, and
  // retraced to +$2.50 before continuing. The capped floor must leave it alive.
  for (const [offsetMs, mid] of [
    [4_000, 2.0525],
    [5_000, 2.0625],
    [6_000, 2.0725],
    [7_000, 2.0925],
    [8_000, 2.04],
  ] as const) {
    const decision = manager.evaluate(exitContext(position, timestamp + offsetMs, mid));
    assert.equal(decision.exit, false);
    position = decision.updatedPosition;
  }
  assert.equal(position.tradeState, "PROTECTED_SOFT");
  assert.equal(
    position.protectedFloorPnl,
    defaultConfig.risk.softProtectionMaximumFloorDollars,
  );
  assert.ok(position.executablePnl > position.protectedFloorPnl!);

  const fullWinner = manager.evaluate(
    exitContext(position, timestamp + 9_000, 2.1425),
  );
  assert.equal(fullWinner.exit, false);
  assert.equal(fullWinner.updatedPosition.tradeState, "PROTECTED_WINNER");
  assert.ok(
    fullWinner.updatedPosition.protectedFloorPnl! >=
      defaultConfig.risk.minimumProfitFloorDollars,
  );
});

test("soft protection does not arm reversal CUSUM exits before full confirmation", () => {
  const timestamp = zonedDateTimeToEpoch("2026-07-29", "11:05:14");
  const manager = new ExitManager(defaultConfig);
  const position = unifiedPosition(timestamp, {
    tradeState: "PROTECTED_SOFT",
    executablePnl: 4,
    highWaterPnl: 5,
    reversalCusum: defaultConfig.risk.reversalCusumThreshold + 10,
  });
  const decision = manager.evaluate(exitContext(position, timestamp + 1_000, 2.04));
  assert.equal(decision.exit, false);
  assert.equal(decision.updatedPosition.tradeState, "PROTECTED_SOFT");
});

test("bad entries exit on path-implied recovery probability before the hard-loss boundary", () => {
  const config = structuredClone(defaultConfig);
  config.risk.recoveryProbabilityMinAgeSec = 0;
  config.risk.recoveryProbabilityMinObservations = 2;
  config.risk.recoveryProbabilityGraceSec = 0;
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const risk = new RiskManager(config);
  const manager = new ExitManager(config);
  let position = risk.createFilledPosition(
    "SPY260722C00500000", "BULLISH", 1, 2, timestamp, 500,
  );
  let decision = manager.evaluate(exitContext(position, timestamp + 1_000, 1.96));
  assert.equal(decision.exit, false);
  position = decision.updatedPosition;
  decision = manager.evaluate(exitContext(position, timestamp + 2_000, 1.91));
  assert.equal(decision.reason, "RECOVERY_PROBABILITY_TOO_LOW");
  assert.ok(decision.recoveryProbability! <
    (decision.executablePnl! + 50) / (config.risk.recoveredActivationDollars + 50));
  assert.ok(decision.liquidationPrice! > position.stopPrice);
});

test("fallback recovery probability does not cut an ordinary developing winner", () => {
  const config = structuredClone(defaultConfig);
  config.risk.recoveryProbabilityMinAgeSec = 0;
  config.risk.recoveryProbabilityMinObservations = 2;
  config.risk.recoveryProbabilityGraceSec = 0;
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const risk = new RiskManager(config);
  const manager = new ExitManager(config);
  let position = risk.createFilledPosition(
    "SPY260722C00500000", "BULLISH", 1, 2, timestamp, 500,
  );
  let decision = manager.evaluate(exitContext(position, timestamp + 1_000, 2.02));
  assert.equal(decision.exit, false);
  position = decision.updatedPosition;
  decision = manager.evaluate(exitContext(position, timestamp + 2_000, 1.99));
  assert.equal(decision.exit, false);
  assert.ok(decision.updatedPosition.lowWaterPnl >
    -config.risk.meaningfulAdverseExcursionDollars);
  assert.equal(decision.recoveryProbability, undefined);
});

test("a losing entry that recovers promptly becomes protected instead of taking a premature recovery exit", () => {
  const config = structuredClone(defaultConfig);
  config.risk.recoveryProbabilityMinAgeSec = 0;
  config.risk.recoveryProbabilityMinObservations = 2;
  config.risk.recoveryProbabilityGraceSec = 0;
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const risk = new RiskManager(config);
  const manager = new ExitManager(config);
  let position = risk.createFilledPosition(
    "SPY260722C00500000", "BULLISH", 1, 2, timestamp, 500,
  );
  position = manager.evaluate(exitContext(position, timestamp + 1_000, 1.90)).updatedPosition;
  const recovered = manager.evaluate(exitContext(position, timestamp + 2_000, 2.24));
  assert.equal(recovered.exit, false);
  assert.equal(recovered.updatedPosition.tradeState, "PROTECTED_RECOVERED");
  assert.ok(recovered.updatedPosition.protectedFloorPnl! > 0);
});

test("failure-to-recover deadline exits an unprotected trade without waiting for the hard stop", () => {
  const config = structuredClone(defaultConfig);
  config.risk.recoveryDeadlineSec = 10;
  config.risk.recoveryProbabilityMinAgeSec = 60;
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const position = new RiskManager(config).createFilledPosition(
    "SPY260722C00500000", "BULLISH", 1, 2, timestamp, 500,
  );
  const decision = new ExitManager(config).evaluate(
    exitContext(position, timestamp + 10_000, 1.90),
  );
  assert.equal(decision.reason, "RECOVERY_TIMEOUT");
  assert.ok(decision.liquidationPrice! > position.stopPrice);
});

test("Greeks continuation exits IV crush and theta drag despite a still-valid SPY thesis", () => {
  const config = structuredClone(defaultConfig);
  config.risk.greeksExitGraceSec = 5;
  config.risk.recoveryProbabilityMinAgeSec = 60;
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const risk = new RiskManager(config);
  const manager = new ExitManager(config);
  let position = risk.createFilledPosition(
    "SPY260722C00500000", "BULLISH", 1, 2, timestamp, 500,
  );
  position.entryImpliedVolatility = 0.50;
  position.lastImpliedVolatility = 0.50;
  position.lastOptionSnapshotTimestamp = timestamp;
  const feature = {
    symbol: "SPY",
    timestamp: timestamp + 1_000,
    price: 500.01,
    fast: {
      normalizedSlope: 0.2,
      windowSec: 10,
      realizedVolatilityBps: 0,
      regression: { slopeBpsPerSec: 0.01 },
    },
    medium: { normalizedSlope: 0.2 },
    vwap: { sessionVwap: 499.99 },
  } as unknown as FeatureSnapshot;
  const snapshot = {
    symbol: position.symbol,
    timestamp: timestamp + 1_000,
    impliedVolatility: 0.30,
    greeks: { delta: 0.50, gamma: 0.01, theta: -1.5, vega: 0.10 },
  };
  let decision = manager.evaluate({
    ...exitContext(position, timestamp + 1_000, 2),
    feature,
    optionSnapshot: snapshot,
  });
  assert.equal(decision.exit, false);
  assert.equal(decision.updatedPosition.optionContinuation?.ivCrushDetected, true);
  assert.equal(
    decision.updatedPosition.optionContinuation?.providerGreeksAvailable,
    true,
  );
  assert.ok(decision.continuationLcbDollars! < 0);

  position = decision.updatedPosition;
  decision = manager.evaluate({
    ...exitContext(position, timestamp + 6_000, 2),
    feature: { ...feature, timestamp: timestamp + 6_000 },
    optionSnapshot: { ...snapshot, timestamp: timestamp + 6_000 },
  });
  assert.equal(decision.reason, "GREEKS_CONTINUATION_LCB_NON_POSITIVE");
  assert.ok(decision.triggers?.includes("CONTINUATION_LCB_NON_POSITIVE"));
});

test("fresh Alpaca option flow makes a bounded adjustment to the continuation LCB", () => {
  const config = structuredClone(defaultConfig);
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const position = new RiskManager(config).createFilledPosition(
    "SPY260722C00500000", "BULLISH", 1, 2, timestamp, 500,
  );
  const quote = {
    symbol: position.symbol, timestamp: timestamp + 1_000,
    bidPrice: 1.98, askPrice: 2.02, bidSize: 100, askSize: 100,
  };
  const snapshot = {
    symbol: position.symbol,
    timestamp: timestamp + 1_000,
    impliedVolatility: 0.30,
    greeks: { delta: 0, gamma: 0, theta: 0, vega: 0 },
  };
  const positive = estimateOptionContinuation(
    position, quote, snapshot, undefined, timestamp + 1_000, config,
    alpacaFlow(position.symbol, timestamp + 1_000, 1),
  ).estimate!;
  const negative = estimateOptionContinuation(
    position, quote, snapshot, undefined, timestamp + 1_000, config,
    alpacaFlow(position.symbol, timestamp + 1_000, -1),
  ).estimate!;
  const stale = estimateOptionContinuation(
    position, quote, snapshot, undefined, timestamp + 1_000, config,
    { ...alpacaFlow(position.symbol, timestamp + 1_000, 1), dataFresh: false },
  ).estimate!;
  const wrongContract = estimateOptionContinuation(
    position, quote, snapshot, undefined, timestamp + 1_000, config,
    alpacaFlow("SPY260722P00500000", timestamp + 1_000, 1),
  ).estimate!;

  assert.equal(positive.alpacaFlowEvidenceUsed, true);
  assert.ok(positive.alpacaFlowAdjustmentDollars > 0);
  assert.ok(negative.alpacaFlowAdjustmentDollars < 0);
  assert.ok(positive.lcbDollars > negative.lcbDollars);
  assert.equal(stale.alpacaFlowEvidenceUsed, false);
  assert.equal(stale.alpacaFlowAdjustmentDollars, 0);
  assert.equal(wrongContract.alpacaFlowEvidenceUsed, false);
  assert.equal(wrongContract.alpacaFlowAdjustmentDollars, 0);
  const maximumAdjustment = 100 * (quote.askPrice - quote.bidPrice) *
    config.risk.alpacaOptionFeatures.flowAdjustmentSpreadFraction;
  assert.ok(Math.abs(positive.alpacaFlowAdjustmentDollars) <= maximumAdjustment + 1e-9);
});

test("positive Alpaca option flow cannot override the hard loss boundary", () => {
  const config = structuredClone(defaultConfig);
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const position = new RiskManager(config).createFilledPosition(
    "SPY260722C00500000", "BULLISH", 1, 2, timestamp, 500,
  );
  const decision = new ExitManager(config).evaluate({
    ...exitContext(position, timestamp + 1_000, position.stopPrice - 0.01),
    optionSnapshot: {
      symbol: position.symbol,
      timestamp: timestamp + 1_000,
      impliedVolatility: 0.30,
      greeks: { delta: 1, gamma: 1, theta: 1, vega: 1 },
    },
    alpacaOptionFeatures: alpacaFlow(position.symbol, timestamp + 1_000, 1),
  });

  assert.equal(decision.exit, true);
  assert.equal(decision.reason, "HARD_STOP");
  assert.ok(decision.triggers?.includes("HARD_LOSS_BOUNDARY"));
});

test("a protected winner confirms negative option continuation faster", () => {
  const config = structuredClone(defaultConfig);
  config.risk.greeksExitGraceSec = 5;
  config.risk.protectedGreeksExitGraceSec = 0.5;
  config.risk.recoveryProbabilityMinAgeSec = 60;
  const timestamp = zonedDateTimeToEpoch("2026-07-31", "10:42:03");
  const manager = new ExitManager(config);
  let position = unifiedPosition(timestamp, {
    symbol: "SPY260731C00740000",
    tradeState: "PROTECTED_WINNER",
    executablePnl: 15,
    highWaterPnl: 20,
    lastHighTimestamp: timestamp,
    protectionActivatedAt: timestamp,
    entryImpliedVolatility: 0.50,
    lastImpliedVolatility: 0.50,
    lastOptionSnapshotTimestamp: timestamp,
    lastUnderlyingPrice: 500,
    lastUnderlyingTimestamp: timestamp,
  });
  const feature = {
    symbol: "SPY",
    timestamp: timestamp + 1_000,
    price: 500.01,
    fast: {
      normalizedSlope: 0.2,
      windowSec: 10,
      realizedVolatilityBps: 0,
      regression: { slopeBpsPerSec: 0.01 },
    },
    medium: { normalizedSlope: 0.2 },
    vwap: { sessionVwap: 499.99 },
  } as unknown as FeatureSnapshot;
  const snapshot = {
    symbol: position.symbol,
    timestamp: timestamp + 1_000,
    impliedVolatility: 0.30,
    greeks: { delta: 0.50, gamma: 0.01, theta: -1.5, vega: 0.10 },
  };

  let decision = manager.evaluate({
    ...exitContext(position, timestamp + 1_000, 2.15),
    feature,
    optionSnapshot: snapshot,
  });
  assert.equal(decision.exit, false);
  assert.ok(decision.continuationLcbDollars! < 0);
  position = decision.updatedPosition;

  decision = manager.evaluate({
    ...exitContext(position, timestamp + 1_500, 2.15),
    feature: { ...feature, timestamp: timestamp + 1_500 },
    optionSnapshot: { ...snapshot, timestamp: timestamp + 1_500 },
  });
  assert.equal(decision.reason, "GREEKS_CONTINUATION_LCB_NON_POSITIVE");
  assert.ok(decision.executablePnl! > decision.protectedFloorPnl!);
});

test("positive delta/gamma continuation lets a strong direct winner run", () => {
  const config = structuredClone(defaultConfig);
  config.risk.greeksExitGraceSec = 0;
  config.risk.recoveryProbabilityMinAgeSec = 60;
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const position = new RiskManager(config).createFilledPosition(
    "SPY260722C00500000", "BULLISH", 1, 2, timestamp, 500,
  );
  position.entryImpliedVolatility = 0.30;
  position.lastImpliedVolatility = 0.30;
  position.lastOptionSnapshotTimestamp = timestamp;
  const feature = {
    symbol: "SPY",
    timestamp: timestamp + 1_000,
    price: 500.05,
    fast: {
      normalizedSlope: 1,
      windowSec: 10,
      realizedVolatilityBps: 0.2,
      regression: { slopeBpsPerSec: 1 },
    },
    medium: { normalizedSlope: 1 },
    vwap: { sessionVwap: 499 },
  } as unknown as FeatureSnapshot;
  const decision = new ExitManager(config).evaluate({
    ...exitContext(position, timestamp + 1_000, 2.20),
    feature,
    optionSnapshot: {
      symbol: position.symbol,
      timestamp: timestamp + 1_000,
      impliedVolatility: 0.30,
      greeks: { delta: 0.55, gamma: 0.02, theta: -1, vega: 0.08 },
    },
  });
  assert.equal(decision.exit, false);
  assert.equal(decision.updatedPosition.tradeState, "PROTECTED_WINNER");
  assert.ok(decision.continuationLcbDollars! > 0);
});

test("continuation metrics use deterministic modeled Greeks when snapshots contain only volume", () => {
  const config = structuredClone(defaultConfig);
  config.risk.recoveryProbabilityMinAgeSec = 60;
  config.risk.greeksExitGraceSec = 0;
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const position = new RiskManager(config).createFilledPosition(
    "SPY260722C00500000", "BULLISH", 1, 2, timestamp, 500,
  );
  const feature = {
    symbol: "SPY",
    timestamp: timestamp + 1_000,
    price: 500.05,
    fast: {
      normalizedSlope: 1,
      windowSec: 10,
      realizedVolatilityBps: 0.2,
      regression: { slopeBpsPerSec: 0 },
    },
    medium: { normalizedSlope: 1 },
    vwap: { sessionVwap: 499 },
  } as unknown as FeatureSnapshot;
  const decision = new ExitManager(config).evaluate({
    ...exitContext(position, timestamp + 1_000, 2.02),
    feature,
    optionSnapshot: {
      symbol: position.symbol,
      timestamp: timestamp + 1_000,
      dailyVolume: 1_000,
    },
  });
  assert.equal(decision.exit, false);
  assert.ok(decision.updatedPosition.optionContinuation);
  assert.ok(Number.isFinite(decision.continuationLcbDollars));
  assert.ok(decision.continuationLcbDollars! < 0);
  assert.ok(Number.isFinite(decision.updatedPosition.optionContinuation!.deltaDollars));
  assert.ok(Number.isFinite(decision.updatedPosition.optionContinuation!.gammaDollars));
  assert.ok(Number.isFinite(decision.updatedPosition.optionContinuation!.thetaDollars));
  assert.ok(Number.isFinite(decision.updatedPosition.optionContinuation!.vegaDollars));
  assert.equal(
    decision.updatedPosition.optionContinuation!.providerGreeksAvailable,
    false,
  );
});

test("protected trades exit on adverse SPY reversal CUSUM before the hard floor", () => {
  const config = structuredClone(defaultConfig);
  config.risk.reversalCusumThreshold = 0.5;
  config.risk.recoveryProbabilityMinAgeSec = 60;
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const manager = new ExitManager(config);
  let position = new RiskManager(config).createFilledPosition(
    "SPY260722C00500000", "BULLISH", 1, 2, timestamp, 500,
  );
  position = manager.evaluate(exitContext(position, timestamp + 1_000, 2.20)).updatedPosition;
  const adverseFeature = {
    timestamp: timestamp + 2_000,
    price: 500.01,
    fast: { normalizedSlope: -1 },
    medium: { normalizedSlope: 1 },
    vwap: { sessionVwap: 499 },
  } as unknown as FeatureSnapshot;
  const decision = manager.evaluate({
    ...exitContext(position, timestamp + 2_000, 2.18),
    feature: adverseFeature,
  });
  assert.equal(decision.reason, "REVERSAL_CUSUM");
  assert.ok(decision.executablePnl! > decision.protectedFloorPnl!);
});

test("order state machine handles rounding, partial fill, replacement and cancel", () => {
  const executor = new OrderExecutor(defaultConfig);
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "10:30:00");
  const symbol = "SPY260722C00500000";
  const quote = { symbol, timestamp, bidPrice: 1, askPrice: 1.10, bidSize: 10, askSize: 10 };
  assert.ok(Math.abs(limitInsideSpread(1, 1.10, "buy", 0.55) - 1.06) < 1e-10);
  assert.ok(Math.abs(limitInsideSpread(1, 1.10, "sell", 0.35) - 1.06) < 1e-10);
  assert.ok(aggressionAtReplacement(0.55, 1, 2) > 0.55);
  let state = executor.submit(executor.propose({ clientOrderId: "id", symbol, side: "buy", quantity: 3, timestamp, quote }), timestamp);
  state = executor.recordFill(state, timestamp + 100, 1, 1.06);
  assert.equal(state.status, "PARTIAL");
  assert.equal(state.filledQuantity, 1);
  const exposure = reconcileEntryExposure(state, "BULLISH", timestamp + 100, new RiskManager(defaultConfig));
  assert.equal(exposure?.quantity, 1);
  assert.equal(exposure?.averageEntryPrice, 1.06);
  state = executor.onTimer(state, timestamp + 2000, { ...quote, timestamp: timestamp + 2000 });
  assert.equal(state.replacements, 1);
  state = executor.onTimer(state, timestamp + 7000, { ...quote, timestamp: timestamp + 7000 });
  assert.equal(state.status, "CANCEL_PENDING");
  assert.equal(executor.confirmCancel(state, timestamp + 7100).status, "CANCELED");
  const forced = executor.propose({ clientOrderId: "forced", symbol, side: "sell", quantity: 1, timestamp, quote, marketable: true });
  assert.equal(forced.limitPrice, quote.bidPrice);
  assert.equal(forced.marketable, true);
});

test("order boundary permits only current-day SPY options and blocks late entries", () => {
  const executor = new OrderExecutor(defaultConfig);
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "10:30:00");
  const proposal = (symbol: string, side: "buy" | "sell" = "buy", at = timestamp) => ({
    clientOrderId: "guard-test", symbol, side, quantity: 1, timestamp: at,
    quote: { symbol, timestamp: at, bidPrice: 1, askPrice: 1.02, bidSize: 10, askSize: 10 },
  });
  assert.throws(() => executor.propose(proposal("SPY")), /NOT_OCC_OPTION_SYMBOL/);
  assert.throws(() => executor.propose(proposal("QQQ260722C00500000")), /WRONG_UNDERLYING/);
  assert.throws(() => executor.propose(proposal("SPY260724C00500000")), /NOT_SAME_DAY_EXPIRATION/);
  const beforeEntry = zonedDateTimeToEpoch("2026-07-22", "10:14:59");
  assert.throws(() => executor.propose(proposal("SPY260722C00500000", "buy", beforeEntry)), /ENTRY_WINDOW_CLOSED/);
  const afterCutoff = zonedDateTimeToEpoch("2026-07-22", "14:30:01");
  assert.throws(() => executor.propose(proposal("SPY260722C00500000", "buy", afterCutoff)), /ENTRY_CUTOFF_PASSED/);
  assert.doesNotThrow(() => executor.propose(proposal("SPY260722C00500000", "sell", afterCutoff)));
});
