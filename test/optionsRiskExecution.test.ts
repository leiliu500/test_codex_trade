import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, validateConfig } from "../src/config.js";
import { blackScholes, impliedVolatility, noArbitrageBounds } from "../src/options/blackScholes.js";
import { evaluateOptionCost, gammaAwareProjectedOptionMove } from "../src/options/costGate.js";
import { formatOccSymbol, parseOccSymbol } from "../src/options/occSymbol.js";
import { RiskManager } from "../src/risk/riskManager.js";
import { ExitManager } from "../src/risk/exitManager.js";
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

test("risk sizing honors every cap and resets stop/target from actual fill", () => {
  const manager = new RiskManager(defaultConfig);
  const timestamp = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const decision = manager.evaluate({
    timestamp, optionMid: 2, hasOpenPosition: false,
    account: { equity: 100_000, optionBuyingPower: 10_000, active: true, optionsApproved: true, killSwitch: false },
  });
  // risk budget $250 / $50 stop loss = 5 contracts.
  assert.equal(decision.quantity, 5);
  const filled = manager.createFilledPosition("SPY260722C00500000", "BULLISH", 5, 2.20, timestamp);
  assert.ok(Math.abs(filled.stopPrice - 1.65) < 1e-12);
  assert.ok(Math.abs(filled.targetPrice - 2.97) < 1e-12);
  manager.recordEntry(timestamp);
  for (let i = 1; i < defaultConfig.risk.maxTradesPerDay; i += 1) manager.recordEntry(timestamp);
  assert.equal(manager.evaluate({ timestamp, optionMid: 2, hasOpenPosition: false, account: {
    equity: 100_000, optionBuyingPower: 10_000, active: true, optionsApproved: true, killSwitch: false,
  } }).allowed, false);
});

const exitContext = (position: PositionState, timestamp: number, mid: number) => ({
  timestamp, position, optionQuote: { symbol: position.symbol, timestamp, bidPrice: mid - 0.01, askPrice: mid + 0.01, bidSize: 10, askSize: 10 }, killSwitch: false,
});

test("exit manager enforces emergency and price precedence", () => {
  const manager = new ExitManager(defaultConfig);
  const entry = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const position: PositionState = { symbol: "OPT", direction: "BULLISH", quantity: 1, averageEntryPrice: 2,
    entryTimestamp: entry, stopPrice: 1.5, targetPrice: 2.7, highWaterMark: 2 };
  assert.equal(manager.evaluate({ ...exitContext(position, entry + 1000, 1.4), killSwitch: true }).reason, "KILL_SWITCH");
  assert.equal(manager.evaluate(exitContext(position, entry + 1000, 1.4)).reason, "HARD_STOP");
  assert.equal(manager.evaluate(exitContext(position, entry + 1000, 2.8)).reason, "PROFIT_TARGET");
  const trailing = { ...position, highWaterMark: 2.5 };
  assert.equal(manager.evaluate(exitContext(trailing, entry + 1000, 2.04)).reason, "TRAILING_STOP");
  assert.equal(manager.evaluate(exitContext(position, entry + defaultConfig.risk.maxHoldSec * 1000, 2)).reason, "MAX_HOLD");
  const forced = zonedDateTimeToEpoch("2026-07-22", "15:50:00");
  assert.equal(manager.evaluate(exitContext(position, forced, 2)).reason, "FORCED_SESSION_EXIT");
  assert.equal(manager.evaluate({ timestamp: entry + 11_000, position, killSwitch: false }).reason, "STALE_DATA");
});

test("opposite regimes and 8-second trend invalidation exit", () => {
  const manager = new ExitManager(defaultConfig);
  const entry = zonedDateTimeToEpoch("2026-07-22", "11:00:00");
  const position: PositionState = { symbol: "OPT", direction: "BULLISH", quantity: 1, averageEntryPrice: 2,
    entryTimestamp: entry, stopPrice: 1.5, targetPrice: 2.7, highWaterMark: 2 };
  const down: RegimeDecision = { regime: "STRONG_DOWN", confidence: 1, reasons: [] };
  assert.equal(manager.evaluate({ ...exitContext(position, entry + 1000, 2), regime: down }).reason, "OPPOSITE_REGIME");
  const feature = { medium: { normalizedSlope: -1 }, price: 499, vwap: { sessionVwap: 500 } } as unknown as FeatureSnapshot;
  const first = manager.evaluate({ ...exitContext(position, entry + 1000, 2), feature });
  assert.equal(first.exit, false);
  const later = manager.evaluate({ ...exitContext(first.updatedPosition, entry + 9000, 2), feature });
  assert.equal(later.reason, "TREND_INVALIDATION");
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
