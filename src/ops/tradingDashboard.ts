import type { AuditEvent, AuditRecorder } from "./recorder.js";
import type { HistoricalMarketEvent, HistoricalMarketEventType, MarketHistorySink } from "../history/types.js";
import { correctedProviderLatencyMs } from "../marketData/opraQuoteHealth.js";
import { isUnderlyingSymbol, UNDERLYING_SYMBOLS, type UnderlyingSymbol } from "../types.js";
import { parseOccSymbol } from "../options/occSymbol.js";
import { marketDate, zonedDateTimeToEpoch } from "../utils/time.js";
import {
  classifyOrderCardEntryQuality,
  compactOrderCardDynamics,
  sameMaterialOrderManagement,
  type DashboardOrderEntryQuality,
  type DashboardOrderCard,
  type DashboardOrderDynamicsUpdate,
  type DashboardOrderManagement,
  type DashboardOptionContinuation,
  type OrderCardPersistence,
} from "./orderCards.js";

export type {
  DashboardOrderCard,
  DashboardOrderDynamicsUpdate,
  DashboardOrderEntryQuality,
} from "./orderCards.js";

export interface DashboardSignal {
  id: string;
  underlying: UnderlyingSymbol;
  timestamp: number;
  direction: string;
  kind: string;
  regime: string;
  configVersion: string;
  projectedMoveBps?: number;
  candidate?: string;
  closestCandidate?: string;
  evaluatedContracts?: number;
  selectionScore?: number;
  delta?: number;
  costMarginBps?: number;
  requiredMoveBps?: number;
  decisionQuoteTimestamp?: number;
  decisionBid?: number;
  decisionAsk?: number;
  decisionMid?: number;
  decisionSpreadPct?: number;
  selectionAttempt?: number;
  retryWaitMs?: number;
  status: "FIRED" | "OPTION_RETRY_PENDING" | "NO_ELIGIBLE_OPTION" | "ORDER_SUBMITTED" | "ORDER_BLOCKED";
  riskStatus?: "ALLOWED" | "BLOCKED";
  riskReasons?: string[];
  brokerOrderId?: string;
  reasons: string[];
}

export interface DashboardOrder {
  clientOrderId: string;
  brokerOrderId?: string;
  signalId?: string;
  timestamp: number;
  updatedAt: number;
  purpose: "ENTRY" | "EXIT";
  symbol: string;
  side: string;
  quantity: number;
  initialLimitPrice: number;
  limitPrice: number;
  status: string;
  filledQuantity: number;
  averageFillPrice?: number;
  replacements: number;
  urgency?: number;
  actionTtlMs?: number;
  priceCollar?: number;
  marketable?: boolean;
  exitIntentId?: string;
  attempt?: number;
  triggers?: string[];
  firstFillTimestamp?: number;
  completedTimestamp?: number;
  fillPercentage?: number;
  firstFillLatencyMs?: number;
  completionLatencyMs?: number;
  priceImprovementBps?: number;
  exitReason?: string;
}

export interface DashboardTrade extends DashboardOrderManagement {
  id: string;
  signalId?: string;
  symbol: string;
  direction: string;
  entryTimestamp: number;
  exitTimestamp?: number;
  quantity: number;
  averageEntryPrice: number;
  averageExitPrice?: number;
  remainingQuantity: number;
  realizedPnl: number;
  currentBid?: number;
  currentAsk?: number;
  markPrice?: number;
  lastQuoteTimestamp?: number;
  unrealizedPnl?: number;
  unrealizedReturnPct?: number;
  stopPrice?: number;
  maxFavorableExcursionPct?: number;
  maxAdverseExcursionPct?: number;
  capturePct?: number;
  returnPct?: number;
  exitReason?: string;
  status: "OPEN" | "PARTIAL_EXIT" | "CLOSED";
}

export interface DashboardEntryQuality {
  signalId: string;
  underlying: UnderlyingSymbol;
  signalTimestamp: number;
  sessionBucket: string;
  symbol?: string;
  direction: string;
  kind: string;
  regime: string;
  projectedMoveBps?: number;
  status: "NO_OPTION" | "BLOCKED" | "WORKING" | "FILLED" | "OPEN" | "WIN" | "LOSS" | "FLAT";
  decisionBid?: number;
  decisionAsk?: number;
  decisionSpreadPct?: number;
  selectionScore?: number;
  costMarginBps?: number;
  orderTimestamp?: number;
  firstFillTimestamp?: number;
  signalToOrderMs?: number;
  orderToFirstFillMs?: number;
  signalToFirstFillMs?: number;
  quantity?: number;
  filledQuantity?: number;
  initialLimitPrice?: number;
  finalLimitPrice?: number;
  averageFillPrice?: number;
  entrySlippageBps?: number;
  priceImprovementBps?: number;
  replacements?: number;
  maxFavorableExcursionPct?: number;
  maxAdverseExcursionPct?: number;
  realizedPnl?: number;
  returnPct?: number;
  capturePct?: number;
  holdMs?: number;
  exitReason?: string;
}

export interface DashboardTuningSummary {
  signals: number;
  submitted: number;
  filled: number;
  closed: number;
  fillRate: number;
  replacementRate: number;
  avgSignalToOrderMs?: number;
  avgOrderToFirstFillMs?: number;
  avgSignalToFirstFillMs?: number;
  avgEntrySlippageBps?: number;
  avgDecisionSpreadPct?: number;
  avgMaxFavorableExcursionPct?: number;
  avgMaxAdverseExcursionPct?: number;
  avgCapturePct?: number;
}

export interface DashboardTuning {
  summary: DashboardTuningSummary;
  entries: DashboardEntryQuality[];
  falseNegativeSummary: DashboardFalseNegativeSummary;
  potentialMisses: DashboardPotentialMiss[];
  optionSelectionOpportunitySummary: DashboardOptionSelectionOpportunitySummary;
  optionSelectionOpportunities: DashboardOptionSelectionOpportunity[];
}

export interface DashboardOptionSelectionOpportunity {
  signalId: string;
  timestamp: number;
  underlying: UnderlyingSymbol;
  symbol?: string;
  direction: string;
  regime: string;
  status: "PENDING" | "PROFITABLE_MISS" | "CORRECT_REJECTION" | "NON_EXECUTABLE";
  horizonSec: number;
  decisionQuoteTimestamp?: number;
  decisionBid?: number;
  decisionAsk?: number;
  decisionBidSize?: number;
  decisionAskSize?: number;
  decisionProviderAgeMs?: number;
  freshnessThresholdMs?: number;
  forwardQuoteTimestamp?: number;
  forwardBid?: number;
  grossExecutablePnlPerContract?: number;
  grossExecutableReturnPct?: number;
  reasons: string[];
  diagnosticReasons: string[];
}

export interface DashboardOptionSelectionOpportunitySummary {
  rejectedSelections: number;
  pending: number;
  evaluated: number;
  profitableMisses: number;
  correctRejections: number;
  nonExecutable: number;
  profitableMissRate: number;
  horizonSec: number;
}

export interface DashboardPotentialMiss {
  id: string;
  timestamp: number;
  underlying?: string;
  direction: "BULLISH" | "BEARISH";
  regime: string;
  price: number;
  forwardPrice: number;
  forwardMoveBps: number;
  horizonSec: number;
  thresholdBps: number;
  reasons: string[];
  failedGates: string[];
}

export interface DashboardFalseNegativeSummary {
  evaluations: number;
  noSignalEvaluations: number;
  matureNoSignalEvaluations: number;
  potentialMisses: number;
  potentialMissRate: number;
  bullishPotentialMisses: number;
  bearishPotentialMisses: number;
  horizonSec: number;
  thresholdBps: number;
  gateBlocks: Array<{ reason: string; count: number }>;
}

export interface DashboardActiveOrder extends DashboardOrderManagement {
  id: string;
  symbol: string;
  direction?: string;
  stage: "ENTRY_WORKING" | "PARTIAL_ENTRY" | "POSITION_OPEN" | "EXIT_WORKING";
  quantity: number;
  remainingQuantity: number;
  entryPrice?: number;
  currentBid?: number;
  currentAsk?: number;
  markPrice?: number;
  realizedPnl: number;
  unrealizedPnl?: number;
  unrealizedReturnPct?: number;
  totalPnl?: number;
  stopPrice?: number;
  entryTimestamp?: number;
  elapsedMs?: number;
  lastQuoteTimestamp?: number;
  quoteAgeMs?: number;
  workingOrder?: {
    clientOrderId: string;
    brokerOrderId?: string;
    purpose: "ENTRY" | "EXIT";
    side: string;
    status: string;
    limitPrice: number;
    requestedQuantity: number;
    filledQuantity: number;
    replacements: number;
    urgency?: number;
    actionTtlMs?: number;
    priceCollar?: number;
    marketable?: boolean;
    exitIntentId?: string;
    attempt?: number;
    triggers?: string[];
  };
  updates?: DashboardOrderDynamicsUpdate[];
}

export interface DashboardDecision {
  id: string;
  timestamp: number;
  underlying?: string;
  stage: "ENTRY_EVALUATION" | "OPTION_SELECTION" | "RISK" | "ORDER_SUBMISSION" | "EXECUTION";
  outcome: string;
  signalId?: string;
  direction?: string;
  symbol?: string;
  regime?: string;
  price?: number;
  forwardPrice?: number;
  forwardMoveBps?: number;
  summary: string;
  reasons: string[];
  directions?: Array<{
    direction: string;
    passed: boolean;
    reasons: string[];
    votes: Array<{ name: string; passed: boolean; value: number; threshold: number }>;
    projectedMoveBps?: number;
  }>;
}

export interface DashboardLiveFeedEvent {
  id: number;
  type: HistoricalMarketEventType;
  channel: "SIP" | "OPRA" | "ALPACA_REST" | "ENGINE";
  symbol: string;
  providerTimestamp: number;
  receivedTimestamp: number;
  rawLatencyMs: number;
  latencyMs: number;
  marketDate: string;
  summary: string;
}

export interface DashboardLiveData {
  persistenceEnabled: boolean;
  quoteSampleIntervalMs: number;
  retentionDays: number;
  marketDataClockOffsetMs: number;
  uptimeMs: number;
  totalEvents: number;
  eventCounts: Record<HistoricalMarketEventType, number>;
  lastEventReceivedAt?: number;
  lastProviderTimestamp?: number;
  lastEventAgeMs?: number;
  recentEvents: DashboardLiveFeedEvent[];
}

export interface DashboardPerformance {
  signalsFired: number;
  optionsSelected: number;
  optionSelectionByConfig: Array<{
    configVersion: string;
    signals: number;
    selected: number;
    pending: number;
    selectionRate: number;
    latestSignalTimestamp: number;
  }>;
  riskAllowed: number;
  riskBlocked: number;
  entryOrders: number;
  exitOrders: number;
  filledEntryOrders: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  averageTradePnl: number;
  profitFactor: number | null;
  bestTradePnl: number | null;
  worstTradePnl: number | null;
}

export interface TradingDashboardView {
  performance: DashboardPerformance;
  activeOrders: DashboardActiveOrder[];
  orderCards: DashboardOrderCard[];
  decisions: DashboardDecision[];
  liveData: DashboardLiveData;
  tuning: DashboardTuning;
  signals: DashboardSignal[];
  orders: DashboardOrder[];
  trades: DashboardTrade[];
}

export interface TradingDashboardSnapshot extends TradingDashboardView {
  startedAt: number;
  generatedAt: number;
  displayDate: string;
  displayTimeZone: string;
  nextDisplayRolloverAt: number;
  lastMarketDate?: string;
  lastExecutionError?: string;
  underlyingViews: Record<UnderlyingSymbol, TradingDashboardView>;
}

interface MutableTrade extends Omit<DashboardTrade,
  "remainingQuantity" | "currentBid" | "currentAsk" | "markPrice" | "lastQuoteTimestamp" |
  "unrealizedPnl" | "unrealizedReturnPct" | "maxFavorableExcursionPct" |
  "maxAdverseExcursionPct" | "capturePct"> {
  exitedQuantity: number;
  exitNotional: number;
  entryOrderId?: string;
}

interface DashboardOptionQuote {
  timestamp: number;
  bidPrice: number;
  askPrice: number;
}

interface UnderlyingEntryStats {
  evaluations: number;
  noSignalEvaluations: number;
  matureNoSignalEvaluations: number;
  gateBlocks: Map<string, number>;
}

const MISSED_ENTRY_HORIZON_SEC = 5;
const MISSED_ENTRY_MOVE_THRESHOLD_BPS = 2;
const FORWARD_SAMPLE_TOLERANCE_MS = 2_000;
const MISSED_ENTRY_CLUSTER_MS = 15_000;
const OPTION_SELECTION_OUTCOME_HORIZON_SEC = 30;
const OPTION_SELECTION_OUTCOME_TOLERANCE_MS = 5_000;
export const DASHBOARD_DISPLAY_TIME_ZONE = "America/Los_Angeles";
export const DASHBOARD_DISPLAY_ROLLOVER = "22:00:00";

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, day! + days));
  return shifted.toISOString().slice(0, 10);
}

/** Dashboard dates run from 22:00 Pacific through 21:59:59.999 the following day. */
export function dashboardDisplayDate(timestamp: number): string {
  const pacificDate = marketDate(timestamp, DASHBOARD_DISPLAY_TIME_ZONE);
  const rollover = zonedDateTimeToEpoch(
    pacificDate,
    DASHBOARD_DISPLAY_ROLLOVER,
    DASHBOARD_DISPLAY_TIME_ZONE,
  );
  return timestamp >= rollover ? addCalendarDays(pacificDate, 1) : pacificDate;
}

export function nextDashboardDisplayRollover(timestamp: number): number {
  const pacificDate = marketDate(timestamp, DASHBOARD_DISPLAY_TIME_ZONE);
  const todayRollover = zonedDateTimeToEpoch(
    pacificDate,
    DASHBOARD_DISPLAY_ROLLOVER,
    DASHBOARD_DISPLAY_TIME_ZONE,
  );
  return timestamp < todayRollover
    ? todayRollover
    : zonedDateTimeToEpoch(
      addCalendarDays(pacificDate, 1),
      DASHBOARD_DISPLAY_ROLLOVER,
      DASHBOARD_DISPLAY_TIME_ZONE,
    );
}

function orderCardDisplayTimestamp(card: DashboardOrderCard): number | undefined {
  return card.entryTimestamp ?? card.updates[0]?.timestamp ?? card.exitTimestamp;
}

function optionSelectionOpportunitySummary(
  opportunities: readonly DashboardOptionSelectionOpportunity[],
): DashboardOptionSelectionOpportunitySummary {
  const profitableMisses = opportunities.filter((item) => item.status === "PROFITABLE_MISS").length;
  const correctRejections = opportunities.filter((item) => item.status === "CORRECT_REJECTION").length;
  const evaluated = profitableMisses + correctRejections;
  return {
    rejectedSelections: opportunities.length,
    pending: opportunities.filter((item) => item.status === "PENDING").length,
    evaluated,
    profitableMisses,
    correctRejections,
    nonExecutable: opportunities.filter((item) => item.status === "NON_EXECUTABLE").length,
    profitableMissRate: evaluated > 0 ? profitableMisses / evaluated : 0,
    horizonSec: OPTION_SELECTION_OUTCOME_HORIZON_SEC,
  };
}

/** Reconstructible read model derived only from durable execution audit events. */
export class TradingDashboardStore implements AuditRecorder, MarketHistorySink {
  readonly #startedAt: number;
  readonly #now: () => number;
  readonly #persistenceEnabled: boolean;
  readonly #quoteSampleIntervalMs: number;
  readonly #retentionDays: number;
  readonly #marketDataClockOffsetMs: number;
  readonly #signals = new Map<string, DashboardSignal>();
  readonly #orders = new Map<string, DashboardOrder>();
  readonly #orderCards = new Map<string, DashboardOrderCard>();
  readonly #openTrades = new Map<string, MutableTrade>();
  readonly #closedTrades: MutableTrade[] = [];
  readonly #latestOptionQuotes = new Map<string, DashboardOptionQuote>();
  readonly #marketEventCounts = emptyMarketEventCounts();
  readonly #marketEventCountsByUnderlying = new Map<UnderlyingSymbol, Record<HistoricalMarketEventType, number>>();
  readonly #recentMarketEvents: DashboardLiveFeedEvent[] = [];
  readonly #lastFeedSampleAt = new Map<string, number>();
  readonly #decisions: DashboardDecision[] = [];
  readonly #potentialMisses: DashboardPotentialMiss[] = [];
  readonly #optionSelectionOpportunities = new Map<string, DashboardOptionSelectionOpportunity>();
  readonly #entryGateBlocks = new Map<string, number>();
  readonly #entryStatsByUnderlying = new Map<UnderlyingSymbol, UnderlyingEntryStats>();
  readonly #lastMarketEventReceivedAtByUnderlying = new Map<UnderlyingSymbol, number>();
  readonly #lastProviderTimestampByUnderlying = new Map<UnderlyingSymbol, number>();
  #lastMarketEventReceivedAt: number | undefined;
  #lastProviderTimestamp: number | undefined;
  #feedSequence = 0;
  #decisionSequence = 0;
  #entryEvaluationCount = 0;
  #noSignalEvaluationCount = 0;
  #matureNoSignalEvaluationCount = 0;
  #lastMarketDate: string | undefined;
  #lastExecutionError: string | undefined;
  #displayDate: string;
  #orderCardPersistence: OrderCardPersistence | undefined;
  #orderCardPersistenceHealthy = true;

  constructor(
    startedAt = Date.now(),
    persistenceEnabled = false,
    quoteSampleIntervalMs = 0,
    retentionDays = 0,
    now: () => number = Date.now,
    marketDataClockOffsetMs = 0,
  ) {
    this.#startedAt = startedAt;
    this.#now = now;
    this.#persistenceEnabled = persistenceEnabled;
    this.#quoteSampleIntervalMs = quoteSampleIntervalMs;
    this.#retentionDays = retentionDays;
    this.#marketDataClockOffsetMs = marketDataClockOffsetMs;
    this.#displayDate = dashboardDisplayDate(now());
  }

