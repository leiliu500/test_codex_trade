import type { EngineConfig } from "../config.js";
import { defaultConfig } from "../config.js";
import type {
  AccountState, CalibrationProfile, OptionCandidateEvaluation, OptionQuote, PositionState, ReplayEvent,
  RiskDecision, SecondBar, TradeSignal,
} from "../types.js";
import { SecondAggregator } from "../features/secondAggregator.js";
import { FeatureEngine } from "../features/featureEngine.js";
import { classifyRegime } from "../strategy/regimeClassifier.js";
import { SignalEngine } from "../strategy/signalEngine.js";
import { OptionBook } from "../options/optionBook.js";
import { OptionSelector } from "../options/optionSelector.js";
import { RiskManager } from "../risk/riskManager.js";
import { ExitManager } from "../risk/exitManager.js";
import { OrderExecutor, type OrderState } from "../execution/orderExecutor.js";
import { SerializedDecisionQueue } from "../execution/tradingEngine.js";
import { MemoryRecorder, type AuditRecorder } from "../ops/recorder.js";
import { computeStrategyMetrics, type CompletedTrade, type StrategyMetrics } from "./metrics.js";
import { businessDaysBetween, marketDate } from "../utils/time.js";

export type FillModel = "conservative" | "midpoint-touch" | "queue";

interface PendingEntry {
  purpose: "ENTRY";
  state: OrderState;
  signal: TradeSignal;
  candidate: OptionCandidateEvaluation;
  risk: RiskDecision;
}
interface PendingExit {
  purpose: "EXIT";
  state: OrderState;
  reason: string;
}
type PendingOrder = PendingEntry | PendingExit;

export interface ReplayFunnel {
  validFeatures: number;
  signals: number;
  candidateAvailable: number;
  costGatePassed: number;
  riskAllowed: number;
  ordersSubmitted: number;
  fills: number;
  completedTrades: number;
}

export interface ReplayResult {
  funnel: ReplayFunnel;
  trades: CompletedTrade[];
  metrics: StrategyMetrics;
  rejectionCounts: Record<string, number>;
  auditEvents: ReturnType<MemoryRecorder["events"]["slice"]>;
  openPosition?: PositionState;
  pendingOrder?: OrderState;
}

export interface ReplayOptions {
  config?: EngineConfig;
  calibration?: CalibrationProfile;
  fillModel?: FillModel;
  account?: Partial<AccountState>;
  recorder?: AuditRecorder;
  feesPerContractRoundTrip?: number;
}

