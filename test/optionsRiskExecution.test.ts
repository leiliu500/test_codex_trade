import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, validateConfig } from "../src/config.js";
import { blackScholes, impliedVolatility, noArbitrageBounds } from "../src/options/blackScholes.js";
import { evaluateOptionCost, gammaAwareProjectedOptionMove } from "../src/options/costGate.js";
import { formatOccSymbol, parseOccSymbol } from "../src/options/occSymbol.js";
import { RiskManager } from "../src/risk/riskManager.js";
import { ExitManager } from "../src/risk/exitManager.js";
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
  const invalidConfirmation = structuredClone(defaultConfig);
  invalidConfirmation.signals.followThroughMinSec = 16;
  invalidConfirmation.signals.followThroughMaxSec = 15;
  assert.throws(() => validateConfig(invalidConfirmation), /Follow-through confirmation/);
  const invalidNoiseMultiplier = structuredClone(defaultConfig);
  invalidNoiseMultiplier.signals.followThroughNoiseMultiplier = -0.01;
  assert.throws(() => validateConfig(invalidNoiseMultiplier), /Follow-through confirmation/);
  const invalidOppositeCooldown = structuredClone(defaultConfig);
  invalidOppositeCooldown.signals.oppositeDirectionCooldownSec = -1;
  assert.throws(() => validateConfig(invalidOppositeCooldown), /Signal cooldowns/);
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
  const invalidLateBearishProfile = structuredClone(defaultConfig);
  invalidLateBearishProfile.signals.lateEntryGuard.bearishStrongDownImpulse.followThroughMinSec = 6;
  assert.throws(() => validateConfig(invalidLateBearishProfile), /Late-entry guard thresholds/);
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
  const multipleContracts = structuredClone(defaultConfig);
  multipleContracts.risk.maxContracts = 2;
  assert.throws(() => validateConfig(multipleContracts), /exactly one option contract/);
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
  // The risk budget could support five contracts, but production entry sizing is fixed at one.
  assert.equal(decision.maxLossPerContract, 50);
  assert.equal(decision.quantity, 1);
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

test("opposite regimes and 8-second trend invalidation exit", () => {
  const manager = new ExitManager(defaultConfig);
  const entry = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const position = unifiedPosition(entry);
  const down: RegimeDecision = { regime: "STRONG_DOWN", confidence: 1, reasons: [] };
  assert.equal(manager.evaluate({ ...exitContext(position, entry + 1000, 2), regime: down }).reason, "OPPOSITE_REGIME");
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

  const directWinner = estimator.estimate(direct, {
    symbol: direct.symbol,
    timestamp: timestamp + 1_000,
    bidPrice: 2.18,
    askPrice: 2.20,
    bidSize: 10,
    askSize: 10,
  }, timestamp + 1_000);
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