  restoreOrderCards(cards: readonly DashboardOrderCard[]): void {
    this.#synchronizeDisplayWindow();
    for (const card of cards) {
      const timestamp = orderCardDisplayTimestamp(card);
      if (timestamp === undefined || dashboardDisplayDate(timestamp) !== this.#displayDate) continue;
      this.#orderCards.set(card.id, compactOrderCardDynamics(card));
    }
  }

  setOrderCardPersistence(persistence: OrderCardPersistence): void {
    this.#orderCardPersistence = persistence;
  }

  record(event: AuditEvent): void | Promise<void> {
    this.#synchronizeDisplayWindow();
    if (dashboardDisplayDate(event.timestamp) !== this.#displayDate) return;
    if (event.marketDate) this.#lastMarketDate = event.marketDate;
    if (event.type === "live_signal_selection") this.#recordSignal(event);
    else if (event.type === "risk_decision") this.#recordRiskDecision(event);
    else if (event.type === "paper_order_submission_result") this.#recordSubmissionResult(event);
    else if (event.type === "broker_order_request") this.#recordOrderRequest(event);
    else if (event.type === "broker_order_state") this.#recordOrderState(event);
    else if (event.type === "broker_order_replaced") this.#recordOrderReplacement(event);
    else if (event.type === "entry_fill") this.#recordEntryFill(event);
    else if (event.type === "order_management_state") this.#recordOrderManagementState(event);
    else if (event.type === "exit_fill") this.#recordExitFill(event);
    else if (event.type === "execution_halted") {
      this.#lastExecutionError = stringValue(event.data.reason) ?? "Execution halted";
    }
    if (isDecisionEvent(event.type)) this.#recordDecision(event);
    const completedCards = this.#refreshProjectedOrderCards(
      event.timestamp,
      undefined,
      event.type === "order_management_state" ? "CONTROLLER" : "STATUS",
    );
    if (completedCards.length > 0 && this.#orderCardPersistence) {
      return Promise.all(completedCards.map((card) => this.#orderCardPersistence!.saveOrderCard(cloneOrderCard(card))))
        .then(() => { this.#orderCardPersistenceHealthy = true; })
        .catch((error: unknown) => {
          this.#orderCardPersistenceHealthy = false;
          throw error;
        });
    }
  }

  recordMarketEvent(event: HistoricalMarketEvent): void {
    this.recordMarketEvents([event]);
  }

  recordMarketEvents(events: readonly HistoricalMarketEvent[]): void {
    if (events.length === 0) return;
    this.#synchronizeDisplayWindow();
    const firstDisplayDate = dashboardDisplayDate(events[0]!.receivedTimestamp);
    const receivedDisplayDate = dashboardDisplayDate(events.at(-1)!.receivedTimestamp);
    if (firstDisplayDate === receivedDisplayDate) {
      if (receivedDisplayDate !== this.#displayDate) return;
      for (const event of events) this.#recordCurrentDisplayMarketEvent(event);
      return;
    }
    for (const event of events) {
      if (dashboardDisplayDate(event.receivedTimestamp) === this.#displayDate) {
        this.#recordCurrentDisplayMarketEvent(event);
      }
    }
  }

  #recordCurrentDisplayMarketEvent(event: HistoricalMarketEvent): void {
    const underlying = dashboardUnderlyingFromSymbol(event.symbol) ??
      dashboardUnderlying(stringValue(event.data.symbol));
    this.#lastMarketDate = event.marketDate;
    this.#marketEventCounts[event.type] += 1;
    this.#lastMarketEventReceivedAt = Math.max(this.#lastMarketEventReceivedAt ?? -Infinity, event.receivedTimestamp);
    this.#lastProviderTimestamp = Math.max(this.#lastProviderTimestamp ?? -Infinity, event.providerTimestamp);
    if (underlying) {
      const counts = this.#marketEventCountsByUnderlying.get(underlying) ?? emptyMarketEventCounts();
      counts[event.type] += 1;
      this.#marketEventCountsByUnderlying.set(underlying, counts);
      this.#lastMarketEventReceivedAtByUnderlying.set(
        underlying,
        Math.max(this.#lastMarketEventReceivedAtByUnderlying.get(underlying) ?? -Infinity, event.receivedTimestamp),
      );
      this.#lastProviderTimestampByUnderlying.set(
        underlying,
        Math.max(this.#lastProviderTimestampByUnderlying.get(underlying) ?? -Infinity, event.providerTimestamp),
      );
    }

    if (event.type === "option_quote") {
      const timestamp = numberValue(event.data.timestamp) ?? event.providerTimestamp;
      const bidPrice = numberValue(event.data.bidPrice);
      const askPrice = numberValue(event.data.askPrice);
      if (bidPrice !== undefined && askPrice !== undefined && bidPrice >= 0 && askPrice >= bidPrice) {
        const previous = this.#latestOptionQuotes.get(event.symbol);
        if (!previous || timestamp >= previous.timestamp) {
          this.#latestOptionQuotes.set(event.symbol, { timestamp, bidPrice, askPrice });
        }
        this.#refreshProjectedOrderCards(timestamp, event.symbol, "PNL");
        this.#updateOptionSelectionOpportunities(event, bidPrice);
        this.#pruneMap(this.#latestOptionQuotes, 5_000);
      }
    }

    const sampleInterval = [
      "stock_quote", "stock_trade", "option_quote", "option_trade", "option_aggregate",
    ].includes(event.type) ? 250 : 0;
    const sampleKey = `${underlying ?? "UNKNOWN"}:${event.type}`;
    const lastSample = this.#lastFeedSampleAt.get(sampleKey);
    if (lastSample === undefined || event.receivedTimestamp - lastSample >= sampleInterval) {
      this.#lastFeedSampleAt.set(sampleKey, event.receivedTimestamp);
      this.#recentMarketEvents.unshift({
        id: ++this.#feedSequence,
        type: event.type,
        channel: marketEventChannel(event.type),
        symbol: event.symbol,
        providerTimestamp: event.providerTimestamp,
        receivedTimestamp: event.receivedTimestamp,
        rawLatencyMs: event.receivedTimestamp - event.providerTimestamp,
        latencyMs: correctedProviderLatencyMs(
          event.receivedTimestamp,
          event.providerTimestamp,
          this.#marketDataClockOffsetMs,
        ),
        marketDate: event.marketDate,
        summary: marketEventSummary(event),
      });
      if (this.#recentMarketEvents.length > 1_000) this.#recentMarketEvents.length = 1_000;
    }
  }

  healthy(): boolean { return this.#orderCardPersistenceHealthy; }

  snapshot(): TradingDashboardSnapshot {
    const generatedAt = this.#now();
    this.#synchronizeDisplayWindow(generatedAt);
    this.#refreshProjectedOrderCards(generatedAt);
    const aggregate = this.#buildView(generatedAt);
    return {
      startedAt: this.#startedAt,
      generatedAt,
      displayDate: this.#displayDate,
      displayTimeZone: DASHBOARD_DISPLAY_TIME_ZONE,
      nextDisplayRolloverAt: nextDashboardDisplayRollover(generatedAt),
      ...(this.#lastMarketDate ? { lastMarketDate: this.#lastMarketDate } : {}),
      ...(this.#lastExecutionError ? { lastExecutionError: this.#lastExecutionError } : {}),
      ...aggregate,
      underlyingViews: Object.fromEntries(UNDERLYING_SYMBOLS.map((underlying) => [
        underlying, this.#buildView(generatedAt, underlying),
      ])) as Record<UnderlyingSymbol, TradingDashboardView>,
    };
  }

  #buildView(generatedAt: number, underlying?: UnderlyingSymbol): TradingDashboardView {
    const matchesSymbol = (symbol: string): boolean =>
      underlying === undefined || dashboardUnderlyingFromSymbol(symbol) === underlying;
    const closed = this.#closedTrades.filter((trade) => matchesSymbol(trade.symbol));
    const openTrades = [...this.#openTrades.values()].filter((trade) => matchesSymbol(trade.symbol));
    const allTrades = [...closed, ...openTrades];
    const realizedPnl = allTrades.reduce((sum, trade) => sum + trade.realizedPnl, 0);
    const wins = closed.filter((trade) => trade.realizedPnl > 0).length;
    const losses = closed.filter((trade) => trade.realizedPnl < 0).length;
    const grossProfit = closed.reduce((sum, trade) => sum + Math.max(0, trade.realizedPnl), 0);
    const grossLoss = Math.abs(closed.reduce((sum, trade) => sum + Math.min(0, trade.realizedPnl), 0));
    const pnls = closed.map((trade) => trade.realizedPnl);
    const orders = [...this.#orders.values()].filter((order) => matchesSymbol(order.symbol));
    const signals = [...this.#signals.values()].filter((signal) =>
      underlying === undefined || signal.underlying === underlying);
    const optionsSelected = signals.filter((signal) => signal.candidate !== undefined).length;
    const optionSelectionByConfig = [...signals.reduce((groups, signal) => {
      const group = groups.get(signal.configVersion) ?? {
        configVersion: signal.configVersion,
        signals: 0,
        selected: 0,
        pending: 0,
        selectionRate: 0,
        latestSignalTimestamp: -Infinity,
      };
      group.signals += 1;
      if (signal.candidate !== undefined) group.selected += 1;
      if (signal.status === "OPTION_RETRY_PENDING") group.pending += 1;
      group.latestSignalTimestamp = Math.max(group.latestSignalTimestamp, signal.timestamp);
      groups.set(signal.configVersion, group);
      return groups;
    }, new Map<string, DashboardPerformance["optionSelectionByConfig"][number]>()).values()]
      .map((group) => ({
        ...group,
        selectionRate: group.signals > 0 ? group.selected / group.signals : 0,
      }))
      .sort((left, right) => right.latestSignalTimestamp - left.latestSignalTimestamp);
    const riskAllowed = signals.filter((signal) => signal.riskStatus === "ALLOWED").length;
    const riskBlocked = signals.filter((signal) => signal.riskStatus === "BLOCKED").length;
    const activeOrders = this.#activeOrders(generatedAt, orders)
      .filter((order) => matchesSymbol(order.symbol))
      .map((order) => ({
        ...order,
        ...(this.#orderCards.get(order.id)
          ? { updates: this.#orderCards.get(order.id)!.updates.map((update) => ({ ...update })) } : {}),
      }));
    const unrealizedPnl = activeOrders.reduce((sum, order) => sum + (order.unrealizedPnl ?? 0), 0);
    const orderCards = [...this.#orderCards.values()]
      .filter((card) => matchesSymbol(card.symbol))
      .sort((a, b) =>
        Number(b.active) - Number(a.active) ||
        (b.exitTimestamp ?? b.entryTimestamp ?? b.updates.at(-1)?.timestamp ?? 0) -
          (a.exitTimestamp ?? a.entryTimestamp ?? a.updates.at(-1)?.timestamp ?? 0))
      .slice(0, 250)
      .map(cloneOrderCard);
    const publicOrders = orders.slice(-250).reverse().map((order) => this.#publicOrder(order, generatedAt));
    const publicTrades = allTrades.slice(-250).reverse().map((trade) => this.#publicTrade(trade));
    const entryQuality = this.#entryQuality(orders, allTrades, signals);
    const eventCounts = underlying
      ? { ...(this.#marketEventCountsByUnderlying.get(underlying) ?? emptyMarketEventCounts()) }
      : { ...this.#marketEventCounts };
    const lastMarketEventReceivedAt = underlying
      ? this.#lastMarketEventReceivedAtByUnderlying.get(underlying)
      : this.#lastMarketEventReceivedAt;
    const lastProviderTimestamp = underlying
      ? this.#lastProviderTimestampByUnderlying.get(underlying)
      : this.#lastProviderTimestamp;
    const decisions = this.#decisions.filter((decision) =>
      underlying === undefined || dashboardDecisionUnderlying(decision) === underlying);
    const potentialMisses = this.#potentialMisses.filter((miss) =>
      underlying === undefined || (miss.underlying ?? "SPY") === underlying);
    const optionSelectionOpportunities = [...this.#optionSelectionOpportunities.values()]
      .filter((item) => underlying === undefined || item.underlying === underlying)
      .sort((left, right) => right.timestamp - left.timestamp);
    return {
      performance: {
        signalsFired: signals.length,
        optionsSelected,
        optionSelectionByConfig,
        riskAllowed,
        riskBlocked,
        entryOrders: orders.filter((order) => order.purpose === "ENTRY").length,
        exitOrders: orders.filter((order) => order.purpose === "EXIT").length,
        filledEntryOrders: orders.filter((order) => order.purpose === "ENTRY" && order.filledQuantity > 0).length,
        closedTrades: closed.length,
        openTrades: openTrades.length,
        wins,
        losses,
        winRate: closed.length > 0 ? wins / closed.length : 0,
        realizedPnl,
        unrealizedPnl,
        totalPnl: realizedPnl + unrealizedPnl,
        averageTradePnl: closed.length > 0 ? closed.reduce((sum, trade) => sum + trade.realizedPnl, 0) / closed.length : 0,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
        bestTradePnl: pnls.length > 0 ? Math.max(...pnls) : null,
        worstTradePnl: pnls.length > 0 ? Math.min(...pnls) : null,
      },
      activeOrders,
      orderCards,
      decisions: decisions.slice(0, 100).map(publicDecision),
      tuning: {
        summary: tuningSummary(entryQuality),
        entries: entryQuality,
        falseNegativeSummary: this.#falseNegativeSummary(underlying),
        potentialMisses: potentialMisses.slice(0, 250).map((miss) => ({
          ...miss, reasons: [...miss.reasons], failedGates: [...miss.failedGates],
        })),
        optionSelectionOpportunitySummary: optionSelectionOpportunitySummary(optionSelectionOpportunities),
        optionSelectionOpportunities: optionSelectionOpportunities.slice(0, 250).map((item) => ({
          ...item,
          reasons: [...item.reasons],
          diagnosticReasons: [...item.diagnosticReasons],
        })),
      },
      liveData: {
        persistenceEnabled: this.#persistenceEnabled,
        quoteSampleIntervalMs: this.#quoteSampleIntervalMs,
        retentionDays: this.#retentionDays,
        marketDataClockOffsetMs: this.#marketDataClockOffsetMs,
        uptimeMs: Math.max(0, generatedAt - this.#startedAt),
        totalEvents: Object.values(eventCounts).reduce((sum, count) => sum + count, 0),
        eventCounts,
        ...(lastMarketEventReceivedAt !== undefined ? {
          lastEventReceivedAt: lastMarketEventReceivedAt,
          lastEventAgeMs: Math.max(0, generatedAt - lastMarketEventReceivedAt),
        } : {}),
        ...(lastProviderTimestamp !== undefined ? { lastProviderTimestamp } : {}),
        recentEvents: this.#recentMarketEvents
          .filter((event) => underlying === undefined || dashboardUnderlyingFromSymbol(event.symbol) === underlying)
          .slice(0, 100)
          .map((event) => ({ ...event })),
      },
      signals: signals.slice(-250).reverse().map((signal) => ({
        ...signal,
        reasons: [...signal.reasons],
        ...(signal.riskReasons ? { riskReasons: [...signal.riskReasons] } : {}),
      })),
      orders: publicOrders,
      trades: publicTrades,
    };
  }

  #synchronizeDisplayWindow(timestamp = this.#now()): void {
    const displayDate = dashboardDisplayDate(timestamp);
    if (displayDate === this.#displayDate) return;
    this.#displayDate = displayDate;
    this.#signals.clear();
    this.#orders.clear();
    this.#openTrades.clear();
    this.#closedTrades.length = 0;
    this.#orderCards.clear();
    this.#latestOptionQuotes.clear();
    Object.assign(this.#marketEventCounts, emptyMarketEventCounts());
    this.#marketEventCountsByUnderlying.clear();
    this.#recentMarketEvents.length = 0;
    this.#lastFeedSampleAt.clear();
    this.#decisions.length = 0;
    this.#potentialMisses.length = 0;
    this.#optionSelectionOpportunities.clear();
    this.#entryGateBlocks.clear();
    this.#entryStatsByUnderlying.clear();
    this.#lastMarketEventReceivedAtByUnderlying.clear();
    this.#lastProviderTimestampByUnderlying.clear();
    this.#lastMarketEventReceivedAt = undefined;
    this.#lastProviderTimestamp = undefined;
    this.#feedSequence = 0;
    this.#decisionSequence = 0;
    this.#entryEvaluationCount = 0;
    this.#noSignalEvaluationCount = 0;
    this.#matureNoSignalEvaluationCount = 0;
    this.#lastMarketDate = undefined;
    this.#lastExecutionError = undefined;
  }

  #recordDecision(event: AuditEvent): void {
    const signalId = stringValue(event.data.signalId);
    const direction = stringValue(event.data.direction);
    const symbol = stringValue(event.data.symbol) ?? stringValue(event.data.candidate);
    let stage: DashboardDecision["stage"] = "EXECUTION";
    let outcome = event.type.toUpperCase();
    let summary = event.type.replaceAll("_", " ");
    let reasons = stringArray(event.data.reasons);
    let directions: DashboardDecision["directions"] | undefined;
    let regime: string | undefined;
    let price: number | undefined;
    let underlying = stringValue(event.data.underlying) ?? "SPY";

    if (event.type === "live_entry_evaluation") {
      stage = "ENTRY_EVALUATION";
      outcome = stringValue(event.data.decision) ?? "UNKNOWN";
      regime = stringValue(event.data.regime) ?? "UNKNOWN";
      const feature = recordValue(event.data.feature);
      underlying = stringValue(feature.symbol) ?? underlying;
      price = numberValue(feature.price);
      if (price !== undefined && underlying) {
        this.#updateForwardEntryEvaluations(event.timestamp, price, underlying);
      }
      this.#entryEvaluationCount += 1;
      if (outcome === "NO_SIGNAL") this.#noSignalEvaluationCount += 1;
      const underlyingSymbol = dashboardUnderlying(underlying) ?? "SPY";
      const underlyingStats = this.#underlyingEntryStats(underlyingSymbol);
      underlyingStats.evaluations += 1;
      if (outcome === "NO_SIGNAL") underlyingStats.noSignalEvaluations += 1;
      if (outcome === "NO_SIGNAL" || outcome === "SKIPPED") {
        for (const reason of reasons) {
          this.#entryGateBlocks.set(reason, (this.#entryGateBlocks.get(reason) ?? 0) + 1);
          underlyingStats.gateBlocks.set(reason, (underlyingStats.gateBlocks.get(reason) ?? 0) + 1);
        }
      }
      summary = `${regime} · ${stringValue(feature.symbol) ?? stringValue(event.data.underlying) ?? "SPY"} ` +
        `${formatFeedNumber(numberValue(feature.price))}`;
      directions = decisionDirections(event.data.directions);
    } else if (event.type === "live_signal_selection") {
      stage = "OPTION_SELECTION";
      outcome = stringValue(event.data.selectionStatus) ?? (symbol ? "SELECTED" : "NO_ELIGIBLE_OPTION");
      const count = numberValue(event.data.evaluatedContracts) ?? 0;
      const relevant = numberValue(event.data.relevantContracts) ?? count;
      const closest = recordValue(event.data.closestCandidate);
      const closestSymbol = stringValue(closest.symbol);
      summary = symbol
        ? `${symbol} selected from ${relevant} relevant contracts`
        : outcome === "RETRYING"
          ? `Retrying transient quotes for ${closestSymbol ?? `${relevant} relevant contracts`}`
          : `No option selected from ${relevant} relevant contracts`;
      reasons = stringArray(event.data.selectionReasons);
      if (reasons.length === 0) reasons = reasonCounts(event.data.rejectionCounts);
    } else if (event.type === "late_bullish_grind_confirmation") {
      stage = "ENTRY_EVALUATION";
      outcome = stringValue(event.data.decision) ?? "PENDING";
      const elapsedSec = numberValue(event.data.elapsedSec);
      const bidImprovement = numberValue(event.data.bidImprovement);
      summary = `${symbol ?? "Option"} bid confirmation` +
        `${elapsedSec === undefined ? "" : ` · ${elapsedSec.toFixed(1)}s`}` +
        `${bidImprovement === undefined ? "" : ` · ${bidImprovement >= 0 ? "+" : ""}${bidImprovement.toFixed(3)}`}`;
    } else if (event.type === "risk_decision") {
      stage = "RISK";
      const risk = recordValue(event.data.risk);
      outcome = risk.allowed === true ? "ALLOWED" : "BLOCKED";
      summary = risk.allowed === true
        ? `${numberValue(risk.quantity) ?? 0} contract(s) · hard stop ${formatFeedNumber(numberValue(risk.stopPrice))}`
        : "Risk manager blocked entry";
      reasons = stringArray(risk.reasons);
    } else if (event.type === "entry_blocked") {
      stage = "RISK";
      outcome = "BLOCKED";
      summary = "Entry safety validation blocked submission";
    } else if (event.type === "paper_order_submission_result") {
      stage = "ORDER_SUBMISSION";
      outcome = event.data.submitted === true ? "SUBMITTED" : "BLOCKED";
      summary = event.data.submitted === true ? `${symbol ?? "Option"} sent to paper broker` : "Order was not submitted";
    } else if (event.type === "broker_order_request") {
      stage = "ORDER_SUBMISSION";
      outcome = "REQUESTED";
      const order = recordValue(event.data.order);
      summary = `${stringValue(event.data.purpose) ?? "ORDER"} ${stringValue(order.side) ?? ""} ${numberValue(order.requestedQuantity) ?? 0} ${stringValue(order.symbol) ?? ""}`.trim();
    } else if (event.type === "broker_order_state") {
      const broker = recordValue(event.data.broker);
      outcome = stringValue(broker.status)?.toUpperCase() ?? "UPDATED";
      summary = `${stringValue(event.data.purpose) ?? "ORDER"} · ${numberValue(broker.filledQuantity) ?? 0} filled`;
    }

    this.#decisions.unshift({
      id: `decision-${event.timestamp}-${++this.#decisionSequence}`,
      timestamp: event.timestamp,
      ...(underlying ? { underlying } : {}),
      stage,
      outcome,
      ...(signalId ? { signalId } : {}),
      ...(direction ? { direction } : {}),
      ...(symbol ? { symbol } : {}),
      ...(regime ? { regime } : {}),
      ...(price !== undefined ? { price } : {}),
      summary,
      reasons,
      ...(directions ? { directions } : {}),
    });
    if (this.#decisions.length > 1_000) this.#decisions.length = 1_000;
  }

  #updateForwardEntryEvaluations(timestamp: number, forwardPrice: number, underlying: string): void {
    const horizonMs = MISSED_ENTRY_HORIZON_SEC * 1_000;
    for (const decision of this.#decisions) {
      if (decision.stage !== "ENTRY_EVALUATION" || decision.price === undefined ||
          decision.forwardMoveBps !== undefined || decision.underlying !== underlying) continue;
      const elapsed = timestamp - decision.timestamp;
      if (elapsed < horizonMs) continue;
      if (elapsed > horizonMs + FORWARD_SAMPLE_TOLERANCE_MS) continue;
      const forwardMoveBps = 10_000 * (forwardPrice - decision.price) / decision.price;
      decision.forwardPrice = forwardPrice;
      decision.forwardMoveBps = forwardMoveBps;
      if (decision.outcome !== "NO_SIGNAL") continue;
      this.#matureNoSignalEvaluationCount += 1;
      const underlyingSymbol = dashboardUnderlying(underlying) ?? "SPY";
      this.#underlyingEntryStats(underlyingSymbol).matureNoSignalEvaluations += 1;
      if (!decision.reasons.includes("NO_DIRECTION_PASSED") ||
          Math.abs(forwardMoveBps) < MISSED_ENTRY_MOVE_THRESHOLD_BPS) continue;
      const direction: DashboardPotentialMiss["direction"] = forwardMoveBps > 0 ? "BULLISH" : "BEARISH";
      if (this.#potentialMisses.some((miss) => miss.underlying === underlying && miss.direction === direction &&
          Math.abs(miss.timestamp - decision.timestamp) < MISSED_ENTRY_CLUSTER_MS)) continue;
      const directionDecision = decision.directions?.find((item) => item.direction === direction);
      const failedVotes = directionDecision?.votes.filter((vote) => !vote.passed).map((vote) =>
        `${vote.name} ${vote.value.toFixed(3)} vs ${vote.threshold.toFixed(3)}`) ?? [];
      this.#potentialMisses.unshift({
        id: `potential-miss-${decision.id}`,
        timestamp: decision.timestamp,
        underlying,
        direction,
        regime: decision.regime ?? "UNKNOWN",
        price: decision.price,
        forwardPrice,
        forwardMoveBps,
        horizonSec: MISSED_ENTRY_HORIZON_SEC,
        thresholdBps: MISSED_ENTRY_MOVE_THRESHOLD_BPS,
        reasons: [...decision.reasons],
        failedGates: [...new Set([...(directionDecision?.reasons ?? []), ...failedVotes])],
      });
      if (this.#potentialMisses.length > 2_000) this.#potentialMisses.length = 2_000;
    }
  }

  #falseNegativeSummary(underlying?: UnderlyingSymbol): DashboardFalseNegativeSummary {
    const misses = underlying
      ? this.#potentialMisses.filter((miss) => (miss.underlying ?? "SPY") === underlying)
      : this.#potentialMisses;
    const stats = underlying ? this.#entryStatsByUnderlying.get(underlying) : undefined;
    const evaluations = stats?.evaluations ?? (underlying ? 0 : this.#entryEvaluationCount);
    const noSignalEvaluations = stats?.noSignalEvaluations ?? (underlying ? 0 : this.#noSignalEvaluationCount);
    const matureNoSignalEvaluations = stats?.matureNoSignalEvaluations ??
      (underlying ? 0 : this.#matureNoSignalEvaluationCount);
    const gateBlocks = stats?.gateBlocks ?? this.#entryGateBlocks;
    const potentialMisses = misses.length;
    return {
      evaluations,
      noSignalEvaluations,
      matureNoSignalEvaluations,
      potentialMisses,
      potentialMissRate: matureNoSignalEvaluations > 0 ? potentialMisses / matureNoSignalEvaluations : 0,
      bullishPotentialMisses: misses.filter((miss) => miss.direction === "BULLISH").length,
      bearishPotentialMisses: misses.filter((miss) => miss.direction === "BEARISH").length,
      horizonSec: MISSED_ENTRY_HORIZON_SEC,
      thresholdBps: MISSED_ENTRY_MOVE_THRESHOLD_BPS,
      gateBlocks: [...gateBlocks.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    };
  }

  #underlyingEntryStats(underlying: UnderlyingSymbol): UnderlyingEntryStats {
    const existing = this.#entryStatsByUnderlying.get(underlying);
    if (existing) return existing;
    const created: UnderlyingEntryStats = {
      evaluations: 0,
      noSignalEvaluations: 0,
      matureNoSignalEvaluations: 0,
      gateBlocks: new Map(),
    };
    this.#entryStatsByUnderlying.set(underlying, created);
    return created;
  }

  #activeOrders(generatedAt: number, orders: DashboardOrder[]): DashboardActiveOrder[] {
    const workingOrders = orders.filter(isWorkingOrder);
    const representedOrders = new Set<string>();
    const cards: DashboardActiveOrder[] = [];

    for (const trade of this.#openTrades.values()) {
      const workingOrder = [...workingOrders].reverse().find((order) => order.symbol === trade.symbol);
      if (workingOrder) representedOrders.add(workingOrder.clientOrderId);
      const remainingQuantity = Math.max(0, trade.quantity - trade.exitedQuantity);
      const quote = this.#latestOptionQuotes.get(trade.symbol);
      const markPrice = quote?.bidPrice;
      const unrealizedPnl = markPrice === undefined
        ? undefined : 100 * remainingQuantity * (markPrice - trade.averageEntryPrice);
      const openCost = 100 * remainingQuantity * trade.averageEntryPrice;
      const unrealizedReturnPct = unrealizedPnl === undefined || openCost <= 0
        ? undefined : 100 * unrealizedPnl / openCost;
      cards.push({
        id: trade.entryOrderId ?? trade.id,
        symbol: trade.symbol,
        direction: trade.direction,
        ...copyOrderManagement(trade),
        lifecycle: workingOrder?.purpose === "EXIT"
          ? "EXIT_PENDING"
          : workingOrder?.purpose === "ENTRY"
            ? "ENTRY_PENDING"
            : trade.lifecycle ?? trade.tradeState ?? "OPEN_UNPROTECTED",
        stage: workingOrder?.purpose === "EXIT" ? "EXIT_WORKING"
          : workingOrder?.purpose === "ENTRY" ? "PARTIAL_ENTRY" : "POSITION_OPEN",
        quantity: trade.quantity,
        remainingQuantity,
        entryPrice: trade.averageEntryPrice,
        ...(quote ? {
          currentBid: quote.bidPrice,
          currentAsk: quote.askPrice,
          markPrice: quote.bidPrice,
          lastQuoteTimestamp: quote.timestamp,
          quoteAgeMs: Math.max(0, generatedAt - quote.timestamp),
        } : {}),
        realizedPnl: trade.realizedPnl,
        ...(unrealizedPnl !== undefined ? {
          unrealizedPnl,
          totalPnl: trade.realizedPnl + unrealizedPnl,
        } : {}),
        ...(unrealizedReturnPct !== undefined ? { unrealizedReturnPct } : {}),
        ...(trade.stopPrice !== undefined ? { stopPrice: trade.stopPrice } : {}),
        entryTimestamp: trade.entryTimestamp,
        elapsedMs: Math.max(0, generatedAt - trade.entryTimestamp),
        ...(workingOrder ? { workingOrder: publicWorkingOrder(workingOrder) } : {}),
      });
    }

    for (const order of workingOrders) {
      if (representedOrders.has(order.clientOrderId)) continue;
      const quote = this.#latestOptionQuotes.get(order.symbol);
      cards.push({
        id: order.clientOrderId,
        symbol: order.symbol,
        lifecycle: order.purpose === "EXIT" ? "EXIT_PENDING" : "ENTRY_PENDING",
        stage: order.purpose === "EXIT" ? "EXIT_WORKING" : "ENTRY_WORKING",
        quantity: order.quantity,
        remainingQuantity: Math.max(0, order.quantity - order.filledQuantity),
        ...(order.averageFillPrice !== undefined ? { entryPrice: order.averageFillPrice } : {}),
        ...(quote ? {
          currentBid: quote.bidPrice,
          currentAsk: quote.askPrice,
          markPrice: quote.bidPrice,
          lastQuoteTimestamp: quote.timestamp,
          quoteAgeMs: Math.max(0, generatedAt - quote.timestamp),
        } : {}),
        realizedPnl: 0,
        entryTimestamp: order.timestamp,
        elapsedMs: Math.max(0, generatedAt - order.timestamp),
        workingOrder: publicWorkingOrder(order),
      });
    }
    return cards.sort((a, b) => (b.entryTimestamp ?? 0) - (a.entryTimestamp ?? 0));
  }

  #publicOrder(order: DashboardOrder, generatedAt: number): DashboardOrder {
    const fillPercentage = order.quantity > 0 ? 100 * order.filledQuantity / order.quantity : 0;
    const firstFillLatencyMs = order.firstFillTimestamp === undefined
      ? undefined : Math.max(0, order.firstFillTimestamp - order.timestamp);
    const completionLatencyMs = order.completedTimestamp === undefined
      ? undefined : Math.max(0, order.completedTimestamp - order.timestamp);
    const priceImprovementBps = order.averageFillPrice === undefined || order.initialLimitPrice <= 0
      ? undefined
      : 10_000 * (order.side.toLowerCase() === "sell"
        ? order.averageFillPrice - order.initialLimitPrice
        : order.initialLimitPrice - order.averageFillPrice) / order.initialLimitPrice;
    return {
      ...order,
      updatedAt: isWorkingOrder(order) ? Math.max(order.updatedAt, generatedAt) : order.updatedAt,
      fillPercentage,
      ...(firstFillLatencyMs !== undefined ? { firstFillLatencyMs } : {}),
      ...(completionLatencyMs !== undefined ? { completionLatencyMs } : {}),
      ...(priceImprovementBps !== undefined ? { priceImprovementBps } : {}),
    };
  }

  #entryQuality(
    orders: DashboardOrder[], trades: MutableTrade[], signals: DashboardSignal[] = [...this.#signals.values()],
  ): DashboardEntryQuality[] {
    const entryOrders = orders.filter((order) => order.purpose === "ENTRY");
    return signals.slice(-500).reverse().map((signal) => {
      const order = entryOrders.find((candidate) => candidate.signalId === signal.id)
        ?? entryOrders.find((candidate) => signal.brokerOrderId && candidate.brokerOrderId === signal.brokerOrderId)
        ?? [...entryOrders].reverse().find((candidate) => candidate.symbol === signal.candidate &&
          candidate.timestamp >= signal.timestamp && candidate.timestamp - signal.timestamp <= 120_000);
      const trade = trades.find((candidate) => candidate.signalId === signal.id)
        ?? [...trades].reverse().find((candidate) => candidate.symbol === signal.candidate &&
          candidate.entryTimestamp >= signal.timestamp && candidate.entryTimestamp - signal.timestamp <= 180_000);
      const firstFillTimestamp = order?.firstFillTimestamp ?? trade?.entryTimestamp;
      const averageFillPrice = trade?.averageEntryPrice ?? order?.averageFillPrice;
      const excursions = trade ? tradeExcursions(trade) : undefined;
      const entrySlippageBps = averageFillPrice !== undefined && signal.decisionAsk !== undefined && signal.decisionAsk > 0
        ? 10_000 * (averageFillPrice - signal.decisionAsk) / signal.decisionAsk : undefined;
      const priceImprovementBps = averageFillPrice !== undefined && order && order.initialLimitPrice > 0
        ? 10_000 * (order.initialLimitPrice - averageFillPrice) / order.initialLimitPrice : undefined;
      let status: DashboardEntryQuality["status"] = signal.candidate ? "BLOCKED" : "NO_OPTION";
      if (order && isWorkingOrder(order)) status = "WORKING";
      if (firstFillTimestamp !== undefined) status = "FILLED";
      if (trade && trade.status !== "CLOSED") status = "OPEN";
      if (trade?.status === "CLOSED") status = trade.realizedPnl > 0 ? "WIN" : trade.realizedPnl < 0 ? "LOSS" : "FLAT";
      return {
        signalId: signal.id,
        underlying: signal.underlying,
        signalTimestamp: signal.timestamp,
        sessionBucket: sessionBucket(signal.timestamp),
        ...(signal.candidate ? { symbol: signal.candidate } : {}),
        direction: signal.direction,
        kind: signal.kind,
        regime: signal.regime,
        ...(signal.projectedMoveBps !== undefined ? { projectedMoveBps: signal.projectedMoveBps } : {}),
        status,
        ...(signal.decisionBid !== undefined ? { decisionBid: signal.decisionBid } : {}),
        ...(signal.decisionAsk !== undefined ? { decisionAsk: signal.decisionAsk } : {}),
        ...(signal.decisionSpreadPct !== undefined ? { decisionSpreadPct: signal.decisionSpreadPct } : {}),
        ...(signal.selectionScore !== undefined ? { selectionScore: signal.selectionScore } : {}),
        ...(signal.costMarginBps !== undefined ? { costMarginBps: signal.costMarginBps } : {}),
        ...(order ? {
          orderTimestamp: order.timestamp,
          signalToOrderMs: Math.max(0, order.timestamp - signal.timestamp),
          quantity: order.quantity,
          filledQuantity: order.filledQuantity,
          initialLimitPrice: order.initialLimitPrice,
          finalLimitPrice: order.limitPrice,
          replacements: order.replacements,
        } : {}),
        ...(firstFillTimestamp !== undefined ? {
          firstFillTimestamp,
          signalToFirstFillMs: Math.max(0, firstFillTimestamp - signal.timestamp),
          ...(order ? { orderToFirstFillMs: Math.max(0, firstFillTimestamp - order.timestamp) } : {}),
        } : {}),
        ...(averageFillPrice !== undefined ? { averageFillPrice } : {}),
        ...(entrySlippageBps !== undefined ? { entrySlippageBps } : {}),
        ...(priceImprovementBps !== undefined ? { priceImprovementBps } : {}),
        ...(excursions ? excursions : {}),
        ...(trade ? {
          realizedPnl: trade.realizedPnl,
          ...(trade.returnPct !== undefined ? { returnPct: trade.returnPct } : {}),
          ...(trade.exitTimestamp !== undefined ? { holdMs: Math.max(0, trade.exitTimestamp - trade.entryTimestamp) } : {}),
          ...(trade.exitReason ? { exitReason: trade.exitReason } : {}),
        } : {}),
      };
    });
  }

  #publicTrade(trade: MutableTrade): DashboardTrade {
    const remainingQuantity = Math.max(0, trade.quantity - trade.exitedQuantity);
    const quote = trade.status === "CLOSED" ? undefined : this.#latestOptionQuotes.get(trade.symbol);
    const markPrice = quote?.bidPrice;
    const unrealizedPnl = markPrice === undefined
      ? undefined : 100 * remainingQuantity * (markPrice - trade.averageEntryPrice);
    const openCost = 100 * remainingQuantity * trade.averageEntryPrice;
    const excursions = tradeExcursions(trade);
    return {
      id: trade.id,
      ...(trade.signalId ? { signalId: trade.signalId } : {}),
      symbol: trade.symbol,
      direction: trade.direction,
      entryTimestamp: trade.entryTimestamp,
      ...(trade.exitTimestamp !== undefined ? { exitTimestamp: trade.exitTimestamp } : {}),
      quantity: trade.quantity,
      remainingQuantity,
      averageEntryPrice: trade.averageEntryPrice,
      ...(trade.averageExitPrice !== undefined ? { averageExitPrice: trade.averageExitPrice } : {}),
      ...(quote ? {
        currentBid: quote.bidPrice,
        currentAsk: quote.askPrice,
        markPrice: quote.bidPrice,
        lastQuoteTimestamp: quote.timestamp,
      } : {}),
      realizedPnl: trade.realizedPnl,
      ...(unrealizedPnl !== undefined ? {
        unrealizedPnl,
        unrealizedReturnPct: openCost > 0 ? 100 * unrealizedPnl / openCost : 0,
      } : {}),
      ...(trade.stopPrice !== undefined ? { stopPrice: trade.stopPrice } : {}),
      ...excursions,
      ...(trade.returnPct !== undefined ? { returnPct: trade.returnPct } : {}),
      ...(trade.exitReason ? { exitReason: trade.exitReason } : {}),
      status: trade.status,
    };
  }

  #recordSignal(event: AuditEvent): void {
    const id = stringValue(event.data.signalId);
    if (!id) return;
    const candidate = stringValue(event.data.candidate);
    const metrics = recordValue(event.data.candidateMetrics);
    const eventQuote = recordValue(event.data.candidateQuote);
    const closest = recordValue(event.data.closestCandidate);
    const selectionStatus = stringValue(event.data.selectionStatus);
    const liveQuote = candidate ? this.#latestOptionQuotes.get(candidate) : undefined;
    const decisionBid = numberValue(eventQuote.bidPrice) ?? liveQuote?.bidPrice;
    const decisionAsk = numberValue(eventQuote.askPrice) ?? liveQuote?.askPrice;
    const decisionMid = numberValue(metrics.mid) ?? (decisionBid !== undefined && decisionAsk !== undefined
      ? (decisionBid + decisionAsk) / 2 : undefined);
    const decisionSpreadPct = numberValue(metrics.spreadPct) ??
      (decisionBid !== undefined && decisionAsk !== undefined && decisionMid !== undefined && decisionMid > 0
        ? (decisionAsk - decisionBid) / decisionMid : undefined);
    const explicitSelectionReasons = stringArray(event.data.selectionReasons);
    const closestReasons = stringArray(closest.rejectionReasons);
    const selectionReasons = explicitSelectionReasons.length > 0
      ? explicitSelectionReasons
      : closestReasons.length > 0 ? closestReasons : reasonCounts(event.data.rejectionCounts);
    const underlying = dashboardUnderlying(stringValue(event.data.underlying)) ??
      (candidate ? dashboardUnderlyingFromSymbol(candidate) : undefined) ??
      (stringValue(closest.symbol) ? dashboardUnderlyingFromSymbol(stringValue(closest.symbol)!) : undefined) ??
      "SPY";
    this.#signals.set(id, {
      id,
      underlying,
      timestamp: numberValue(event.data.timestamp) ?? event.timestamp,
      direction: stringValue(event.data.direction) ?? "UNKNOWN",
      kind: stringValue(event.data.kind) ?? "UNKNOWN",
      regime: stringValue(event.data.regime) ?? "UNKNOWN",
      configVersion: event.configVersion,
      ...(numberValue(event.data.projectedMoveBps) !== undefined
        ? { projectedMoveBps: numberValue(event.data.projectedMoveBps)! } : {}),
      ...(candidate ? { candidate } : {}),
      ...(stringValue(closest.symbol) ? { closestCandidate: stringValue(closest.symbol)! } : {}),
      ...(numberValue(event.data.evaluatedContracts) !== undefined
        ? { evaluatedContracts: numberValue(event.data.evaluatedContracts)! } : {}),
      ...(numberValue(metrics.score) !== undefined ? { selectionScore: numberValue(metrics.score)! } : {}),
      ...(numberValue(metrics.delta) !== undefined ? { delta: numberValue(metrics.delta)! } : {}),
      ...(numberValue(metrics.costMarginBps) !== undefined ? { costMarginBps: numberValue(metrics.costMarginBps)! } : {}),
      ...(numberValue(metrics.requiredMoveBps) !== undefined ? { requiredMoveBps: numberValue(metrics.requiredMoveBps)! } : {}),
      ...(numberValue(eventQuote.timestamp) !== undefined
        ? { decisionQuoteTimestamp: numberValue(eventQuote.timestamp)! }
        : liveQuote ? { decisionQuoteTimestamp: liveQuote.timestamp } : {}),
      ...(decisionBid !== undefined ? { decisionBid } : {}),
      ...(decisionAsk !== undefined ? { decisionAsk } : {}),
      ...(decisionMid !== undefined ? { decisionMid } : {}),
      ...(decisionSpreadPct !== undefined ? { decisionSpreadPct } : {}),
      ...(numberValue(event.data.selectionAttempt) !== undefined
        ? { selectionAttempt: numberValue(event.data.selectionAttempt)! } : {}),
      ...(numberValue(event.data.retryWaitMs) !== undefined
        ? { retryWaitMs: numberValue(event.data.retryWaitMs)! } : {}),
      status: selectionStatus === "RETRYING"
        ? "OPTION_RETRY_PENDING"
        : candidate ? "FIRED" : "NO_ELIGIBLE_OPTION",
      reasons: selectionReasons,
    });
    this.#recordOptionSelectionOpportunity(
      event,
      id,
      underlying,
      selectionStatus,
      candidate,
      closest,
      selectionReasons,
    );
    this.#pruneMap(this.#signals, 1_000);
  }

  #recordOptionSelectionOpportunity(
    event: AuditEvent,
    signalId: string,
    underlying: UnderlyingSymbol,
    selectionStatus: string | undefined,
    candidate: string | undefined,
    closest: Record<string, unknown>,
    reasons: string[],
  ): void {
    if (candidate) {
      this.#optionSelectionOpportunities.delete(signalId);
      return;
    }
    if (selectionStatus !== "NO_ELIGIBLE_OPTION") return;

    const quote = recordValue(event.data.closestCandidateQuote);
    const symbol = stringValue(closest.symbol);
    const decisionTimestamp = numberValue(event.data.decisionTimestamp) ?? event.timestamp;
    const decisionQuoteTimestamp = numberValue(quote.timestamp);
    const decisionBid = numberValue(quote.bidPrice);
    const decisionAsk = numberValue(quote.askPrice);
    const decisionBidSize = numberValue(quote.bidSize);
    const decisionAskSize = numberValue(quote.askSize);
    const decisionProviderAgeMs = numberValue(quote.correctedProviderAgeMs);
    const freshnessThresholdMs = numberValue(quote.freshnessThresholdMs);
    const explicitlyFresh = quote.freshAtDecision === true;
    const inferredFresh = decisionProviderAgeMs !== undefined && freshnessThresholdMs !== undefined &&
      decisionProviderAgeMs >= 0 && decisionProviderAgeMs <= freshnessThresholdMs;
    const validMarket = decisionBid !== undefined && decisionAsk !== undefined &&
      decisionBidSize !== undefined && decisionAskSize !== undefined &&
      decisionBid > 0 && decisionAsk > decisionBid && decisionBidSize > 0 && decisionAskSize > 0;
    const executable = symbol !== undefined && decisionQuoteTimestamp !== undefined &&
      validMarket && (explicitlyFresh || inferredFresh);
    const diagnosticReasons: string[] = [];
    if (!symbol) diagnosticReasons.push("MISSING_CANDIDATE_SYMBOL");
    if (decisionQuoteTimestamp === undefined || decisionBid === undefined || decisionAsk === undefined) {
      diagnosticReasons.push("MISSING_DECISION_QUOTE");
    } else if (!validMarket) {
      diagnosticReasons.push("INVALID_DECISION_MARKET");
    }
    if (!explicitlyFresh && !inferredFresh && decisionQuoteTimestamp !== undefined) {
      diagnosticReasons.push("STALE_DECISION_QUOTE");
    }

    this.#optionSelectionOpportunities.set(signalId, {
      signalId,
      timestamp: decisionTimestamp,
      underlying,
      ...(symbol ? { symbol } : {}),
      direction: stringValue(event.data.direction) ?? "UNKNOWN",
      regime: stringValue(event.data.regime) ?? "UNKNOWN",
      status: executable ? "PENDING" : "NON_EXECUTABLE",
      horizonSec: OPTION_SELECTION_OUTCOME_HORIZON_SEC,
      ...(decisionQuoteTimestamp !== undefined ? { decisionQuoteTimestamp } : {}),
      ...(decisionBid !== undefined ? { decisionBid } : {}),
      ...(decisionAsk !== undefined ? { decisionAsk } : {}),
      ...(decisionBidSize !== undefined ? { decisionBidSize } : {}),
      ...(decisionAskSize !== undefined ? { decisionAskSize } : {}),
      ...(decisionProviderAgeMs !== undefined ? { decisionProviderAgeMs } : {}),
      ...(freshnessThresholdMs !== undefined ? { freshnessThresholdMs } : {}),
      reasons: [...reasons],
      diagnosticReasons,
    });
    this.#pruneMap(this.#optionSelectionOpportunities, 2_000);
  }

  #updateOptionSelectionOpportunities(event: HistoricalMarketEvent, forwardBid: number): void {
    for (const opportunity of this.#optionSelectionOpportunities.values()) {
      if (opportunity.status !== "PENDING" || opportunity.symbol !== event.symbol ||
          opportunity.decisionAsk === undefined) continue;
      const elapsed = event.receivedTimestamp - opportunity.timestamp;
      const horizonMs = opportunity.horizonSec * 1_000;
      if (elapsed < horizonMs) continue;
      if (elapsed > horizonMs + OPTION_SELECTION_OUTCOME_TOLERANCE_MS) {
        opportunity.status = "NON_EXECUTABLE";
        opportunity.diagnosticReasons.push("NO_FRESH_FORWARD_QUOTE_AT_HORIZON");
        continue;
      }
      const providerAgeMs = correctedProviderLatencyMs(
        event.receivedTimestamp,
        event.providerTimestamp,
        this.#marketDataClockOffsetMs,
      );
      const freshnessThresholdMs = opportunity.freshnessThresholdMs;
      if (providerAgeMs < 0 ||
          (freshnessThresholdMs !== undefined && providerAgeMs > freshnessThresholdMs)) continue;
      const grossExecutablePnlPerContract = 100 * (forwardBid - opportunity.decisionAsk);
      opportunity.forwardQuoteTimestamp = numberValue(event.data.timestamp) ?? event.providerTimestamp;
      opportunity.forwardBid = forwardBid;
      opportunity.grossExecutablePnlPerContract = grossExecutablePnlPerContract;
      opportunity.grossExecutableReturnPct = 100 * (forwardBid - opportunity.decisionAsk) /
        opportunity.decisionAsk;
      opportunity.status = grossExecutablePnlPerContract > 0 ? "PROFITABLE_MISS" : "CORRECT_REJECTION";
    }
  }

  #recordRiskDecision(event: AuditEvent): void {
    const id = stringValue(event.data.signalId);
    if (!id) return;
    const existing = this.#signals.get(id);
    if (!existing) return;
    const risk = recordValue(event.data.risk);
    const reasons = stringArray(risk.reasons);
    if (risk.allowed === true) {
      existing.riskStatus = "ALLOWED";
      existing.riskReasons = [];
      return;
    }
    if (risk.allowed !== false) return;
    existing.riskStatus = "BLOCKED";
    existing.riskReasons = reasons;
    existing.status = "ORDER_BLOCKED";
    existing.reasons = reasons;
  }

  #recordSubmissionResult(event: AuditEvent): void {
    const id = stringValue(event.data.signalId);
    if (!id) return;
    const existing = this.#signals.get(id);
    const submitted = event.data.submitted === true;
    const reasons = stringArray(event.data.reasons);
    const brokerOrderId = stringValue(event.data.brokerOrderId);
    if (existing) {
      existing.status = submitted ? "ORDER_SUBMITTED" : "ORDER_BLOCKED";
      existing.reasons = reasons;
      if (brokerOrderId) existing.brokerOrderId = brokerOrderId;
    }
  }

  #recordOrderRequest(event: AuditEvent): void {
    const order = recordValue(event.data.order);
    const clientOrderId = stringValue(order.clientOrderId);
    if (!clientOrderId) return;
    const purpose = event.data.purpose === "EXIT" ? "EXIT" : "ENTRY";
    const symbol = stringValue(order.symbol) ?? "UNKNOWN";
    const timestamp = numberValue(order.submittedAt) ?? event.timestamp;
    const signalId = purpose === "ENTRY"
      ? stringValue(event.data.signalId) ?? this.#matchingSignal(symbol, timestamp)?.id
      : undefined;
    const limitPrice = numberValue(order.limitPrice) ?? 0;
    const urgency = numberValue(event.data.urgency) ?? numberValue(order.urgency);
    const exitIntentId =
      stringValue(event.data.exitIntentId) ?? stringValue(order.intentId);
    const triggers = stringArray(event.data.triggers);
    this.#orders.set(clientOrderId, {
      clientOrderId,
      ...(signalId ? { signalId } : {}),
      timestamp,
      updatedAt: event.timestamp,
      purpose,
      symbol,
      side: stringValue(order.side) ?? "UNKNOWN",
      quantity: numberValue(order.requestedQuantity) ?? 0,
      initialLimitPrice: limitPrice,
      limitPrice,
      status: stringValue(order.status) ?? "SUBMITTED",
      filledQuantity: numberValue(order.filledQuantity) ?? 0,
      ...(positiveNumber(order.averageFillPrice) !== undefined ? { averageFillPrice: positiveNumber(order.averageFillPrice)! } : {}),
      replacements: numberValue(order.replacements) ?? 0,
      ...(urgency !== undefined ? { urgency } : {}),
      ...(numberValue(order.actionTtlMs) !== undefined
        ? { actionTtlMs: numberValue(order.actionTtlMs)! }
        : {}),
      ...(numberValue(order.priceCollar) !== undefined
        ? { priceCollar: numberValue(order.priceCollar)! }
        : {}),
      ...(typeof order.marketable === "boolean" ? { marketable: order.marketable } : {}),
      ...(exitIntentId ? { exitIntentId } : {}),
      ...(numberValue(event.data.attempt) !== undefined
        ? { attempt: numberValue(event.data.attempt)! }
        : {}),
      ...(triggers.length > 0 ? { triggers } : {}),
      ...(stringValue(event.data.reason) ? { exitReason: stringValue(event.data.reason)! } : {}),
    });
    this.#pruneMap(this.#orders, 2_000);
  }

  #recordOrderState(event: AuditEvent): void {
    const local = recordValue(event.data.localOrder);
    const broker = recordValue(event.data.broker);
    const clientOrderId = stringValue(local.clientOrderId) ?? stringValue(broker.clientOrderId);
    if (!clientOrderId) return;
    const existing = this.#orders.get(clientOrderId);
    if (!existing) return;
    existing.updatedAt = event.timestamp;
    existing.status = stringValue(broker.status) ?? stringValue(local.status) ?? existing.status;
    const filledQuantity = numberValue(broker.filledQuantity) ?? numberValue(local.filledQuantity) ?? existing.filledQuantity;
    if (existing.filledQuantity === 0 && filledQuantity > 0 && existing.firstFillTimestamp === undefined) {
      existing.firstFillTimestamp = event.timestamp;
    }
    existing.filledQuantity = filledQuantity;
    existing.limitPrice = numberValue(local.limitPrice) ?? existing.limitPrice;
    existing.replacements = numberValue(local.replacements) ?? existing.replacements;
    const brokerOrderId = stringValue(broker.id);
    if (brokerOrderId) existing.brokerOrderId = brokerOrderId;
    const averageFillPrice = positiveNumber(broker.averageFillPrice) ?? positiveNumber(local.averageFillPrice);
    if (averageFillPrice !== undefined) existing.averageFillPrice = averageFillPrice;
    if (!isWorkingOrder(existing) && existing.completedTimestamp === undefined) existing.completedTimestamp = event.timestamp;
  }

  #recordOrderReplacement(event: AuditEvent): void {
    const local = recordValue(event.data.localOrder);
    const replacement = recordValue(event.data.replacement);
    const clientOrderId = stringValue(local.clientOrderId) ?? stringValue(replacement.clientOrderId);
    if (!clientOrderId) return;
    const existing = this.#orders.get(clientOrderId);
    if (!existing) return;
    existing.updatedAt = event.timestamp;
    existing.limitPrice = numberValue(local.limitPrice) ?? existing.limitPrice;
    existing.replacements = numberValue(local.replacements) ?? existing.replacements;
    const brokerOrderId = stringValue(replacement.id);
    if (brokerOrderId) existing.brokerOrderId = brokerOrderId;
  }

  #recordEntryFill(event: AuditEvent): void {
    const position = recordValue(event.data.position);
    const symbol = stringValue(position.symbol);
    if (!symbol) return;
    const entryTimestamp = numberValue(position.entryTimestamp) ?? event.timestamp;
    const id = `${symbol}-${entryTimestamp}`;
    const existing = this.#openTrades.get(symbol);
    const quantity = numberValue(position.quantity) ?? numberValue(event.data.cumulativeQuantity) ?? 0;
    const averageEntryPrice = numberValue(position.averageEntryPrice) ?? numberValue(event.data.incrementalPrice) ?? 0;
    const stopPrice = numberValue(position.stopPrice);
    const signalId = stringValue(event.data.signalId)
      ?? [...this.#orders.values()].reverse().find((order) => order.purpose === "ENTRY" && order.symbol === symbol)?.signalId
      ?? this.#matchingSignal(symbol, entryTimestamp)?.id;
    const order = [...this.#orders.values()].reverse().find((candidate) =>
      candidate.purpose === "ENTRY" && (candidate.signalId === signalId || candidate.symbol === symbol));
    if (order && order.firstFillTimestamp === undefined) order.firstFillTimestamp = event.timestamp;
    const management = orderManagementFields(position);
    if (existing) {
      Object.assign(existing, management);
      if (order) existing.entryOrderId = order.clientOrderId;
      existing.quantity = Math.max(existing.quantity, quantity);
      existing.averageEntryPrice = averageEntryPrice;
      if (stopPrice !== undefined) existing.stopPrice = stopPrice;
      existing.status = "OPEN";
    } else {
      this.#openTrades.set(symbol, {
        id, symbol,
        ...(signalId ? { signalId } : {}),
        direction: stringValue(position.direction) ?? "UNKNOWN",
        entryTimestamp,
        quantity,
        averageEntryPrice,
        ...(stopPrice !== undefined ? { stopPrice } : {}),
        realizedPnl: 0,
        status: "OPEN",
        exitedQuantity: 0,
        exitNotional: 0,
        ...management,
        ...(order ? { entryOrderId: order.clientOrderId } : {}),
      });
    }
  }

  #recordOrderManagementState(event: AuditEvent): void {
    const symbol = stringValue(event.data.symbol);
    if (!symbol) return;
    const trade = this.#openTrades.get(symbol);
    if (!trade) return;
    const entryTimestamp = numberValue(event.data.entryTimestamp);
    if (entryTimestamp !== undefined && entryTimestamp !== trade.entryTimestamp) return;
    Object.assign(trade, orderManagementFields(event.data));
    for (const field of [
      "protectedFloorPnl",
      "floorBufferDollars",
      "recoveryProbability",
      "continuationLcbDollars",
      "optionContinuation",
    ] as const) {
      if (Object.hasOwn(event.data, field) && event.data[field] === null) delete trade[field];
    }
  }

  #recordExitFill(event: AuditEvent): void {
    const symbol = stringValue(event.data.symbol);
    if (!symbol) return;
    let trade = this.#openTrades.get(symbol);
    if (!trade) {
      const entryTimestamp = numberValue(event.data.entryTimestamp) ?? event.timestamp;
      trade = {
        id: `${symbol}-${entryTimestamp}`, symbol,
        direction: stringValue(event.data.direction) ?? "UNKNOWN",
        entryTimestamp,
        quantity: numberValue(event.data.incrementalQuantity) ?? 0,
        averageEntryPrice: numberValue(event.data.averageEntryPrice) ?? 0,
        realizedPnl: 0,
        status: "OPEN",
        exitedQuantity: 0,
        exitNotional: 0,
      };
      this.#openTrades.set(symbol, trade);
    }
    Object.assign(trade, orderManagementFields(event.data));
    const quantity = numberValue(event.data.incrementalQuantity) ?? 0;
    const price = numberValue(event.data.incrementalPrice) ?? 0;
    trade.exitedQuantity += quantity;
    trade.exitNotional += quantity * price;
    trade.realizedPnl += numberValue(event.data.realizedPnl) ?? 0;
    if (trade.exitedQuantity > 0) trade.averageExitPrice = trade.exitNotional / trade.exitedQuantity;
    trade.exitTimestamp = event.timestamp;
    trade.exitReason = stringValue(event.data.reason) ?? "UNKNOWN";
    const cost = trade.averageEntryPrice * 100 * trade.exitedQuantity;
    if (cost > 0) trade.returnPct = 100 * trade.realizedPnl / cost;
    const remaining = numberValue(event.data.remainingQuantity) ?? 0;
    if (remaining <= 0) {
      trade.status = "CLOSED";
      this.#openTrades.delete(symbol);
      this.#closedTrades.push(trade);
      if (this.#closedTrades.length > 2_000) this.#closedTrades.splice(0, this.#closedTrades.length - 2_000);
    } else {
      trade.status = "PARTIAL_EXIT";
    }
  }

  #refreshProjectedOrderCards(
    timestamp: number,
    symbol?: string,
    source: NonNullable<DashboardOrderDynamicsUpdate["source"]> = "STATUS",
  ): DashboardOrderCard[] {
    const changedCompleted: DashboardOrderCard[] = [];
    const orders = [...this.#orders.values()];
    const closedEntryOrderIds = new Set(
      this.#closedTrades.map((trade) => trade.entryOrderId).filter((id): id is string => id !== undefined),
    );

    for (const active of this.#activeOrders(timestamp, orders)) {
      if (symbol && active.symbol !== symbol) continue;
      if (active.workingOrder?.purpose === "EXIT" &&
          this.#closedTrades.some((trade) => trade.symbol === active.symbol)) continue;
      this.#captureOrderCard(this.#activeOrderCard(active), timestamp, source);
    }

    for (const trade of this.#closedTrades) {
      if (symbol && trade.symbol !== symbol) continue;
      if (symbol && trade.exitTimestamp !== undefined && timestamp > trade.exitTimestamp) continue;
      const card = this.#closedOrderCard(trade);
      if (this.#captureOrderCard(card, timestamp, "STATUS")) changedCompleted.push(this.#orderCards.get(card.id)!);
    }

    for (const order of orders) {
      if (symbol && order.symbol !== symbol) continue;
      if (order.purpose !== "ENTRY") continue;
      const existingCard = this.#orderCards.get(order.clientOrderId);
      if (order.filledQuantity > 0 && !isWorkingOrder(order) && existingCard &&
          !closedEntryOrderIds.has(order.clientOrderId) &&
          !this.#openTrades.has(order.symbol)) {
        this.#captureOrderCard({
          ...cloneOrderCard(existingCard),
          active: true,
          status: order.status,
          remainingQuantity: Math.max(0, order.quantity - order.filledQuantity),
          workingOrder: publicWorkingOrder(order),
          updates: [],
        }, timestamp, source);
        continue;
      }
      if (order.filledQuantity > 0 || isWorkingOrder(order) ||
          closedEntryOrderIds.has(order.clientOrderId)) continue;
      const stage = order.status.toUpperCase().includes("REJECT") ? "REJECTED" : "CANCELLED";
      const card: DashboardOrderCard = {
        id: order.clientOrderId,
        ...(order.signalId ? { signalId: order.signalId } : {}),
        symbol: order.symbol,
        active: false,
        stage,
        status: order.status,
        quantity: order.quantity,
        remainingQuantity: 0,
        realizedPnl: 0,
        totalPnl: 0,
        entryTimestamp: order.timestamp,
        exitTimestamp: order.completedTimestamp ?? order.updatedAt,
        elapsedMs: Math.max(0, (order.completedTimestamp ?? order.updatedAt) - order.timestamp),
        updates: [],
      };
      if (this.#captureOrderCard(card, timestamp, "STATUS")) changedCompleted.push(this.#orderCards.get(card.id)!);
    }
    return changedCompleted;
  }

  #activeOrderCard(active: DashboardActiveOrder): DashboardOrderCard {
    const trade = this.#openTrades.get(active.symbol);
    const order = active.workingOrder
      ? this.#orders.get(active.workingOrder.clientOrderId)
      : trade?.entryOrderId ? this.#orders.get(trade.entryOrderId) : undefined;
    return {
      id: active.id,
      ...(trade?.signalId ? { signalId: trade.signalId } : order?.signalId ? { signalId: order.signalId } : {}),
      symbol: active.symbol,
      ...(active.direction ? { direction: active.direction } : {}),
      ...copyOrderManagement(active),
      active: true,
      stage: active.stage,
      status: active.workingOrder?.status ?? order?.status ?? trade?.status ?? active.stage,
      quantity: active.quantity,
      remainingQuantity: active.remainingQuantity,
      ...(active.entryPrice !== undefined ? { entryPrice: active.entryPrice } : {}),
      ...(active.currentBid !== undefined ? { currentBid: active.currentBid } : {}),
      ...(active.currentAsk !== undefined ? { currentAsk: active.currentAsk } : {}),
      ...(active.markPrice !== undefined ? { markPrice: active.markPrice } : {}),
      realizedPnl: active.realizedPnl,
      ...(active.unrealizedPnl !== undefined ? { unrealizedPnl: active.unrealizedPnl } : {}),
      ...(active.unrealizedReturnPct !== undefined ? { unrealizedReturnPct: active.unrealizedReturnPct } : {}),
      ...(active.totalPnl !== undefined ? { totalPnl: active.totalPnl } : {}),
      ...(active.stopPrice !== undefined ? { stopPrice: active.stopPrice } : {}),
      ...(active.entryTimestamp !== undefined ? { entryTimestamp: active.entryTimestamp } : {}),
      ...(active.elapsedMs !== undefined ? { elapsedMs: active.elapsedMs } : {}),
      ...(active.lastQuoteTimestamp !== undefined ? { lastQuoteTimestamp: active.lastQuoteTimestamp } : {}),
      ...(active.quoteAgeMs !== undefined ? { quoteAgeMs: active.quoteAgeMs } : {}),
      ...(active.workingOrder ? { workingOrder: { ...active.workingOrder } } : {}),
      updates: [],
    };
  }

  #closedOrderCard(trade: MutableTrade): DashboardOrderCard {
    const exitOrder = [...this.#orders.values()].reverse().find((order) =>
      order.purpose === "EXIT" && order.symbol === trade.symbol &&
      order.timestamp >= trade.entryTimestamp &&
      (trade.exitTimestamp === undefined || order.timestamp <= trade.exitTimestamp));
    const latestQuote = this.#latestOptionQuotes.get(trade.symbol);
    const quote = latestQuote && trade.exitTimestamp !== undefined &&
      latestQuote.timestamp >= trade.entryTimestamp && latestQuote.timestamp <= trade.exitTimestamp
      ? latestQuote : undefined;
    return {
      id: trade.entryOrderId ?? trade.id,
      ...(trade.signalId ? { signalId: trade.signalId } : {}),
      symbol: trade.symbol,
      direction: trade.direction,
      ...copyOrderManagement(trade),
      lifecycle: "CLOSED",
      active: false,
      stage: "CLOSED",
      status: exitOrder?.status ?? "CLOSED",
      quantity: trade.quantity,
      remainingQuantity: 0,
      entryPrice: trade.averageEntryPrice,
      ...(trade.averageExitPrice !== undefined ? { exitPrice: trade.averageExitPrice } : {}),
      ...(quote ? {
        currentBid: quote.bidPrice,
        currentAsk: quote.askPrice,
        markPrice: quote.bidPrice,
        lastQuoteTimestamp: quote.timestamp,
        quoteAgeMs: trade.exitTimestamp === undefined ? 0 : Math.max(0, trade.exitTimestamp - quote.timestamp),
      } : {}),
      realizedPnl: trade.realizedPnl,
      unrealizedPnl: 0,
      totalPnl: trade.realizedPnl,
      ...(trade.returnPct !== undefined ? { unrealizedReturnPct: trade.returnPct } : {}),
      ...(trade.stopPrice !== undefined ? { stopPrice: trade.stopPrice } : {}),
      entryTimestamp: trade.entryTimestamp,
      ...(trade.exitTimestamp !== undefined ? {
        exitTimestamp: trade.exitTimestamp,
        elapsedMs: Math.max(0, trade.exitTimestamp - trade.entryTimestamp),
      } : {}),
      ...(trade.exitReason ? { exitReason: trade.exitReason } : {}),
      ...(exitOrder ? { workingOrder: publicWorkingOrder(exitOrder) } : {}),
      updates: [],
    };
  }

  #captureOrderCard(
    projected: DashboardOrderCard,
    timestamp: number,
    source: NonNullable<DashboardOrderDynamicsUpdate["source"]>,
  ): boolean {
    const existing = this.#orderCards.get(projected.id);
    const updates = existing?.updates ?? [];
    const previous = updates.at(-1);
    const next: DashboardOrderDynamicsUpdate = {
      timestamp,
      stage: projected.stage,
      status: projected.status,
      source,
      remainingQuantity: projected.remainingQuantity,
      realizedPnl: projected.realizedPnl,
      ...(projected.currentBid !== undefined ? { currentBid: projected.currentBid } : {}),
      ...(projected.currentAsk !== undefined ? { currentAsk: projected.currentAsk } : {}),
      ...(projected.unrealizedPnl !== undefined ? { unrealizedPnl: projected.unrealizedPnl } : {}),
      ...(projected.totalPnl !== undefined ? { totalPnl: projected.totalPnl } : {}),
      ...copyOrderManagement(projected),
    };
    const duplicate = updates.some((update) =>
      update.timestamp === next.timestamp && sameDynamics(update, next));
    const changed = !previous || !sameDynamics(previous, next);
    if (!duplicate && changed && (!previous || timestamp >= previous.timestamp)) {
      const previousPnl = previous?.totalPnl ?? previous?.unrealizedPnl;
      const nextPnl = next.totalPnl ?? next.unrealizedPnl;
      if (previousPnl !== undefined && nextPnl !== undefined) next.pnlChange = nextPnl - previousPnl;
      updates.push(next);
    }
    const nextCard: DashboardOrderCard = {
      ...(existing ?? {}),
      ...projected,
      updates,
    };
    for (const field of [
      "protectedFloorPnl",
      "floorBufferDollars",
      "recoveryProbability",
      "continuationLcbDollars",
      "optionContinuation",
    ] as const) {
      if (projected[field] === undefined) delete nextCard[field];
    }
    this.#orderCards.set(projected.id, nextCard);
    return !projected.active && (!existing || changed);
  }

  #pruneMap<K, V>(map: Map<K, V>, maximum: number): void {
    while (map.size > maximum) {
      const first = map.keys().next();
      if (first.done) return;
      map.delete(first.value);
    }
  }

  #matchingSignal(symbol: string, timestamp: number): DashboardSignal | undefined {
    return [...this.#signals.values()].reverse().find((signal) => signal.candidate === symbol &&
      signal.timestamp <= timestamp && timestamp - signal.timestamp <= 120_000);
  }
}