export class ReplayEngine {
  readonly #config: EngineConfig;
  readonly #calibration: CalibrationProfile | undefined;
  readonly #fillModel: FillModel;
  readonly #aggregator: SecondAggregator;
  readonly #features: FeatureEngine;
  readonly #signals: SignalEngine;
  readonly #book = new OptionBook();
  readonly #selector: OptionSelector;
  readonly #risk: RiskManager;
  readonly #exits: ExitManager;
  readonly #orders: OrderExecutor;
  readonly #queue = new SerializedDecisionQueue();
  readonly #memoryRecorder = new MemoryRecorder();
  readonly #recorder: AuditRecorder;
  readonly #account: AccountState;
  readonly #feesPerContractRoundTrip: number;
  readonly #contracts = new Map<string, ReplayEvent & { type: "option_contract" }>();
  readonly #trades: CompletedTrade[] = [];
  readonly #rejections: Record<string, number> = {};
  readonly #funnel: ReplayFunnel = {
    validFeatures: 0, signals: 0, candidateAvailable: 0, costGatePassed: 0,
    riskAllowed: 0, ordersSubmitted: 0, fills: 0, completedTrades: 0,
  };
  #lastTimestamp = -Infinity;
  #position: PositionState | undefined;
  #positionSignal: TradeSignal | undefined;
  #positionCandidate: OptionCandidateEvaluation | undefined;
  #positionMarks: number[] = [];
  #pending: PendingOrder | undefined;

  constructor(options: ReplayOptions = {}) {
    this.#config = options.config ?? defaultConfig;
    this.#calibration = options.calibration;
    this.#fillModel = options.fillModel ?? "conservative";
    this.#aggregator = new SecondAggregator(this.#config.dataQuality);
    this.#features = new FeatureEngine(this.#config, options.calibration);
    this.#signals = new SignalEngine(this.#config);
    this.#selector = new OptionSelector(this.#config);
    this.#risk = new RiskManager(this.#config);
    this.#exits = new ExitManager(this.#config);
    this.#orders = new OrderExecutor(this.#config);
    this.#recorder = options.recorder ?? this.#memoryRecorder;
    this.#feesPerContractRoundTrip = options.feesPerContractRoundTrip ?? 0;
    this.#account = {
      equity: options.account?.equity ?? 100_000,
      optionBuyingPower: options.account?.optionBuyingPower ?? 100_000,
      active: options.account?.active ?? true,
      optionsApproved: options.account?.optionsApproved ?? true,
      killSwitch: options.account?.killSwitch ?? false,
    };
  }

  async ingest(event: ReplayEvent): Promise<void> {
    if (!Number.isFinite(event.timestamp)) throw new Error("Replay event has invalid timestamp");
    if (event.timestamp < this.#lastTimestamp) throw new Error(`Replay timestamp decreased: ${event.timestamp} < ${this.#lastTimestamp}`);
    this.#lastTimestamp = event.timestamp;
    await this.#queue.enqueue(async () => {
      // Completed bars are handled before the next arrival, preserving arrival-order causality.
      await this.#handleBars(this.#aggregator.flushThrough(event.timestamp));
      switch (event.type) {
        case "stock_quote": {
          const result = this.#aggregator.ingestQuote(event.data);
          if (result.rejected) this.#audit(event.timestamp, "stock_quote_rejected", { reasons: result.rejected.reasons });
          await this.#handleBars(result.bars);
          break;
        }
        case "stock_trade": {
          const result = this.#aggregator.ingestTrade(event.data);
          if (result.rejected) this.#audit(event.timestamp, "stock_trade_rejected", { reasons: result.rejected.reasons });
          await this.#handleBars(result.bars);
          break;
        }
        case "option_contract":
          this.#book.upsertContract(event.data);
          this.#contracts.set(event.data.symbol, event as ReplayEvent & { type: "option_contract" });
          break;
        case "option_quote":
          if (!this.#book.updateQuote(event.data)) this.#audit(event.timestamp, "option_quote_rejected", { reason: "OUT_OF_ORDER", symbol: event.data.symbol });
          break;
        case "option_snapshot":
          if (!this.#book.updateSnapshot(event.data)) this.#audit(event.timestamp, "option_snapshot_rejected", { reason: "OUT_OF_ORDER", symbol: event.data.symbol });
          break;
        case "prior_close":
          this.#features.setPriorClose(event.data.close);
          break;
      }
    });
  }

  async finish(): Promise<ReplayResult> {
    if (Number.isFinite(this.#lastTimestamp)) await this.#queue.enqueue(() => this.#handleBars(this.#aggregator.flushThrough(this.#lastTimestamp + 1000)));
    await this.#queue.drained();
    const auditEvents = this.#recorder === this.#memoryRecorder ? this.#memoryRecorder.events.slice() : [];
    return {
      funnel: { ...this.#funnel },
      trades: this.#trades.slice(),
      metrics: computeStrategyMetrics(this.#trades, this.#account.equity),
      rejectionCounts: { ...this.#rejections },
      auditEvents,
      ...(this.#position ? { openPosition: { ...this.#position } } : {}),
      ...(this.#pending ? { pendingOrder: { ...this.#pending.state, events: [...this.#pending.state.events] } } : {}),
    };
  }

  async #handleBars(bars: readonly SecondBar[]): Promise<void> {
    for (const bar of bars) {
      const feature = this.#features.onBar(bar);
      if (!feature) continue;
      if (feature.dataValid) this.#funnel.validFeatures += 1;
      const regime = classifyRegime(feature, this.#config.regimes);
      this.#audit(bar.timestamp, "decision_snapshot", {
        feature, regime, position: this.#position ?? null, pendingOrder: this.#pending?.state ?? null,
      });

      if (this.#pending) this.#advancePending(bar.timestamp);
      if (this.#pending) continue;

      if (this.#position) {
        const entry = this.#book.get(this.#position.symbol);
        if (entry?.quote) this.#positionMarks.push((entry.quote.bidPrice + entry.quote.askPrice) / 2);
        const decision = this.#exits.evaluate({
          timestamp: bar.timestamp,
          position: this.#position,
          ...(entry?.quote ? { optionQuote: entry.quote } : {}),
          feature,
          regime,
          killSwitch: this.#account.killSwitch,
        });
        this.#position = decision.updatedPosition;
        if (decision.exit) {
          this.#audit(bar.timestamp, "exit_decision", { reason: decision.reason ?? "UNKNOWN", mark: decision.markPrice ?? null });
          if (entry?.quote) this.#submitExit(bar.timestamp, entry.quote, decision.reason ?? "UNKNOWN");
        }
        continue;
      }

      const signal = this.#signals.evaluate(feature, regime);
      if (!signal) continue;
      this.#funnel.signals += 1;
      this.#audit(bar.timestamp, "signal", { signal });
      const contracts = [...this.#contracts.values()].map((event) => event.data);
      const selection = this.#selector.select(signal, contracts, this.#book);
      for (const [reason, count] of Object.entries(selection.rejectionCounts)) this.#rejections[reason] = (this.#rejections[reason] ?? 0) + count;
      this.#audit(bar.timestamp, "option_selection", { evaluations: selection.evaluations, selected: selection.selected ?? null });
      if (!selection.selected) continue;
      this.#funnel.candidateAvailable += 1;
      this.#funnel.costGatePassed += 1;
      const candidate = selection.selected;
      const risk = this.#risk.evaluate({
        timestamp: bar.timestamp,
        optionMid: candidate.mid!,
        account: this.#account,
        hasOpenPosition: false,
      });
      this.#audit(bar.timestamp, "risk_decision", { risk });
      if (!risk.allowed) continue;
      this.#funnel.riskAllowed += 1;
      const quote = this.#book.get(candidate.symbol)?.quote;
      if (!quote) continue;
      let state = this.#orders.propose({
        clientOrderId: `entry-${signal.id}`,
        symbol: candidate.symbol,
        side: "buy",
        quantity: risk.quantity,
        timestamp: bar.timestamp,
        quote,
      });
      state = this.#orders.submit(state, bar.timestamp);
      this.#pending = { purpose: "ENTRY", state, signal, candidate, risk };
      this.#funnel.ordersSubmitted += 1;
      this.#audit(bar.timestamp, "order_submitted", { purpose: "ENTRY", order: state });
      this.#tryImmediateFill(bar.timestamp, quote);
    }
  }

  #submitExit(timestamp: number, quote: OptionQuote, reason: string): void {
    if (!this.#position) return;
    let state = this.#orders.propose({
      clientOrderId: `exit-${this.#position.symbol}-${timestamp}`,
      symbol: this.#position.symbol,
      side: "sell",
      quantity: this.#position.quantity,
      timestamp,
      quote,
      marketable: reason === "FORCED_SESSION_EXIT" || reason === "KILL_SWITCH",
    });
    state = this.#orders.submit(state, timestamp);
    this.#pending = { purpose: "EXIT", state, reason };
    this.#funnel.ordersSubmitted += 1;
    this.#audit(timestamp, "order_submitted", { purpose: "EXIT", reason, order: state });
    this.#tryImmediateFill(timestamp, quote);
  }

  #tryImmediateFill(timestamp: number, quote: OptionQuote): void {
    if (!this.#pending) return;
    if (this.#fillModel === "conservative") {
      const price = this.#pending.state.side === "buy" ? quote.askPrice : quote.bidPrice;
      this.#pending.state.limitPrice = price;
      this.#orders.recordFill(this.#pending.state, timestamp, this.#pending.state.requestedQuantity, price);
      this.#completePending(timestamp);
    } else if (this.#fillModel === "midpoint-touch") {
      this.#orders.simulateMidpointFill(this.#pending.state, quote, timestamp);
      if (this.#pending.state.status === "FILLED") this.#completePending(timestamp);
    }
  }

  #advancePending(timestamp: number): void {
    const pending = this.#pending;
    if (!pending) return;
    const quote = this.#book.get(pending.state.symbol)?.quote;
    this.#orders.onTimer(pending.state, timestamp, quote);
    if (pending.state.status === "CANCEL_PENDING") {
      this.#orders.confirmCancel(pending.state, timestamp);
      this.#audit(timestamp, "order_canceled", { order: pending.state });
      this.#pending = undefined;
      return;
    }
    if (!quote || quote.timestamp <= pending.state.submittedAt) return;
    if (this.#fillModel === "midpoint-touch") this.#orders.simulateMidpointFill(pending.state, quote, timestamp);
    else if (this.#fillModel === "queue") {
      const crossed = pending.state.side === "buy"
        ? quote.askPrice <= pending.state.limitPrice : quote.bidPrice >= pending.state.limitPrice;
      if (crossed) this.#orders.recordFill(
        pending.state, timestamp, pending.state.requestedQuantity - pending.state.filledQuantity, pending.state.limitPrice,
      );
    }
    if (pending.state.status === "FILLED") this.#completePending(timestamp);
  }

  #completePending(timestamp: number): void {
    const pending = this.#pending;
    if (!pending || pending.state.status !== "FILLED") return;
    this.#funnel.fills += 1;
    if (pending.purpose === "ENTRY") {
      this.#position = this.#risk.createFilledPosition(
        pending.state.symbol, pending.signal.direction, pending.state.filledQuantity, pending.state.averageFillPrice, timestamp,
      );
      this.#positionSignal = pending.signal;
      this.#positionCandidate = pending.candidate;
      this.#positionMarks = [pending.state.averageFillPrice];
      this.#risk.recordEntry(timestamp);
      this.#signals.recordEntry(pending.signal.direction, timestamp);
      this.#account.optionBuyingPower -= 100 * pending.state.filledQuantity * pending.state.averageFillPrice;
      this.#audit(timestamp, "entry_filled", { order: pending.state, position: this.#position });
    } else if (this.#position) {
      const position = this.#position;
      const fees = this.#feesPerContractRoundTrip * position.quantity;
      const pnl = 100 * position.quantity * (pending.state.averageFillPrice - position.averageEntryPrice) - fees;
      const candidate = this.#positionCandidate;
      const trade: CompletedTrade = {
        sessionDate: marketDate(position.entryTimestamp, this.#config.timeZone),
        quantity: position.quantity,
        entryPrice: position.averageEntryPrice,
        exitPrice: pending.state.averageFillPrice,
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: timestamp,
        fees,
        ...(this.#positionSignal ? { direction: this.#positionSignal.direction, kind: this.#positionSignal.kind, regime: this.#positionSignal.regime } : {}),
        ...(candidate?.contract ? { dte: businessDaysBetween(marketDate(position.entryTimestamp, this.#config.timeZone), candidate.contract.expirationDate) } : {}),
        ...(candidate?.delta !== undefined ? { delta: candidate.delta } : {}),
        ...(candidate?.spreadPct !== undefined ? { optionSpreadPct: candidate.spreadPct } : {}),
        marks: [...this.#positionMarks, pending.state.averageFillPrice],
        estimatedTradingCost: (candidate?.roundTripCostPerShare ?? 0) * 100 * position.quantity + fees,
      };
      this.#trades.push(trade);
      this.#funnel.completedTrades += 1;
      this.#risk.recordRealizedPnl(timestamp, pnl);
      this.#account.optionBuyingPower += 100 * position.quantity * pending.state.averageFillPrice;
      this.#audit(timestamp, "exit_filled", { reason: pending.reason, order: pending.state, pnl, trade });
      this.#position = undefined;
      this.#positionSignal = undefined;
      this.#positionCandidate = undefined;
      this.#positionMarks = [];
    }
    this.#pending = undefined;
  }

  #audit(timestamp: number, type: string, data: Record<string, unknown>): void {
    const event = {
      timestamp,
      marketDate: marketDate(timestamp, this.#config.timeZone),
      type,
      configVersion: this.#config.version,
      ...(this.#calibration ? { calibrationVersion: this.#calibration.version } : {}),
      data,
    };
    void this.#recorder.record(event);
  }
}

export function parseReplayLine(line: string, lineNumber = 1): ReplayEvent {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw new Error(`Invalid JSON at replay line ${lineNumber}`); }
  if (!value || typeof value !== "object") throw new Error(`Replay line ${lineNumber} is not an object`);
  const candidate = value as Partial<ReplayEvent>;
  const allowed = new Set(["stock_quote", "stock_trade", "option_contract", "option_quote", "option_snapshot", "prior_close"]);
  if (!candidate.type || !allowed.has(candidate.type) || !Number.isFinite(candidate.timestamp) || !("data" in candidate)) {
    throw new Error(`Invalid replay schema at line ${lineNumber}`);
  }
  return candidate as ReplayEvent;
}

export async function replayEvents(events: readonly ReplayEvent[], options: ReplayOptions = {}): Promise<ReplayResult> {
  const engine = new ReplayEngine(options);
  for (const event of events) await engine.ingest(event);
  return engine.finish();
}

export async function replaySensitivityBand(
  events: readonly ReplayEvent[], options: Omit<ReplayOptions, "fillModel"> = {},
): Promise<Record<FillModel, ReplayResult>> {
  const conservative = await replayEvents(events, { ...options, fillModel: "conservative" });
  const midpoint = await replayEvents(events, { ...options, fillModel: "midpoint-touch" });
  const queue = await replayEvents(events, { ...options, fillModel: "queue" });
  return { conservative, "midpoint-touch": midpoint, queue };
}