function tradeExcursions(trade: Pick<MutableTrade,
"averageEntryPrice" | "quantity" | "highWaterPnl" | "lowWaterPnl" | "status" | "returnPct">): {
  maxFavorableExcursionPct?: number;
  maxAdverseExcursionPct?: number;
  capturePct?: number;
} {
  const entryCost = 100 * trade.quantity * trade.averageEntryPrice;
  if (!(entryCost > 0)) return {};
  const maxFavorableExcursionPct = trade.highWaterPnl === undefined
    ? undefined
    : 100 * trade.highWaterPnl / entryCost;
  const maxAdverseExcursionPct = trade.lowWaterPnl === undefined
    ? undefined
    : 100 * trade.lowWaterPnl / entryCost;
  const capturePct = trade.status === "CLOSED" && trade.returnPct !== undefined && trade.returnPct > 0 &&
    maxFavorableExcursionPct !== undefined && maxFavorableExcursionPct > 0
    ? Math.max(0, Math.min(100, 100 * trade.returnPct / maxFavorableExcursionPct)) : undefined;
  return {
    ...(maxFavorableExcursionPct !== undefined ? { maxFavorableExcursionPct } : {}),
    ...(maxAdverseExcursionPct !== undefined ? { maxAdverseExcursionPct } : {}),
    ...(capturePct !== undefined ? { capturePct } : {}),
  };
}

function tuningSummary(entries: DashboardEntryQuality[]): DashboardTuningSummary {
  const submitted = entries.filter((entry) => entry.orderTimestamp !== undefined);
  const filled = submitted.filter((entry) => entry.firstFillTimestamp !== undefined);
  const closed = entries.filter((entry) => ["WIN", "LOSS", "FLAT"].includes(entry.status));
  const avgSignalToOrderMs = average(entries.map((entry) => entry.signalToOrderMs));
  const avgOrderToFirstFillMs = average(entries.map((entry) => entry.orderToFirstFillMs));
  const avgSignalToFirstFillMs = average(entries.map((entry) => entry.signalToFirstFillMs));
  const avgEntrySlippageBps = average(entries.map((entry) => entry.entrySlippageBps));
  const avgDecisionSpreadPct = average(entries.map((entry) => entry.decisionSpreadPct));
  const avgMaxFavorableExcursionPct = average(entries.map((entry) => entry.maxFavorableExcursionPct));
  const avgMaxAdverseExcursionPct = average(entries.map((entry) => entry.maxAdverseExcursionPct));
  const avgCapturePct = average(entries.map((entry) => entry.capturePct));
  return {
    signals: entries.length,
    submitted: submitted.length,
    filled: filled.length,
    closed: closed.length,
    fillRate: submitted.length > 0 ? filled.length / submitted.length : 0,
    replacementRate: submitted.length > 0
      ? submitted.filter((entry) => (entry.replacements ?? 0) > 0).length / submitted.length : 0,
    ...(avgSignalToOrderMs !== undefined ? { avgSignalToOrderMs } : {}),
    ...(avgOrderToFirstFillMs !== undefined ? { avgOrderToFirstFillMs } : {}),
    ...(avgSignalToFirstFillMs !== undefined ? { avgSignalToFirstFillMs } : {}),
    ...(avgEntrySlippageBps !== undefined ? { avgEntrySlippageBps } : {}),
    ...(avgDecisionSpreadPct !== undefined ? { avgDecisionSpreadPct } : {}),
    ...(avgMaxFavorableExcursionPct !== undefined ? { avgMaxFavorableExcursionPct } : {}),
    ...(avgMaxAdverseExcursionPct !== undefined ? { avgMaxAdverseExcursionPct } : {}),
    ...(avgCapturePct !== undefined ? { avgCapturePct } : {}),
  };
}

function average(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) / finite.length : undefined;
}

function sessionBucket(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).formatToParts(timestamp);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const minutes = hour * 60 + minute;
  if (minutes < 10 * 60) return "09:30–10:00";
  if (minutes < 11 * 60) return "10:00–11:00";
  if (minutes < 13 * 60) return "11:00–13:00";
  if (minutes < 15 * 60) return "13:00–15:00";
  return "15:00–close";
}

const DECISION_EVENT_TYPES = new Set([
  "live_entry_evaluation",
  "live_signal_selection",
  "late_bullish_grind_confirmation",
  "risk_decision",
  "entry_blocked",
  "paper_order_submission_result",
  "broker_order_request",
  "broker_order_state",
  "broker_order_replaced",
  "entry_fill",
  "exit_fill",
]);

function isDecisionEvent(type: string): boolean { return DECISION_EVENT_TYPES.has(type); }

function emptyMarketEventCounts(): Record<HistoricalMarketEventType, number> {
  return {
    stock_quote: 0,
    stock_trade: 0,
    option_contract: 0,
    option_quote: 0,
    option_trade: 0,
    option_aggregate: 0,
    option_snapshot: 0,
    feature_snapshot: 0,
  };
}

function dashboardUnderlying(value: string | undefined): UnderlyingSymbol | undefined {
  return isUnderlyingSymbol(value) ? value : undefined;
}

function dashboardUnderlyingFromSymbol(symbol: string): UnderlyingSymbol | undefined {
  return dashboardUnderlying(symbol) ?? dashboardUnderlying(parseOccSymbol(symbol)?.underlying);
}

function dashboardDecisionUnderlying(decision: DashboardDecision): UnderlyingSymbol {
  return dashboardUnderlying(decision.underlying) ??
    (decision.symbol ? dashboardUnderlyingFromSymbol(decision.symbol) : undefined) ??
    "SPY";
}

function marketEventChannel(type: HistoricalMarketEventType): DashboardLiveFeedEvent["channel"] {
  if (type === "stock_quote" || type === "stock_trade") return "SIP";
  if (type === "option_quote" || type === "option_trade" || type === "option_aggregate") return "OPRA";
  if (type === "feature_snapshot") return "ENGINE";
  return "ALPACA_REST";
}

function marketEventSummary(event: HistoricalMarketEvent): string {
  const data = event.data;
  if (event.type === "stock_quote" || event.type === "option_quote") {
    return `bid ${formatFeedNumber(numberValue(data.bidPrice))} · ask ${formatFeedNumber(numberValue(data.askPrice))} · size ${formatFeedNumber(numberValue(data.bidSize), 0)}/${formatFeedNumber(numberValue(data.askSize), 0)}`;
  }
  if (event.type === "stock_trade") {
    return `trade ${formatFeedNumber(numberValue(data.price))} × ${formatFeedNumber(numberValue(data.size), 0)}`;
  }
  if (event.type === "option_trade") {
    return `option trade ${formatFeedNumber(numberValue(data.price))} × ${formatFeedNumber(numberValue(data.size), 0)}`;
  }
  if (event.type === "option_aggregate") {
    return `OHLC ${formatFeedNumber(numberValue(data.open))}/${formatFeedNumber(numberValue(data.high))}/` +
      `${formatFeedNumber(numberValue(data.low))}/${formatFeedNumber(numberValue(data.close))} · ` +
      `volume ${formatFeedNumber(numberValue(data.volume), 0)}`;
  }
  if (event.type === "option_contract") {
    return `${stringValue(data.type) ?? "option"} · strike ${formatFeedNumber(numberValue(data.strike))} · expires ${stringValue(data.expirationDate) ?? "—"}`;
  }
  if (event.type === "option_snapshot") {
    const greeks = recordValue(data.greeks);
    return `IV ${formatFeedNumber(numberValue(data.impliedVolatility), 4)} · delta ${formatFeedNumber(numberValue(greeks.delta), 3)} · volume ${formatFeedNumber(numberValue(data.dailyVolume), 0)}`;
  }
  const fast = recordValue(data.fast);
  return `${stringValue(data.symbol) ?? "SPY"} ${formatFeedNumber(numberValue(data.price))} · ` +
    `fast slope ${formatFeedNumber(numberValue(fast.normalizedSlope), 3)} · ` +
    `OFI5 ${formatFeedNumber(numberValue(data.ofi5), 3)}`;
}

function formatFeedNumber(value: number | undefined, digits = 2): string {
  return value === undefined ? "—" : value.toFixed(digits);
}

function reasonCounts(value: unknown): string[] {
  return Object.entries(recordValue(value))
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason} (${count})`);
}

function decisionDirections(value: unknown): DashboardDecision["directions"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const direction = recordValue(item);
    const votes = Array.isArray(direction.votes) ? direction.votes.map((item) => {
      const vote = recordValue(item);
      return {
        name: stringValue(vote.name) ?? "UNKNOWN",
        passed: vote.passed === true,
        value: numberValue(vote.value) ?? 0,
        threshold: numberValue(vote.threshold) ?? 0,
      };
    }) : [];
    const projectedMoveBps = numberValue(direction.projectedMoveBps);
    return {
      direction: stringValue(direction.direction) ?? "UNKNOWN",
      passed: direction.passed === true,
      reasons: stringArray(direction.reasons),
      votes,
      ...(projectedMoveBps !== undefined ? { projectedMoveBps } : {}),
    };
  });
}

function publicDecision(decision: DashboardDecision): DashboardDecision {
  return {
    ...decision,
    reasons: [...decision.reasons],
    ...(decision.directions ? {
      directions: decision.directions.map((direction) => ({
        ...direction,
        reasons: [...direction.reasons],
        votes: direction.votes.map((vote) => ({ ...vote })),
      })),
    } : {}),
  };
}

function isWorkingOrder(order: DashboardOrder): boolean {
  return new Set([
    "SUBMITTED", "PARTIAL", "REPLACE_PENDING", "CANCEL_PENDING", "NEW", "ACCEPTED",
    "PARTIALLY_FILLED", "PENDING_NEW", "PENDING_REPLACE", "PENDING_CANCEL", "ACCEPTED_FOR_BIDDING", "HELD",
  ]).has(order.status.toUpperCase());
}

function publicWorkingOrder(order: DashboardOrder): NonNullable<DashboardActiveOrder["workingOrder"]> {
  return {
    clientOrderId: order.clientOrderId,
    ...(order.brokerOrderId ? { brokerOrderId: order.brokerOrderId } : {}),
    purpose: order.purpose,
    side: order.side,
    status: order.status,
    limitPrice: order.limitPrice,
    requestedQuantity: order.quantity,
    filledQuantity: order.filledQuantity,
    replacements: order.replacements,
    ...(order.urgency !== undefined ? { urgency: order.urgency } : {}),
    ...(order.actionTtlMs !== undefined ? { actionTtlMs: order.actionTtlMs } : {}),
    ...(order.priceCollar !== undefined ? { priceCollar: order.priceCollar } : {}),
    ...(order.marketable !== undefined ? { marketable: order.marketable } : {}),
    ...(order.exitIntentId ? { exitIntentId: order.exitIntentId } : {}),
    ...(order.attempt !== undefined ? { attempt: order.attempt } : {}),
    ...(order.triggers ? { triggers: [...order.triggers] } : {}),
  };
}

function sameDynamics(left: DashboardOrderDynamicsUpdate, right: DashboardOrderDynamicsUpdate): boolean {
  return left.stage === right.stage &&
    left.status === right.status &&
    left.remainingQuantity === right.remainingQuantity &&
    left.realizedPnl === right.realizedPnl &&
    left.currentBid === right.currentBid &&
    left.unrealizedPnl === right.unrealizedPnl &&
    left.totalPnl === right.totalPnl &&
    sameOrderManagement(left, right);
}

function cloneOrderCard(card: DashboardOrderCard): DashboardOrderCard {
  const quality = classifyOrderCardEntryQuality(card);
  return {
    ...card,
    ...quality,
    ...(card.exitTriggers ? { exitTriggers: [...card.exitTriggers] } : {}),
    ...(card.optionContinuation
      ? { optionContinuation: { ...card.optionContinuation } }
      : {}),
    ...(card.workingOrder ? {
      workingOrder: {
        ...card.workingOrder,
        ...(card.workingOrder.triggers
          ? { triggers: [...card.workingOrder.triggers] }
          : {}),
      },
    } : {}),
    updates: card.updates.map((update) => ({
      ...update,
      ...(update.exitTriggers ? { exitTriggers: [...update.exitTriggers] } : {}),
      ...(update.optionContinuation
        ? { optionContinuation: { ...update.optionContinuation } }
        : {}),
    })),
  };
}

function orderManagementFields(
  value: Record<string, unknown>,
): DashboardOrderManagement {
  const option = recordValue(value.optionContinuation);
  const optionContinuation: DashboardOptionContinuation = {
    ...(numberValue(option.deltaDollars) !== undefined
      ? { deltaDollars: numberValue(option.deltaDollars)! }
      : {}),
    ...(numberValue(option.gammaDollars) !== undefined
      ? { gammaDollars: numberValue(option.gammaDollars)! }
      : {}),
    ...(numberValue(option.vegaDollars) !== undefined
      ? { vegaDollars: numberValue(option.vegaDollars)! }
      : {}),
    ...(numberValue(option.thetaDollars) !== undefined
      ? { thetaDollars: numberValue(option.thetaDollars)! }
      : {}),
    ...(numberValue(option.holdingCostDollars) !== undefined
      ? { holdingCostDollars: numberValue(option.holdingCostDollars)! }
      : {}),
    ...(numberValue(option.uncertaintyDollars) !== undefined
      ? { uncertaintyDollars: numberValue(option.uncertaintyDollars)! }
      : {}),
    ...(numberValue(option.expectedChangeDollars) !== undefined
      ? { expectedChangeDollars: numberValue(option.expectedChangeDollars)! }
      : {}),
    ...(numberValue(option.lcbDollars) !== undefined
      ? { lcbDollars: numberValue(option.lcbDollars)! }
      : {}),
    ...(typeof option.ivCrushDetected === "boolean"
      ? { ivCrushDetected: option.ivCrushDetected }
      : {}),
    ...(typeof option.providerGreeksAvailable === "boolean"
      ? { providerGreeksAvailable: option.providerGreeksAvailable }
      : {}),
  };
  const triggers = stringArray(value.triggers ?? value.exitTriggers);
  const decision = stringValue(value.decision ?? value.managementDecision);
  return {
    ...(stringValue(value.lifecycle) ? { lifecycle: stringValue(value.lifecycle)! } : {}),
    ...(stringValue(value.tradeState) ? { tradeState: stringValue(value.tradeState)! } : {}),
    ...(decision === "HOLD" || decision === "EXIT"
      ? { managementDecision: decision }
      : {}),
    ...(stringValue(value.reason ?? value.managementReason)
      ? { managementReason: stringValue(value.reason ?? value.managementReason)! }
      : {}),
    ...(triggers.length > 0 ? { exitTriggers: triggers } : {}),
    ...(numberValue(value.executablePnl) !== undefined
      ? { executablePnl: numberValue(value.executablePnl)! }
      : {}),
    ...(numberValue(value.liquidationPrice) !== undefined
      ? { liquidationPrice: numberValue(value.liquidationPrice)! }
      : {}),
    ...(numberValue(value.protectedFloorPnl) !== undefined
      ? { protectedFloorPnl: numberValue(value.protectedFloorPnl)! }
      : {}),
    ...(numberValue(value.floorBufferDollars) !== undefined
      ? { floorBufferDollars: numberValue(value.floorBufferDollars)! }
      : {}),
    ...(numberValue(value.highWaterPnl) !== undefined
      ? { highWaterPnl: numberValue(value.highWaterPnl)! }
      : {}),
    ...(numberValue(value.lowWaterPnl) !== undefined
      ? { lowWaterPnl: numberValue(value.lowWaterPnl)! }
      : {}),
    ...(numberValue(value.recoveryProbability ?? value.estimatedRecoveryProbability) !== undefined
      ? {
          recoveryProbability:
            numberValue(value.recoveryProbability ?? value.estimatedRecoveryProbability)!,
        }
      : {}),
    ...(numberValue(value.continuationLcbDollars ?? value.optionContinuationLcbDollars) !== undefined
      ? {
          continuationLcbDollars:
            numberValue(value.continuationLcbDollars ?? value.optionContinuationLcbDollars)!,
        }
      : {}),
    ...(numberValue(value.reversalCusum) !== undefined
      ? { reversalCusum: numberValue(value.reversalCusum)! }
      : {}),
    ...(numberValue(value.zeroCrossings) !== undefined
      ? { zeroCrossings: numberValue(value.zeroCrossings)! }
      : {}),
    ...(numberValue(value.pnlObservationCount) !== undefined
      ? { pnlObservationCount: numberValue(value.pnlObservationCount)! }
      : {}),
    ...(numberValue(value.oppositeRegimeSince) !== undefined
      ? { oppositeRegimeSince: numberValue(value.oppositeRegimeSince)! }
      : {}),
    ...(numberValue(value.oppositeRegimeObservationCount) !== undefined
      ? {
          oppositeRegimeObservationCount:
            numberValue(value.oppositeRegimeObservationCount)!,
        }
      : {}),
    ...(Object.keys(optionContinuation).length > 0 ? { optionContinuation } : {}),
  };
}

function copyOrderManagement(
  value: DashboardOrderManagement,
): DashboardOrderManagement {
  return {
    ...(value.lifecycle ? { lifecycle: value.lifecycle } : {}),
    ...(value.tradeState ? { tradeState: value.tradeState } : {}),
    ...(value.managementDecision
      ? { managementDecision: value.managementDecision }
      : {}),
    ...(value.managementReason ? { managementReason: value.managementReason } : {}),
    ...(value.exitTriggers ? { exitTriggers: [...value.exitTriggers] } : {}),
    ...(value.executablePnl !== undefined
      ? { executablePnl: value.executablePnl }
      : {}),
    ...(value.liquidationPrice !== undefined
      ? { liquidationPrice: value.liquidationPrice }
      : {}),
    ...(value.protectedFloorPnl !== undefined
      ? { protectedFloorPnl: value.protectedFloorPnl }
      : {}),
    ...(value.floorBufferDollars !== undefined
      ? { floorBufferDollars: value.floorBufferDollars }
      : {}),
    ...(value.highWaterPnl !== undefined ? { highWaterPnl: value.highWaterPnl } : {}),
    ...(value.lowWaterPnl !== undefined ? { lowWaterPnl: value.lowWaterPnl } : {}),
    ...(value.recoveryProbability !== undefined
      ? { recoveryProbability: value.recoveryProbability }
      : {}),
    ...(value.continuationLcbDollars !== undefined
      ? { continuationLcbDollars: value.continuationLcbDollars }
      : {}),
    ...(value.reversalCusum !== undefined ? { reversalCusum: value.reversalCusum } : {}),
    ...(value.zeroCrossings !== undefined ? { zeroCrossings: value.zeroCrossings } : {}),
    ...(value.pnlObservationCount !== undefined
      ? { pnlObservationCount: value.pnlObservationCount }
      : {}),
    ...(value.oppositeRegimeSince !== undefined
      ? { oppositeRegimeSince: value.oppositeRegimeSince }
      : {}),
    ...(value.oppositeRegimeObservationCount !== undefined
      ? { oppositeRegimeObservationCount: value.oppositeRegimeObservationCount }
      : {}),
    ...(value.optionContinuation
      ? { optionContinuation: { ...value.optionContinuation } }
      : {}),
  };
}

function sameOrderManagement(
  left: DashboardOrderDynamicsUpdate,
  right: DashboardOrderDynamicsUpdate,
): boolean {
  return sameMaterialOrderManagement(left, right);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = numberValue(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function tradingDashboardHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SPY + QQQ + GOOGL 0DTE Trading Dashboard</title><style>
:root{color-scheme:dark;--bg:#07111f;--panel:#0e1b2e;--line:#20324b;--text:#e7eef9;--muted:#91a4bd;--green:#35d07f;--red:#ff667a;--blue:#58a6ff;--amber:#f5c451}*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#06101c,#0a1830);color:var(--text);font:14px ui-sans-serif,system-ui,sans-serif}main{max-width:1500px;margin:auto;padding:24px}header{display:flex;justify-content:space-between;gap:18px;align-items:center;margin-bottom:18px}h1{font-size:24px;margin:0}h2{font-size:16px;margin:0 0 12px}.sub,.muted{color:var(--muted)}#state{display:flex;align-items:center;gap:8px;font-weight:700;padding:8px 12px;border:1px solid var(--line);border-radius:999px}.pulse-dot{width:9px;height:9px;border-radius:50%;background:currentColor;box-shadow:0 0 0 0 currentColor;animation:pulse 1.8s infinite}@keyframes pulse{70%{box-shadow:0 0 0 7px transparent}}.ok{color:var(--green)}.degraded{color:var(--amber)}.halted{color:var(--red)}.liveness-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:10px;margin-bottom:18px}.status-card{background:#0b192b;border:1px solid var(--line);border-radius:10px;padding:12px}.status-card .label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}.status-card strong{display:block;margin:5px 0 3px;font-size:14px}.status-detail{color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tabs{display:flex;gap:5px;border-bottom:1px solid var(--line);margin-bottom:16px}.tab{appearance:none;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted);font:inherit;font-weight:700;padding:11px 16px;cursor:pointer}.tab:hover{color:var(--text)}.tab.active{color:var(--blue);border-bottom-color:var(--blue)}.tab-panel{display:none}.tab-panel.active{display:block}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px;margin-bottom:18px}.card,.panel{background:rgba(14,27,46,.94);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 30px #0003}.card{padding:14px}.card .value{font-size:23px;font-weight:750;margin-top:6px}.card-detail{font-size:11px;margin-top:4px}.panel{padding:16px;margin:14px 0;overflow:auto}.live-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:14px}.live-card{background:linear-gradient(145deg,#12243d,#0b1729);border:1px solid #294262;border-radius:13px;padding:16px;min-width:0;box-shadow:inset 3px 0 0 var(--blue)}.live-card.profit{box-shadow:inset 3px 0 0 var(--green)}.live-card.loss{box-shadow:inset 3px 0 0 var(--red)}.live-card.completed{background:linear-gradient(145deg,#101d30,#091421)}.live-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.live-symbol{font-weight:750;font-size:16px;overflow-wrap:anywhere}.badge,.source{display:inline-block;margin-top:5px;padding:3px 7px;border-radius:999px;background:#58a6ff1c;color:var(--blue);font-size:11px;font-weight:700;letter-spacing:.04em}.source{margin:0}.live-pnl{text-align:right;font-size:22px;font-weight:800}.live-return{text-align:right;font-size:12px;margin-top:3px}.entry-quality{display:grid;gap:3px;border:1px solid var(--line);border-radius:8px;margin-top:13px;padding:9px 11px;background:#07111f80}.entry-quality strong{font-size:11px;letter-spacing:.05em}.entry-quality span{color:var(--muted);font-size:11px}.entry-quality.good{border-color:#35d07f66}.entry-quality.good strong{color:var(--green)}.entry-quality.good-entry-poor-exit,.entry-quality.marginal{border-color:#f5c45166}.entry-quality.good-entry-poor-exit strong,.entry-quality.marginal strong{color:var(--amber)}.entry-quality.poor{border-color:#ff667a66}.entry-quality.poor strong{color:var(--red)}.entry-quality.evaluating strong{color:var(--blue)}.entry-quality.not-rated strong{color:var(--muted)}.live-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:16px}.live-field span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}.live-field strong{font-size:14px}.order-strip{border-top:1px solid var(--line);margin-top:15px;padding-top:12px;display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:12px}.dynamics{border-top:1px solid var(--line);margin-top:14px;padding-top:12px}.dynamics-title{color:var(--muted);font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.05em;margin-bottom:7px}.dynamics-list{display:grid;gap:5px}.dynamics-columns,.dynamics-row{display:grid;grid-template-columns:108px minmax(140px,1fr) 82px 76px;gap:7px}.dynamics-columns{color:var(--muted);font-size:9px;font-weight:750;text-transform:uppercase;letter-spacing:.05em;padding:0 7px 4px}.dynamics-row{align-items:center;border-radius:6px;background:#07111f80;padding:7px;font-size:11px}.dynamics-row .dynamics-time,.dynamics-row .dynamics-state{color:var(--muted)}.dynamics-time{display:grid;gap:1px;white-space:nowrap;font-variant-numeric:tabular-nums}.dynamics-date{font-size:9px}.dynamics-clock{color:var(--text);font-size:10px}.dynamics-state-primary,.dynamics-state-change{display:block}.dynamics-state-change{color:var(--text);font-size:10px;margin-top:2px}.dynamics-row .dynamics-pnl,.dynamics-row .dynamics-change{text-align:right;font-variant-numeric:tabular-nums}.empty{color:var(--muted);padding:22px;text-align:center;border:1px dashed var(--line);border-radius:10px}.section-note{color:var(--muted);font-size:12px;margin:-6px 0 12px}.decision-reasons{max-width:560px;white-space:normal;line-height:1.45}.outcome{font-weight:750}.outcome.pass{color:var(--green)}.outcome.block{color:var(--amber)}.outcome.warn{color:var(--blue)}.tune-controls{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin-bottom:14px}.tune-control{display:grid;gap:5px}.tune-control label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}.tune-control select{min-width:150px;background:#0a1728;color:var(--text);border:1px solid var(--line);border-radius:7px;padding:8px 10px}.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:11px;margin:8px 0}.quality-status{font-weight:750}.quality-status.WIN,.quality-status.FILLED,.quality-status.OPEN{color:var(--green)}.quality-status.LOSS,.quality-status.BLOCKED{color:var(--red)}.quality-status.WORKING,.quality-status.NO_OPTION{color:var(--amber)}table{border-collapse:collapse;width:100%;min-width:850px}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}tbody tr:hover{background:#ffffff08}.positive{color:var(--green)}.negative{color:var(--red)}@media(max-width:700px){main{padding:14px}header{align-items:flex-start;flex-direction:column}.live-grid{grid-template-columns:1fr}.live-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.dynamics-columns,.dynamics-row{grid-template-columns:94px 1fr 72px}.dynamics-columns .dynamics-change,.dynamics-change{display:none}.tab{padding:10px}.tune-control{width:100%}.tune-control select{width:100%}}
</style><style>
.scope-bar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 18px;padding:12px 14px;background:#0b192b;border:1px solid var(--line);border-radius:10px}.scope-control{display:flex;align-items:center;gap:10px}.scope-control label{color:var(--muted);font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.05em}.scope-control select{min-width:180px;background:#07111f;color:var(--text);border:1px solid #355378;border-radius:8px;padding:8px 10px;font:inherit;font-weight:750}.scope-summary{color:var(--muted);font-size:12px}.management{margin-top:13px;border:1px solid #294262;border-radius:9px;background:#081526b8;padding:10px}.management-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px}.management-title{color:var(--muted);font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.05em}.management-badges{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}.management-badges .badge{margin:0}.management-badges .exit{background:#ff667a1c;color:var(--red)}.management-badges .protected{background:#35d07f1c;color:var(--green)}.management-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.management-detail{grid-column:1/-1;color:var(--muted);font-size:11px;line-height:1.45;overflow-wrap:anywhere}.order-strip{flex-direction:column}.order-strip-row{display:flex;justify-content:space-between;gap:10px}.order-strip-detail{color:var(--muted);font-size:11px;overflow-wrap:anywhere}.dynamics-state{white-space:normal;line-height:1.35}@media(max-width:700px){.scope-bar{align-items:flex-start;flex-direction:column}.scope-control{width:100%;justify-content:space-between}.scope-control select{flex:1}.management-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head><body><main><header><div><h1>0DTE Option Day-Trade Dashboard</h1><div class="sub">Isolated SIP signals · shared OPRA options · Alpaca paper execution · PostgreSQL history</div></div><div id="state"><span class="pulse-dot"></span><span id="stateText">Loading…</span></div></header>
<section class="scope-bar" aria-label="Underlying dashboard scope"><div class="scope-control"><label for="underlyingView">Dashboard scope</label><select id="underlyingView"><option value="ALL">All portfolio</option><option value="SPY">SPY only</option><option value="QQQ">QQQ only</option><option value="GOOGL">GOOGL only</option></select></div><div class="scope-summary" id="scopeSummary">Showing combined SPY + QQQ + GOOGL activity</div></section>
<section class="liveness-grid" aria-label="System liveness">
<div class="status-card"><div class="label">Engine heartbeat</div><strong id="engineState">Connecting</strong><div class="status-detail" id="engineDetail">Waiting for dashboard API</div></div>
<div class="status-card"><div class="label">Underlying SIP feeds</div><strong id="sipState">Connecting</strong><div class="status-detail" id="sipDetail">Waiting for stock stream</div></div>
<div class="status-card"><div class="label">OPRA option feed</div><strong id="opraState">Connecting</strong><div class="status-detail" id="opraDetail">Waiting for option stream</div></div>
<div class="status-card"><div class="label">PostgreSQL history</div><strong id="databaseState">Checking</strong><div class="status-detail" id="databaseDetail">Verifying market event writer</div></div>
<div class="status-card"><div class="label">Paper broker</div><strong id="brokerState">Checking</strong><div class="status-detail" id="brokerDetail">Verifying execution connection</div></div>
<div class="status-card"><div class="label">Market clock</div><strong id="marketState">Checking</strong><div class="status-detail" id="marketDetail">Waiting for broker clock</div></div>
<div class="status-card"><div class="label">Strategy state</div><strong id="strategyState">Restoring</strong><div class="status-detail" id="strategyDetail">Rebuilding session features</div></div>
</section>
<nav class="tabs" aria-label="Dashboard views"><button class="tab active" data-tab="tradingTab" aria-selected="true">Trading</button><button class="tab" data-tab="tuningTab" aria-selected="false">Entry &amp; Order Tuning</button><button class="tab" data-tab="liveDataTab" aria-selected="false">Live Data</button></nav>
<div class="tab-panel active" id="tradingTab">
<section class="cards">
<div class="card"><div class="muted">Signals Fired</div><div class="value" id="signalsFired">0</div></div>
<div class="card"><div class="muted">Options Selected</div><div class="value" id="optionsSelected">0</div><div class="muted card-detail" id="optionSelectionDetail">0% of signals</div></div>
<div class="card"><div class="muted">Risk Passed</div><div class="value" id="riskAllowed">0</div><div class="muted card-detail" id="riskDetail">0 blocked</div></div>
<div class="card"><div class="muted">Potential Missed Entries</div><div class="value" id="potentialMisses">0</div><div class="muted card-detail" id="potentialMissDetail">Waiting for +5s outcomes</div></div>
<div class="card"><div class="muted">Executable Selection Misses</div><div class="value" id="selectionMisses">0</div><div class="muted card-detail" id="selectionMissDetail">Waiting for +30s option bids</div></div>
<div class="card"><div class="muted">No-Signal Evaluations</div><div class="value" id="noSignalEvaluations">0</div><div class="muted card-detail" id="noSignalDetail">All decisions remain recorded</div></div>
<div class="card"><div class="muted">Entry Orders</div><div class="value" id="entryOrders">0</div></div>
<div class="card"><div class="muted">Filled Entries</div><div class="value" id="filledEntries">0</div></div>
<div class="card"><div class="muted">Closed Trades</div><div class="value" id="closedTrades">0</div></div>
<div class="card"><div class="muted">Win Rate</div><div class="value" id="winRate">0%</div></div>
<div class="card"><div class="muted">Realized P&amp;L</div><div class="value" id="pnl">$0.00</div></div>
<div class="card"><div class="muted">Open P&amp;L</div><div class="value" id="openPnl">$0.00</div></div>
<div class="card"><div class="muted">Total P&amp;L</div><div class="value" id="totalPnl">$0.00</div></div>
<div class="card"><div class="muted">Profit Factor</div><div class="value" id="profitFactor">—</div></div>
<div class="card"><div class="muted">Open Trades</div><div class="value" id="openTrades">0</div></div>
<div class="card"><div class="muted">Option Subs</div><div class="value" id="subscriptions">0</div></div>
</section>
<section class="panel"><h2>Orders</h2><div class="section-note">Cards show broker execution plus the order manager lifecycle, buffered soft and full winner-protection states, executable P&amp;L, profit floor, recovery and continuation evidence, exit triggers, urgency, and retries. The complete timeline is stored in PostgreSQL for order-history restoration.</div><div id="orderCards" class="live-grid"><div class="empty">Waiting for an option order…</div></div></section>
<section class="panel"><h2>Signal → Trade Funnel</h2><div class="section-note">A fired signal is not an order. Each row shows the selector version, option choice, risk, and submission status explicitly.</div><table><thead><tr><th>Time</th><th>Underlying</th><th>Version</th><th>Direction</th><th>Kind</th><th>Regime</th><th>Projected</th><th>Option</th><th>Risk</th><th>Status</th><th>Reason</th></tr></thead><tbody id="signals"></tbody></table></section>
<section class="panel"><h2>Potential Missed Entry Review</h2><div class="section-note">Hindsight diagnostic, not an automatic trade recommendation. A row appears only when directional gates produced NO SIGNAL and the same underlying subsequently moved at least ${MISSED_ENTRY_MOVE_THRESHOLD_BPS.toFixed(1)} bps in one direction over the ${MISSED_ENTRY_HORIZON_SEC}-second projection horizon. Consecutive rows are clustered per underlying for readability.</div><table><thead><tr><th>Evaluation</th><th>Underlying</th><th>Direction</th><th>Regime</th><th>Start</th><th>+${MISSED_ENTRY_HORIZON_SEC}s</th><th>Forward Move</th><th>Failed Gates / Votes</th><th>Decision Reason</th></tr></thead><tbody id="potentialMissRows"></tbody></table></section>
<section class="panel"><h2>Executable Option-Rejection Review</h2><div class="section-note">Rejected option candidates are judged causally from the decision ask to the first fresh bid near +${OPTION_SELECTION_OUTCOME_HORIZON_SEC} seconds. Positive values are gross, before fees. Missing or stale decision/forward quotes stay explicitly non-executable and never count as profitable misses.</div><table><thead><tr><th>Decision</th><th>Underlying</th><th>Option</th><th>Direction / Regime</th><th>Status</th><th>Decision Bid / Ask</th><th>Quote Age</th><th>+${OPTION_SELECTION_OUTCOME_HORIZON_SEC}s Bid</th><th>Gross P&amp;L / Contract</th><th>Selection / Diagnostic Reason</th></tr></thead><tbody id="selectionOpportunityRows"></tbody></table></section>
<section class="panel"><h2>Entry Gate Blocks</h2><div class="section-note">Counts every top-level reason that prevented an entry evaluation. This exposes global state failures such as incomplete opening-range recovery even when no hindsight row is created.</div><table><thead><tr><th>Gate / Reason</th><th>Blocked Evaluations</th><th>Share of Evaluations</th></tr></thead><tbody id="gateBlockRows"></tbody></table></section>
<section class="panel"><h2>Orders &amp; Executions</h2><table><thead><tr><th>Time</th><th>Underlying</th><th>Purpose</th><th>Option</th><th>Side</th><th>Qty</th><th>Limit</th><th>Filled</th><th>Avg Fill</th><th>Status</th></tr></thead><tbody id="orders"></tbody></table></section>
<section class="panel"><h2>Trade Performance</h2><table><thead><tr><th>Entry</th><th>Exit</th><th>Underlying</th><th>Option</th><th>Direction</th><th>Qty</th><th>Entry Px</th><th>Exit Px</th><th>P&amp;L</th><th>Return</th><th>Exit Reason</th><th>Status</th></tr></thead><tbody id="trades"></tbody></table></section>
</div>
<div class="tab-panel" id="tuningTab">
<section class="panel"><h2>Quality Filters</h2><div class="section-note">Compare like-for-like entries before changing thresholds. Small samples are directional evidence, not proof.</div><div class="tune-controls">
<div class="tune-control"><label for="tuneDirection">Direction</label><select id="tuneDirection"><option value="ALL">All directions</option></select></div>
<div class="tune-control"><label for="tuneRegime">Regime</label><select id="tuneRegime"><option value="ALL">All regimes</option></select></div>
<div class="tune-control"><label for="tuneOutcome">Outcome</label><select id="tuneOutcome"><option value="ALL">All outcomes</option></select></div>
<div class="tune-control"><label for="tuneBreakdown">Break down by</label><select id="tuneBreakdown"><option value="regime">Regime</option><option value="kind">Signal kind</option><option value="direction">Direction</option><option value="sessionBucket">Session time</option></select></div>
</div><div class="legend"><span>Slippage: positive = paid above decision ask</span><span>Improvement: positive = fill better than submitted limit</span><span>MFE / MAE: best / worst option-mid move observed after entry, including exit fills</span><span>Profit capture: winner return as a share of MFE; losses excluded</span><span>Times use causal audit timestamps</span></div></section>
<section class="cards">
<div class="card"><div class="muted">Filtered Signals</div><div class="value" id="tuneSignals">0</div></div>
<div class="card"><div class="muted">Fill Rate</div><div class="value" id="tuneFillRate">0%</div></div>
<div class="card"><div class="muted">Signal → Order</div><div class="value" id="tuneSignalOrder">—</div></div>
<div class="card"><div class="muted">Order → Fill</div><div class="value" id="tuneOrderFill">—</div></div>
<div class="card"><div class="muted">Entry Slippage</div><div class="value" id="tuneSlippage">—</div></div>
<div class="card"><div class="muted">Replacement Rate</div><div class="value" id="tuneReplacements">0%</div></div>
<div class="card"><div class="muted">Average MFE</div><div class="value" id="tuneMfe">—</div></div>
<div class="card"><div class="muted">Average MAE</div><div class="value" id="tuneMae">—</div></div>
<div class="card"><div class="muted">Winner Profit Capture</div><div class="value" id="tuneCapture">—</div></div>
</section>
<section class="panel"><h2>Entry Timing &amp; Quality</h2><div class="section-note">Trace each strategy signal through option selection, broker timing, execution cost, post-entry excursion, and final outcome.</div><table><thead><tr><th>Signal</th><th>Option / Setup</th><th>Status</th><th>Decision Bid / Ask</th><th>Spread</th><th>Signal → Order</th><th>Order → Fill</th><th>Fill</th><th>Slippage</th><th>Replaces</th><th>MFE</th><th>MAE</th><th>Return / P&amp;L</th><th>Exit</th></tr></thead><tbody id="tuningEntries"></tbody></table></section>
<section class="panel"><h2>Order Execution Quality</h2><div class="section-note">Initial versus final limits reveal chasing; first-fill and completion time reveal whether passive pricing is too slow.</div><table><thead><tr><th>Submitted</th><th>Purpose</th><th>Option</th><th>Qty</th><th>Initial Limit</th><th>Final Limit</th><th>Average Fill</th><th>Fill %</th><th>First Fill</th><th>Complete</th><th>Improvement</th><th>Replaces</th><th>Status</th></tr></thead><tbody id="tuningOrders"></tbody></table></section>
<section class="panel"><h2>Setup Comparison</h2><div class="section-note">Use sample count with fill, win, latency, slippage, and excursion together; do not optimize on P&amp;L alone.</div><table><thead><tr><th>Group</th><th>Signals</th><th>Filled</th><th>Fill Rate</th><th>Closed</th><th>Win Rate</th><th>Average P&amp;L</th><th>Average Return</th><th>Avg Slippage</th><th>Order → Fill</th><th>MFE</th><th>MAE</th></tr></thead><tbody id="tuningGroups"></tbody></table></section>
</div>
<div class="tab-panel" id="liveDataTab">
<section class="cards">
<div class="card"><div class="muted">Feed Events</div><div class="value" id="feedEvents">0</div></div>
<div class="card"><div class="muted">SIP Quotes</div><div class="value" id="sipQuotes">0</div></div>
<div class="card"><div class="muted">SIP Trades</div><div class="value" id="sipTrades">0</div></div>
<div class="card"><div class="muted">OPRA Quotes</div><div class="value" id="opraQuotes">0</div></div>
<div class="card"><div class="muted">Feature Decisions</div><div class="value" id="featureEvents">0</div></div>
<div class="card"><div class="muted">Latest Feed Age</div><div class="value" id="feedAge">—</div></div>
</section>
<section class="panel"><h2>Entry Evaluations &amp; Decisions</h2><div class="section-note">Every evaluation remains stored, but routine one-second NO SIGNAL rows are hidden by default. Use All evaluations only when diagnosing individual gates.</div><div class="tune-controls"><div class="tune-control"><label for="decisionView">Rows shown</label><select id="decisionView"><option value="ACTIONABLE">Actionable stages only</option><option value="ALL">All evaluations</option><option value="NO_SIGNAL">NO SIGNAL only</option></select></div></div><table><thead><tr><th>Time</th><th>Underlying</th><th>Stage</th><th>Outcome</th><th>Direction</th><th>Option</th><th>Decision</th><th>Gates, Votes &amp; Reasons</th></tr></thead><tbody id="decisions"></tbody></table></section>
<section class="panel"><h2>Live Feed Into System</h2><div class="section-note">The UI is sampled for readability. Provider latency subtracts the configured local-minus-provider clock offset; when non-zero, the raw timestamp delta is shown beside it. PostgreSQL retains quote baselines, full-resolution quotes for working/open options, and every trade, feature, decision, order, and fill.</div><table><thead><tr><th>Received</th><th>Feed</th><th>Type</th><th>Symbol</th><th>Value</th><th>Provider Latency</th><th>Storage Policy</th></tr></thead><tbody id="feedEventsBody"></tbody></table></section>
</div>
<div class="muted" id="updated"></div></main><script>
const $=id=>document.getElementById(id),money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n||0),optionalMoney=n=>Number.isFinite(n)?money(n):'—',num=(n,d=2)=>Number.isFinite(n)?n.toFixed(d):'—',count=n=>Number(n||0).toLocaleString(),time=n=>n?new Date(n).toLocaleString('en-US',{timeZone:'America/New_York'}):'—';
const underlyingSymbols=['SPY','QQQ','GOOGL'],underlyingFromSymbol=s=>{const value=String(s||'').replaceAll(' ','').toUpperCase();if(underlyingSymbols.includes(value))return value;const match=/^([A-Z]{1,6})\d{6}[CP]\d{8}$/.exec(value);return match&&underlyingSymbols.includes(match[1])?match[1]:'UNKNOWN'},itemUnderlying=x=>x?.underlying||underlyingFromSymbol(x?.symbol||x?.candidate||x?.closestCandidate);
function cell(value,cls=''){const td=document.createElement('td');td.textContent=String(value??'—');if(cls)td.className=cls;return td}function rows(id,data,fields,empty=''){const body=$(id);if(data.length===0&&empty){const tr=document.createElement('tr'),td=cell(empty,'muted');td.colSpan=fields.length;tr.append(td);body.replaceChildren(tr);return}body.replaceChildren(...data.map(item=>{const tr=document.createElement('tr');for(const field of fields){const result=field(item);tr.append(cell(result.value,result.cls||''))}return tr}))}
function node(tag,cls,text){const value=document.createElement(tag);if(cls)value.className=cls;if(text!==undefined)value.textContent=String(text);return value}function field(label,value){const wrap=node('div','live-field'),caption=node('span','',label),content=node('strong','',value);wrap.append(caption,content);return wrap}function duration(ms){if(!Number.isFinite(ms))return '—';const seconds=Math.floor(ms/1000),minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60);return hours>0?hours+'h '+(minutes%60)+'m':minutes>0?minutes+'m '+(seconds%60)+'s':seconds+'s'}
function orderFullTime(timestamp){return Number.isFinite(timestamp)?new Date(timestamp).toLocaleString('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,timeZoneName:'short'}):'—'}
function monitoredTimeNode(timestamp){const at=node('time','dynamics-time');if(!Number.isFinite(timestamp)){at.textContent='—';return at}const value=new Date(timestamp);at.dateTime=value.toISOString();at.title=orderFullTime(timestamp);at.append(node('span','dynamics-date',value.toLocaleDateString('en-US',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',year:'numeric'})),node('strong','dynamics-clock',value.toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3})));return at}
function monitorChanges(update,previous){if(!previous)return 'Monitoring started';const changes=[],pretty=value=>String(value).replaceAll('_',' '),add=(key,label,format=pretty)=>{const value=update[key],before=previous[key];if(JSON.stringify(value)===JSON.stringify(before))return;changes.push(label+' → '+(value===undefined?'cleared':format(value)))};add('stage','Stage');add('status','Broker');add('lifecycle','Lifecycle');add('tradeState','State');add('managementDecision','Decision');add('managementReason','Reason');add('remainingQuantity','Position',value=>value+' remaining');add('currentBid','Bid',money);add('currentAsk','Ask',money);add('realizedPnl','Realized',money);add('executablePnl','Executable P&L',money);add('protectedFloorPnl','Floor',money);add('floorBufferDollars','Buffer',money);add('highWaterPnl','High water',money);add('lowWaterPnl','Low water',money);add('recoveryProbability','Recovery',value=>percent(100*value,1));add('continuationLcbDollars','Continuation LCB',money);add('reversalCusum','Reversal CUSUM',value=>num(value));add('zeroCrossings','Crossings',String);add('pnlObservationCount','Observations',String);if(JSON.stringify(update.exitTriggers||[])!==JSON.stringify(previous.exitTriggers||[]))changes.push('Triggers → '+((update.exitTriggers||[]).map(pretty).join(' · ')||'cleared'));if(JSON.stringify(update.optionContinuation||null)!==JSON.stringify(previous.optionContinuation||null))changes.push('Continuation model updated');return changes.join(' · ')||'Timestamped monitor sample'}
function renderOrders(items){
const root=$('orderCards');
if(!items||items.length===0){root.replaceChildren(node('div','empty','No option orders have been recorded.'));return}
const cards=items.map(x=>{
const updates=x.updates||[],latestMonitoredAt=updates.reduce((latest,update)=>Math.max(latest,update.timestamp||0),0)||x.entryTimestamp,pnl=x.totalPnl===undefined?x.unrealizedPnl:x.totalPnl,pnlClass=pnl>0?'positive':pnl<0?'negative':'',card=node('article','live-card '+(x.active?'':'completed ')+(pnl>0?'profit':pnl<0?'loss':'')),head=node('div','live-head'),identity=node('div'),symbol=node('div','live-symbol',x.symbol),badge=node('div','badge',x.stage.replaceAll('_',' ')),pnlBox=node('div'),pnlValue=node('div','live-pnl '+pnlClass,pnl===undefined?'AWAITING FILL':money(pnl)),returnLabel=x.active?' open return':' final return',pnlReturn=node('div','live-return '+pnlClass,x.unrealizedReturnPct===undefined?(x.active?'P&L from executable bid':'Completed order'):num(x.unrealizedReturnPct)+'%'+returnLabel);
identity.append(symbol,node('div','source',itemUnderlying(x)),badge);pnlBox.append(pnlValue,pnlReturn);head.append(identity,pnlBox);
const qualityKey=x.entryQuality||'NOT_RATED',qualityClass=qualityKey.toLowerCase().replaceAll('_','-'),quality=node('div','entry-quality '+qualityClass),qualityLabel=node('strong','','ENTRY QUALITY · '+qualityKey.replaceAll('_',' ')),qualityReason=node('span','',x.entryQualityReason||'No quality classification is available.');
quality.append(qualityLabel,qualityReason);
const management=node('div','management'),managementHead=node('div','management-head'),managementTitle=node('div','management-title','Order manager'),managementBadges=node('div','management-badges'),lifecycleBadge=node('span','badge',(x.lifecycle||x.stage).replaceAll('_',' ')),tradeState=x.tradeState||(x.stage==='ENTRY_WORKING'?'AWAITING FILL':'STATE NOT RECORDED'),tradeClass=tradeState.startsWith('PROTECTED')?'badge protected':'badge',tradeBadge=node('span',tradeClass,tradeState.replaceAll('_',' ')),decision=x.managementDecision||(x.stage==='ENTRY_WORKING'?'DECISION PENDING':'DECISION NOT RECORDED'),decisionBadge=node('span','badge '+(decision==='EXIT'?'exit':''),decision.replaceAll('_',' '));
managementBadges.append(lifecycleBadge,tradeBadge,decisionBadge);managementHead.append(managementTitle,managementBadges);
const managementGrid=node('div','management-grid');
managementGrid.append(
field('Executable P&L',x.executablePnl===undefined?'—':money(x.executablePnl)),
field('Liquidation',x.liquidationPrice===undefined?'—':money(x.liquidationPrice)),
field('Profit floor',x.protectedFloorPnl===undefined?'Not active':money(x.protectedFloorPnl)),
field('Floor buffer',x.floorBufferDollars===undefined?'—':money(x.floorBufferDollars)),
field('Recovery',x.recoveryProbability===undefined?'—':percent(100*x.recoveryProbability,1)),
field('Continuation LCB',x.continuationLcbDollars===undefined?'—':money(x.continuationLcbDollars)),
field('Reversal CUSUM',num(x.reversalCusum)),
field('MFE / MAE',(x.highWaterPnl===undefined?'—':money(x.highWaterPnl))+' / '+(x.lowWaterPnl===undefined?'—':money(x.lowWaterPnl))),
field('Observations',(x.pnlObservationCount??0)+' · '+(x.zeroCrossings??0)+' crossings')
);
const managementDetails=[];
if(x.managementReason)managementDetails.push('Reason: '+x.managementReason.replaceAll('_',' '));
if((x.exitTriggers||[]).length)managementDetails.push('Triggers: '+x.exitTriggers.map(value=>value.replaceAll('_',' ')).join(' · '));
if(x.optionContinuation){const o=x.optionContinuation,greeksStatus=o.providerGreeksAvailable===false?' · MODELED ONLY · NOT EXIT ELIGIBLE':o.providerGreeksAvailable===true?' · PROVIDER GREEKS':'';managementDetails.push('Greeks $: Δ '+optionalMoney(o.deltaDollars)+' · Γ '+optionalMoney(o.gammaDollars)+' · Vega '+optionalMoney(o.vegaDollars)+' · Theta '+optionalMoney(o.thetaDollars)+' · cost '+optionalMoney(o.holdingCostDollars)+' · uncertainty '+optionalMoney(o.uncertaintyDollars)+(o.ivCrushDetected?' · IV CRUSH':'')+greeksStatus)}
management.append(managementHead,managementGrid);
if(managementDetails.length)management.append(node('div','management-detail',managementDetails.join(' | ')));
const fields=node('div','live-fields');
fields.append(field('Position',x.remainingQuantity+' / '+x.quantity+' contracts'),field('Entry',x.entryPrice===undefined?'—':money(x.entryPrice)),field(x.active?'Bid / Ask':'Exit',x.active?(x.currentBid===undefined?'—':money(x.currentBid)+' / '+money(x.currentAsk)):(x.exitPrice===undefined?'—':money(x.exitPrice))),field('Hard stop',x.stopPrice===undefined?'—':money(x.stopPrice)),field('Protected floor',x.protectedFloorPnl===undefined?'—':money(x.protectedFloorPnl)),field('Elapsed',duration(x.elapsedMs)),field('Realized',money(x.realizedPnl)),field(x.active?'Quote age':'Exit reason',x.active?(x.quoteAgeMs===undefined?'Waiting for quote':duration(x.quoteAgeMs)):(x.exitReason||x.managementReason||x.status)),field('Direction',x.direction||'Pending entry'));
fields.append(field('Entry time (ET)',orderFullTime(x.entryTimestamp)),field('Last monitored (ET)',orderFullTime(latestMonitoredAt)));
if(!x.active)fields.append(field('Exit time (ET)',orderFullTime(x.exitTimestamp)));
card.append(head,quality,management,fields);
if(x.workingOrder){const order=x.workingOrder,strip=node('div','order-strip'),row=node('div','order-strip-row'),left=node('span','',order.purpose+' '+order.status+' · '+order.filledQuantity+'/'+order.requestedQuantity+' filled'),right=node('span','',money(order.limitPrice)+' limit · '+order.replacements+' replaces'),details=[],triggerText=(order.triggers||x.exitTriggers||[]).map(value=>value.replaceAll('_',' ')).join(' · ');row.append(left,right);if(order.urgency!==undefined)details.push('urgency '+percent(100*order.urgency,0));if(order.actionTtlMs!==undefined)details.push('TTL '+order.actionTtlMs+' ms');if(order.priceCollar!==undefined)details.push('collar '+money(order.priceCollar));if(order.attempt!==undefined)details.push('attempt '+order.attempt);if(order.exitIntentId)details.push('intent '+order.exitIntentId);strip.append(row);if(details.length)strip.append(node('div','order-strip-detail',details.join(' · ')));if(triggerText)strip.append(node('div','order-strip-detail','Exit triggers · '+triggerText));card.append(strip)}
const explicitControllerEvaluations=updates.filter(update=>update.source==='CONTROLLER').length,legacyControllerEvaluations=explicitControllerEvaluations?0:new Set(updates.filter(update=>update.source==='STATUS'&&update.managementDecision&&update.lifecycle!=='CLOSED'&&update.optionContinuation).map(update=>update.timestamp)).size,controllerEvaluations=explicitControllerEvaluations||legacyControllerEvaluations,pnlObservations=updates.reduce((maximum,update)=>Number.isFinite(update.pnlObservationCount)?Math.max(maximum,update.pnlObservationCount):maximum,0),managerPhases=updates.reduce((summary,update)=>{if(!update.managementDecision)return summary;const key=JSON.stringify([update.tradeState,update.managementDecision,update.managementReason,update.exitTriggers||[]]);if(key!==summary.key){summary.count+=1;summary.key=key}return summary},{count:0,key:''}).count,summaryParts=[updates.length+' durable updates'];if(controllerEvaluations)summaryParts.push(controllerEvaluations+' controller evaluations');if(pnlObservations)summaryParts.push(pnlObservations+' changed-P&L observations');if(managerPhases)summaryParts.push(managerPhases+' manager decision phases');const dynamics=node('div','dynamics'),title=node('div','dynamics-title','Timestamped durable timeline · '+summaryParts.join(' · ')),columns=node('div','dynamics-columns'),list=node('div','dynamics-list');
columns.append(node('span','','Event time (ET)'),node('span','','Monitored change'),node('span','','P&L'),node('span','dynamics-change','Change'));
const timeline=updates.map((update,index)=>({update,previous:updates[index-1]})).reverse();
for(const item of timeline){const update=item.update,total=update.totalPnl===undefined?update.unrealizedPnl:update.totalPnl,change=update.pnlChange,row=node('div','dynamics-row'),at=monitoredTimeNode(update.timestamp),sourceLabel=update.source==='PNL'?'P&L observation':update.source==='CONTROLLER'?'Controller evaluation':'Status update',stateParts=[sourceLabel,update.tradeState||update.lifecycle||update.stage,update.managementDecision||update.status];if(update.managementReason)stateParts.push(update.managementReason);const state=node('span','dynamics-state'),statePrimary=node('span','dynamics-state-primary',stateParts.map(value=>String(value).replaceAll('_',' ')).join(' · ')),stateChange=node('span','dynamics-state-change',monitorChanges(update,item.previous)),value=node('span','dynamics-pnl '+(total>0?'positive':total<0?'negative':''),total===undefined?(update.executablePnl===undefined?'—':money(update.executablePnl)):money(total)),delta=node('span','dynamics-change '+(change>0?'positive':change<0?'negative':''),change===undefined?'—':(change>0?'+':'')+money(change));state.append(statePrimary,stateChange);row.append(at,state,value,delta);list.append(row)}
if(updates.length===0)list.append(node('div','muted','Waiting for the first P&L, controller, or broker-state update.'));
dynamics.append(title,columns,list);card.append(dynamics);return card});
root.replaceChildren(...cards)
}
function setStatus(valueId,detailId,value,detail,level){$(valueId).textContent=value;$(valueId).className=level;$(detailId).textContent=detail}function age(ms){return Number.isFinite(ms)?duration(ms)+' ago':'No events yet'}function storagePolicy(event,live){if(!live.persistenceEnabled)return 'Disabled';if(event.type==='stock_quote'||event.type==='option_quote')return (live.quoteSampleIntervalMs||0)+' ms baseline · active option full';return 'Full retention'}
function feedLatency(event,live){const corrected=latency(event.latencyMs);return Number(live.marketDataClockOffsetMs||0)===0?corrected:corrected+' corrected · raw '+latency(event.rawLatencyMs)}
function outcomeClass(value){return ['SIGNAL','SELECTED','ALLOWED','SUBMITTED','REQUESTED','FILLED'].includes(value)?'outcome pass':['NO_SIGNAL','NO_ELIGIBLE_OPTION','BLOCKED','SKIPPED'].includes(value)?'outcome block':value==='RETRYING'?'outcome warn':'outcome'}
function decisionDetail(item){const details=[...(item.reasons||[])];for(const direction of item.directions||[]){const failedVotes=(direction.votes||[]).filter(v=>!v.passed).map(v=>v.name);const result=direction.passed?'PASS':(direction.reasons||[]).slice(0,6).join(', ');details.push(direction.direction+': '+result+(failedVotes.length?' · failed votes '+failedVotes.join(', '):''))}return details.join(' · ')||'All configured gates passed'}
let latestDecisions=[];
function renderDecisionRows(items){latestDecisions=items||[];const view=$('decisionView').value,filtered=view==='ALL'?latestDecisions:view==='NO_SIGNAL'?latestDecisions.filter(x=>x.stage==='ENTRY_EVALUATION'&&x.outcome==='NO_SIGNAL'):latestDecisions.filter(x=>!(x.stage==='ENTRY_EVALUATION'&&x.outcome==='NO_SIGNAL'));rows('decisions',filtered,[x=>({value:time(x.timestamp)}),x=>({value:itemUnderlying(x)}),x=>({value:x.stage.replaceAll('_',' ')}),x=>({value:x.outcome.replaceAll('_',' '),cls:outcomeClass(x.outcome)}),x=>({value:x.direction}),x=>({value:x.symbol}),x=>({value:x.summary}),x=>({value:decisionDetail(x),cls:'decision-reasons'})],view==='ACTIONABLE'?'No actionable signal, option-selection, risk, or order events yet. Routine NO SIGNAL evaluations remain recorded.':'No evaluations match this view.')}
function renderPotentialMisses(tuning){const summary=tuning?.falseNegativeSummary||{evaluations:0,noSignalEvaluations:0,matureNoSignalEvaluations:0,potentialMisses:0,potentialMissRate:0,horizonSec:5,thresholdBps:2,gateBlocks:[]},misses=tuning?.potentialMisses||[],optionSummary=tuning?.optionSelectionOpportunitySummary||{rejectedSelections:0,pending:0,evaluated:0,profitableMisses:0,correctRejections:0,nonExecutable:0,profitableMissRate:0,horizonSec:30},optionOutcomes=tuning?.optionSelectionOpportunities||[];$('potentialMisses').textContent=count(summary.potentialMisses);$('potentialMisses').className='value '+(summary.potentialMisses>0?'negative':'positive');$('potentialMissDetail').textContent=count(summary.potentialMisses)+' of '+count(summary.matureNoSignalEvaluations)+' mature · '+percent(100*summary.potentialMissRate,2);$('selectionMisses').textContent=count(optionSummary.profitableMisses);$('selectionMisses').className='value '+(optionSummary.profitableMisses>0?'negative':'positive');$('selectionMissDetail').textContent=count(optionSummary.profitableMisses)+' profitable · '+count(optionSummary.correctRejections)+' protected · '+count(optionSummary.nonExecutable)+' non-executable';$('noSignalEvaluations').textContent=count(summary.noSignalEvaluations);$('noSignalDetail').textContent=count(summary.matureNoSignalEvaluations)+' have a +'+summary.horizonSec+'s outcome';rows('potentialMissRows',misses,[x=>({value:time(x.timestamp)}),x=>({value:x.underlying||'SPY'}),x=>({value:x.direction,cls:x.direction==='BULLISH'?'positive':'negative'}),x=>({value:String(x.regime).replaceAll('_',' ')}),x=>({value:num(x.price)}),x=>({value:num(x.forwardPrice)}),x=>({value:signedBps(x.forwardMoveBps),cls:x.forwardMoveBps>0?'positive':'negative'}),x=>({value:(x.failedGates||[]).join(' · '),cls:'decision-reasons'}),x=>({value:(x.reasons||[]).join(' · '),cls:'decision-reasons'})],'No potential hindsight misses detected at the '+summary.horizonSec+'-second / '+num(summary.thresholdBps,1)+'-bps review threshold.');rows('selectionOpportunityRows',optionOutcomes,[x=>({value:time(x.timestamp)}),x=>({value:x.underlying||'SPY'}),x=>({value:x.symbol}),x=>({value:x.direction+' · '+String(x.regime).replaceAll('_',' ')}),x=>({value:String(x.status).replaceAll('_',' '),cls:x.status==='PROFITABLE_MISS'?'negative':x.status==='CORRECT_REJECTION'?'positive':'muted'}),x=>({value:x.decisionAsk===undefined?'—':money(x.decisionBid)+' / '+money(x.decisionAsk)}),x=>({value:latency(x.decisionProviderAgeMs)}),x=>({value:x.forwardBid===undefined?'—':money(x.forwardBid)}),x=>({value:x.grossExecutablePnlPerContract===undefined?'—':money(x.grossExecutablePnlPerContract),cls:x.grossExecutablePnlPerContract>0?'positive':x.grossExecutablePnlPerContract<0?'negative':''}),x=>({value:[...(x.reasons||[]),...(x.diagnosticReasons||[])].join(' · '),cls:'decision-reasons'})],'No rejected option candidates have reached an executable '+optionSummary.horizonSec+'-second review.');rows('gateBlockRows',summary.gateBlocks||[],[x=>({value:String(x.reason).replaceAll('_',' '),cls:'decision-reasons'}),x=>({value:count(x.count)}),x=>({value:percent(summary.evaluations>0?100*x.count/summary.evaluations:0,1)})],'No entry gates have blocked an evaluation.')}
let scheduledDisplayRolloverAt=0,displayRolloverTimer;
function scheduleDisplayRollover(timestamp){if(!Number.isFinite(timestamp)||timestamp===scheduledDisplayRolloverAt)return;scheduledDisplayRolloverAt=timestamp;if(displayRolloverTimer)clearTimeout(displayRolloverTimer);const delay=Math.max(0,timestamp-Date.now()+250);displayRolloverTimer=setTimeout(()=>window.location.reload(),Math.min(delay,2147483647))}
const percent=(value,d=1)=>Number.isFinite(value)?num(value,d)+'%':'—',latency=value=>!Number.isFinite(value)?'—':value<1000?Math.round(value)+' ms':value<60000?num(value/1000,2)+' s':duration(value),signedBps=value=>Number.isFinite(value)?(value>0?'+':'')+num(value,1)+' bps':'—';
function tuneAverage(values){const finite=values.filter(Number.isFinite);return finite.length?finite.reduce((sum,value)=>sum+value,0)/finite.length:undefined}
function tuneStats(items){const submitted=items.filter(x=>x.orderTimestamp!==undefined),filled=submitted.filter(x=>x.firstFillTimestamp!==undefined),closed=items.filter(x=>['WIN','LOSS','FLAT'].includes(x.status));return{signals:items.length,submitted:submitted.length,filled:filled.length,closed:closed.length,fillRate:submitted.length?filled.length/submitted.length:0,replacementRate:submitted.length?submitted.filter(x=>(x.replacements||0)>0).length/submitted.length:0,winRate:closed.length?closed.filter(x=>x.status==='WIN').length/closed.length:0,avgPnl:tuneAverage(closed.map(x=>x.realizedPnl)),avgReturn:tuneAverage(closed.map(x=>x.returnPct)),avgSignalOrder:tuneAverage(items.map(x=>x.signalToOrderMs)),avgOrderFill:tuneAverage(items.map(x=>x.orderToFirstFillMs)),avgSlippage:tuneAverage(items.map(x=>x.entrySlippageBps)),avgMfe:tuneAverage(items.map(x=>x.maxFavorableExcursionPct)),avgMae:tuneAverage(items.map(x=>x.maxAdverseExcursionPct)),avgCapture:tuneAverage(items.map(x=>x.capturePct))}}
function updateSelect(id,values,label){const select=$(id),current=select.value,unique=[...new Set(values.filter(Boolean))].sort(),all=document.createElement('option');all.value='ALL';all.textContent=label;select.replaceChildren(all,...unique.map(value=>{const option=document.createElement('option');option.value=value;option.textContent=value.replaceAll('_',' ');return option}));select.value=unique.includes(current)?current:'ALL'}
let latestTuning={entries:[]},latestQualityOrders=[];
function renderTuning(tuning,orders){latestTuning=tuning||{entries:[]};latestQualityOrders=orders||[];const all=latestTuning.entries||[];updateSelect('tuneDirection',all.map(x=>x.direction),'All directions');updateSelect('tuneRegime',all.map(x=>x.regime),'All regimes');updateSelect('tuneOutcome',all.map(x=>x.status),'All outcomes');const direction=$('tuneDirection').value,regime=$('tuneRegime').value,outcome=$('tuneOutcome').value,items=all.filter(x=>(direction==='ALL'||x.direction===direction)&&(regime==='ALL'||x.regime===regime)&&(outcome==='ALL'||x.status===outcome)),stats=tuneStats(items);$('tuneSignals').textContent=count(stats.signals);$('tuneFillRate').textContent=percent(100*stats.fillRate);$('tuneSignalOrder').textContent=latency(stats.avgSignalOrder);$('tuneOrderFill').textContent=latency(stats.avgOrderFill);$('tuneSlippage').textContent=signedBps(stats.avgSlippage);$('tuneSlippage').className='value '+(stats.avgSlippage>0?'negative':Number.isFinite(stats.avgSlippage)?'positive':'');$('tuneReplacements').textContent=percent(100*stats.replacementRate);$('tuneMfe').textContent=percent(stats.avgMfe);$('tuneMfe').className='value '+(stats.avgMfe>0?'positive':'');$('tuneMae').textContent=percent(stats.avgMae);$('tuneMae').className='value '+(stats.avgMae<0?'negative':'');$('tuneCapture').textContent=percent(stats.avgCapture);
rows('tuningEntries',items,[x=>({value:time(x.signalTimestamp)}),x=>({value:itemUnderlying(x)+' · '+(x.symbol||'No option')+' · '+x.direction+' '+x.kind+' · '+x.regime}),x=>({value:x.status,cls:'quality-status '+x.status}),x=>({value:x.decisionBid===undefined?'—':money(x.decisionBid)+' / '+money(x.decisionAsk)}),x=>({value:x.decisionSpreadPct===undefined?'—':percent(100*x.decisionSpreadPct,2)}),x=>({value:latency(x.signalToOrderMs)}),x=>({value:latency(x.orderToFirstFillMs)}),x=>({value:x.averageFillPrice===undefined?'—':money(x.averageFillPrice)}),x=>({value:signedBps(x.entrySlippageBps),cls:x.entrySlippageBps>0?'negative':Number.isFinite(x.entrySlippageBps)?'positive':''}),x=>({value:x.replacements??'—'}),x=>({value:percent(x.maxFavorableExcursionPct),cls:x.maxFavorableExcursionPct>0?'positive':''}),x=>({value:percent(x.maxAdverseExcursionPct),cls:x.maxAdverseExcursionPct<0?'negative':''}),x=>({value:x.returnPct===undefined?'—':percent(x.returnPct)+' / '+money(x.realizedPnl),cls:x.realizedPnl>0?'positive':x.realizedPnl<0?'negative':''}),x=>({value:(x.exitReason||'—')+(x.holdMs===undefined?'':' · '+duration(x.holdMs))})],'No strategy entries match these filters.');
const ids=new Set(items.map(x=>x.signalId)),filteredOrders=latestQualityOrders.filter(order=>direction==='ALL'&&regime==='ALL'&&outcome==='ALL'||(order.signalId&&ids.has(order.signalId)));rows('tuningOrders',filteredOrders,[x=>({value:time(x.timestamp)}),x=>({value:x.purpose}),x=>({value:x.symbol}),x=>({value:x.filledQuantity+' / '+x.quantity}),x=>({value:money(x.initialLimitPrice)}),x=>({value:money(x.limitPrice)}),x=>({value:x.averageFillPrice===undefined?'—':money(x.averageFillPrice)}),x=>({value:percent(x.fillPercentage)}),x=>({value:latency(x.firstFillLatencyMs)}),x=>({value:latency(x.completionLatencyMs)}),x=>({value:signedBps(x.priceImprovementBps),cls:x.priceImprovementBps>0?'positive':x.priceImprovementBps<0?'negative':''}),x=>({value:x.replacements}),x=>({value:x.status})],'No orders match these filters.');
const key=$('tuneBreakdown').value,groups=new Map();for(const item of items){const label=item[key]||'UNKNOWN';if(!groups.has(label))groups.set(label,[]);groups.get(label).push(item)}const compared=[...groups.entries()].map(([label,group])=>({label,...tuneStats(group)})).sort((a,b)=>b.signals-a.signals);rows('tuningGroups',compared,[x=>({value:String(x.label).replaceAll('_',' ')}),x=>({value:x.signals}),x=>({value:x.filled}),x=>({value:percent(100*x.fillRate)}),x=>({value:x.closed}),x=>({value:percent(100*x.winRate)}),x=>({value:money(x.avgPnl),cls:x.avgPnl>0?'positive':x.avgPnl<0?'negative':''}),x=>({value:percent(x.avgReturn),cls:x.avgReturn>0?'positive':x.avgReturn<0?'negative':''}),x=>({value:signedBps(x.avgSlippage),cls:x.avgSlippage>0?'negative':x.avgSlippage<0?'positive':''}),x=>({value:latency(x.avgOrderFill)}),x=>({value:percent(x.avgMfe),cls:x.avgMfe>0?'positive':''}),x=>({value:percent(x.avgMae),cls:x.avgMae<0?'negative':''})],'No grouped samples match these filters.')}
document.querySelectorAll('.tab').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(tab=>{const active=tab===button;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active))});document.querySelectorAll('.tab-panel').forEach(panel=>panel.classList.toggle('active',panel.id===button.dataset.tab))}));
['tuneDirection','tuneRegime','tuneOutcome','tuneBreakdown'].forEach(id=>$(id).addEventListener('change',()=>renderTuning(latestTuning,latestQualityOrders)));
$('decisionView').addEventListener('change',()=>renderDecisionRows(latestDecisions));
try{const saved=localStorage.getItem('dashboardUnderlying');if(['ALL',...underlyingSymbols].includes(saved))$('underlyingView').value=saved}catch{}
$('underlyingView').addEventListener('change',()=>{try{localStorage.setItem('dashboardUnderlying',$('underlyingView').value)}catch{}refresh()});
async function refresh(){
try{
const response=await fetch('/api/dashboard',{cache:'no-store'});if(!response.ok)throw new Error('Dashboard API '+response.status);
const data=await response.json(),selected=$('underlyingView').value,view=selected==='ALL'?data:(data.underlyingViews||{})[selected]||{performance:{},liveData:{eventCounts:{},recentEvents:[]},tuning:{entries:[]},signals:[],orders:[],trades:[],decisions:[],orderCards:[],activeOrders:[]},p=view.performance||{},aggregateHealth=data.health||{},symbolHealth=(aggregateHealth.underlyingStates||{})[selected],h=selected==='ALL'?aggregateHealth:(symbolHealth||{ready:false,brokerRequired:false,websocketConnected:false,brokerAvailable:false,marketClockState:'disabled',openOrderCount:0,positionsReconciled:true,recorderHealthy:aggregateHealth.recorderHealthy!==false,killSwitch:false}),live=view.liveData||{eventCounts:{},recentEvents:[],totalEvents:0,uptimeMs:0,persistenceEnabled:false,quoteSampleIntervalMs:0,retentionDays:0},readiness=selected==='ALL'?(data.readiness||'degraded'):!symbolHealth?'degraded':h.killSwitch||!h.positionsReconciled||!h.recorderHealthy?'halted':!h.ready||(!h.websocketConnected&&!h.marketDataIdle)||(h.brokerRequired!==false&&!h.brokerAvailable)?'degraded':'ok';
scheduleDisplayRollover(data.nextDisplayRolloverAt);
$('scopeSummary').textContent=selected==='ALL'?'Showing combined SPY + QQQ + GOOGL portfolio activity':symbolHealth?'Showing isolated '+selected+' strategy, execution, P&L, tuning, feeds, and health':selected+' is not enabled in this process';
$('stateText').textContent=selected+' · '+readiness.toUpperCase()+' · '+(h.executionMode||aggregateHealth.executionMode||'paper');$('state').className=readiness;
setStatus('engineState','engineDetail','LIVE','API heartbeat · uptime '+duration(live.uptimeMs),'ok');
const marketIdle=h.marketDataIdle===true,stockConnected=h.stockWebsocketConnected??h.websocketConnected,sipQuotes=h.receivedStockQuotes??live.eventCounts.stock_quote??0,sipTrades=h.receivedStockTrades??live.eventCounts.stock_trade??0,sipLive=sipQuotes+sipTrades;
setStatus('sipState','sipDetail',marketIdle?'IDLE':stockConnected?'CONNECTED':'DISCONNECTED',count(sipQuotes)+' live quotes · '+count(sipTrades)+' live trades · quote '+age(h.lastStockQuoteAgeMs),marketIdle||stockConnected?'ok':'halted');
const subscriptions=h.subscribedOptionContracts||0,opraQuotes=h.receivedOptionQuotes??live.eventCounts.option_quote??0,opraTrades=h.receivedOptionTrades??live.eventCounts.option_trade??0,opraAggregates=h.receivedOptionAggregates??live.eventCounts.option_aggregate??0,opraRequired=h.optionSubscriptionsRequired===true,opraSubscriptionIdle=h.marketClockState==='market-open'&&subscriptions===0&&h.optionSubscriptionsRequired===false,opraStalled=h.optionQuoteStalled===true,opraPrimed=h.optionQuotePrimed!==false,opraDiagnosis=h.optionQuoteDiagnosis||(h.optionQuoteProviderLagged?'PROVIDER_DELAYED':opraPrimed?'HEALTHY':'NO_DATA'),opraConnected=h.optionWebsocketConnected===true,opraState=marketIdle||opraSubscriptionIdle?'IDLE':opraStalled||opraDiagnosis==='TRANSPORT_DISCONNECTED'?'STALLED':opraDiagnosis==='PROVIDER_DELAYED'?'PROVIDER DELAYED':opraDiagnosis==='OLD_EVENT_ARRIVED'?'OLD EVENT':opraDiagnosis==='CONTRACT_IDLE'?'CONTRACT IDLE':opraDiagnosis==='NO_DATA'?'WARMING':opraConnected?'CONNECTED':opraRequired?'DISCONNECTED':'STANDBY',opraLevel=marketIdle||opraSubscriptionIdle?'ok':opraStalled||opraDiagnosis==='TRANSPORT_DISCONNECTED'||opraDiagnosis==='PROVIDER_DELAYED'||opraDiagnosis==='OLD_EVENT_ARRIVED'?'halted':opraDiagnosis==='CONTRACT_IDLE'||opraDiagnosis==='NO_DATA'?'degraded':opraConnected?'ok':opraRequired?'halted':'degraded',opraError=opraStalled&&h.lastStreamError?' · '+h.lastStreamError:'';
const restFallback=h.optionRestFallbackEnabled?(' · REST diagnostic '+age(h.lastOptionRestQuoteProviderAgeMs)+' · '+count(h.optionRestFallbackFreshQuotes)+' fresh/'+count(h.optionRestFallbackRequests)+' requests · circuit '+(h.optionRestCircuitState||'CLOSED')+(h.optionRestRepeatedQuotes?' · '+count(h.optionRestRepeatedQuotes)+' repeated':'')+(h.optionRestFallbackInFlight?' (probing)':'')+(h.lastOptionRestFallbackError?' · REST error '+h.lastOptionRestFallbackError:'')):'';
const opraFlow=count(opraQuotes)+' Q · '+count(opraTrades)+' T · '+count(opraAggregates)+' A';
const opraDetail=opraSubscriptionIdle?(h.optionSameDayContractsAvailable===false?'NO SAME-DAY OPTION CONTRACTS · 0 subscriptions · '+opraFlow:'ENTRY CUTOFF · NO ACTIVE EXPOSURE · 0 subscriptions · '+opraFlow):opraFlow+' · transport '+age(h.optionTransportAgeMs??h.lastOptionQuoteAgeMs)+' · exact symbol '+age(h.optionExactSymbolReceiveAgeMs)+' · provider '+age(h.lastOptionQuoteProviderAgeMs)+' · '+count(h.optionFreshContracts)+'/'+count(subscriptions)+' fresh contracts'+(Number.isFinite(h.optionMedianArrivalLagMs)?' · median arrival lag '+latency(h.optionMedianArrivalLagMs):'')+restFallback+opraError;
setStatus('opraState','opraDetail',opraState,opraDetail,opraLevel);
const dbLevel=!live.persistenceEnabled?'degraded':h.recorderHealthy?'ok':'halted',retentionDetail=(live.quoteSampleIntervalMs===0?'full-resolution quotes':live.quoteSampleIntervalMs+' ms quote baseline')+' · '+live.retentionDays+'d raw retention';
setStatus('databaseState','databaseDetail',!live.persistenceEnabled?'DISABLED':h.recorderHealthy?'WRITING':'UNHEALTHY',live.persistenceEnabled?retentionDetail:'Persistence is not enabled',dbLevel);
setStatus('brokerState','brokerDetail',h.brokerAvailable?'CONNECTED':'UNAVAILABLE',(h.executionMode||'paper').toUpperCase()+' · '+count(h.openOrderCount)+' open order(s)',h.brokerAvailable?'ok':'degraded');
const marketClockAvailable=h.marketClockAvailable!==false,marketDetail=!h.positionsReconciled?'Reconciliation required':!marketClockAvailable?'Clock unavailable'+(h.lastMarketClockError?' · '+h.lastMarketClockError:''):'Positions reconciled',marketLevel=!h.positionsReconciled?'halted':marketClockAvailable?'ok':'degraded';
setStatus('marketState','marketDetail',marketClockAvailable?String(h.marketClockState||'unknown').replaceAll('-',' ').toUpperCase():'UNAVAILABLE',marketDetail,marketLevel);
const strategyRequired=h.executionEnabled&&h.marketClockState==='market-open',strategyReady=h.strategyStateReady===true||!strategyRequired,strategyPhase=String(h.strategyStateStatus||(!strategyRequired?'NOT_REQUIRED':'UNKNOWN')),strategyStatus=strategyPhase.replaceAll('_',' '),strategyBuilding=strategyRequired&&strategyPhase==='BUILDING_OPENING_RANGE',strategyLabel=strategyBuilding?'BUILDING':strategyReady?'READY':'BLOCKED',strategyLevel=strategyBuilding?'degraded':strategyReady?'ok':'halted',openingRangeEnd=strategyBuilding&&h.strategyOpeningRangeEnd?' until '+String(h.strategyOpeningRangeEnd).replace(/:00$/,'')+' ET':'',restoredBars=h.restoredFeatureBars??h.restoredBars??0,liveBars=h.completedBars??0;
setStatus('strategyState','strategyDetail',strategyLabel,strategyStatus+openingRangeEnd+' · '+count(h.restoredStockEvents)+' SIP / '+count(restoredBars)+' bars restored at startup · '+count(liveBars)+' live bars / '+count(sipLive)+' SIP events',strategyLevel);
const signalsFired=p.signalsFired??0,optionsSelected=p.optionsSelected??0,latestSelectionVersion=(p.optionSelectionByConfig||[])[0];
$('signalsFired').textContent=count(signalsFired);$('optionsSelected').textContent=count(optionsSelected);$('optionSelectionDetail').textContent=latestSelectionVersion?percent(100*latestSelectionVersion.selectionRate)+' for '+latestSelectionVersion.configVersion+' · '+count(latestSelectionVersion.pending)+' retrying':percent(signalsFired>0?100*optionsSelected/signalsFired:0)+' of signals';$('riskAllowed').textContent=count(p.riskAllowed);$('riskDetail').textContent=count(p.riskBlocked)+' blocked';$('entryOrders').textContent=p.entryOrders;$('filledEntries').textContent=p.filledEntryOrders;$('closedTrades').textContent=p.closedTrades;$('winRate').textContent=(p.winRate*100).toFixed(1)+'%';$('pnl').textContent=money(p.realizedPnl);$('pnl').className='value '+(p.realizedPnl>0?'positive':p.realizedPnl<0?'negative':'');$('openPnl').textContent=money(p.unrealizedPnl);$('openPnl').className='value '+(p.unrealizedPnl>0?'positive':p.unrealizedPnl<0?'negative':'');$('totalPnl').textContent=money(p.totalPnl);$('totalPnl').className='value '+(p.totalPnl>0?'positive':p.totalPnl<0?'negative':'');$('profitFactor').textContent=p.profitFactor===null?'—':num(p.profitFactor);$('openTrades').textContent=p.openTrades;$('subscriptions').textContent=subscriptions;$('feedEvents').textContent=count(live.totalEvents);$('sipQuotes').textContent=count(live.eventCounts.stock_quote);$('sipTrades').textContent=count(live.eventCounts.stock_trade);$('opraQuotes').textContent=count(live.eventCounts.option_quote);$('featureEvents').textContent=count(live.eventCounts.feature_snapshot);$('feedAge').textContent=live.lastEventAgeMs===undefined?'—':duration(live.lastEventAgeMs);
renderOrders(view.orderCards||view.activeOrders);
rows('signals',view.signals||[],[x=>({value:time(x.timestamp)}),x=>({value:itemUnderlying(x)}),x=>({value:x.configVersion}),x=>({value:x.direction}),x=>({value:x.kind}),x=>({value:x.regime}),x=>({value:num(x.projectedMoveBps)+' bps'}),x=>({value:x.candidate||x.closestCandidate}),x=>({value:x.riskStatus||'—',cls:x.riskStatus==='ALLOWED'?'positive':x.riskStatus==='BLOCKED'?'negative':''}),x=>({value:x.status}),x=>({value:(x.riskReasons||x.reasons||[]).join(', ')})]);
rows('orders',view.orders||[],[x=>({value:time(x.timestamp)}),x=>({value:itemUnderlying(x)}),x=>({value:x.purpose}),x=>({value:x.symbol}),x=>({value:x.side}),x=>({value:x.quantity}),x=>({value:money(x.limitPrice)}),x=>({value:x.filledQuantity}),x=>({value:x.averageFillPrice?money(x.averageFillPrice):'—'}),x=>({value:x.status})]);
renderTuning(view.tuning||{entries:[]},view.orders||[]);renderPotentialMisses(view.tuning);
rows('trades',view.trades||[],[x=>({value:time(x.entryTimestamp)}),x=>({value:time(x.exitTimestamp)}),x=>({value:itemUnderlying(x)}),x=>({value:x.symbol}),x=>({value:x.direction}),x=>({value:x.quantity}),x=>({value:money(x.averageEntryPrice)}),x=>({value:x.averageExitPrice?money(x.averageExitPrice):'—'}),x=>({value:money(x.realizedPnl),cls:x.realizedPnl>0?'positive':x.realizedPnl<0?'negative':''}),x=>({value:x.returnPct===undefined?'—':num(x.returnPct)+'%'}),x=>({value:x.exitReason}),x=>({value:x.status})]);
renderDecisionRows(view.decisions||[]);
rows('feedEventsBody',live.recentEvents||[],[x=>({value:time(x.receivedTimestamp)}),x=>({value:x.channel.replaceAll('_',' ')}),x=>({value:x.type.replaceAll('_',' ')}),x=>({value:x.symbol}),x=>({value:x.summary}),x=>({value:feedLatency(x,live)}),x=>({value:storagePolicy(x,live),cls:live.persistenceEnabled?'positive':'muted'})],'No market events received yet. Connection cards above continue to show system liveness.');
$('updated').textContent='Display day '+data.displayDate+' · Updated '+new Date(data.generatedAt).toLocaleString()+' · resets at 10:00 PM Pacific';
}catch(error){$('stateText').textContent='DASHBOARD ERROR';$('state').className='halted';$('updated').textContent=String(error)}
}
refresh();setInterval(refresh,1000);
</script></body></html>`;
}
