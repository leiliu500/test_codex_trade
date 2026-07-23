import type { AuditEvent, AuditRecorder } from "./recorder.js";
import type { HistoricalMarketEvent, HistoricalMarketEventType, MarketHistorySink } from "../history/types.js";
import { marketDate, zonedDateTimeToEpoch } from "../utils/time.js";
import {
  classifyOrderCardEntryQuality,
  type DashboardOrderEntryQuality,
  type DashboardOrderCard,
  type DashboardOrderDynamicsUpdate,
  type OrderCardPersistence,
} from "./orderCards.js";

export type {
  DashboardOrderCard,
  DashboardOrderDynamicsUpdate,
  DashboardOrderEntryQuality,
} from "./orderCards.js";

export interface DashboardSignal {
  id: string;
  timestamp: number;
  direction: string;
  kind: string;
  regime: string;
  projectedMoveBps?: number;
  candidate?: string;
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
  status: "FIRED" | "NO_ELIGIBLE_OPTION" | "ORDER_SUBMITTED" | "ORDER_BLOCKED";
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
  firstFillTimestamp?: number;
  completedTimestamp?: number;
  fillPercentage?: number;
  firstFillLatencyMs?: number;
  completionLatencyMs?: number;
  priceImprovementBps?: number;
  exitReason?: string;
}

export interface DashboardTrade {
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
  targetPrice?: number;
  highWaterMark: number;
  lowWaterMark: number;
  maxFavorableExcursionPct?: number;
  maxAdverseExcursionPct?: number;
  capturePct?: number;
  returnPct?: number;
  exitReason?: string;
  status: "OPEN" | "PARTIAL_EXIT" | "CLOSED";
}

export interface DashboardEntryQuality {
  signalId: string;
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
}

export interface DashboardPotentialMiss {
  id: string;
  timestamp: number;
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

export interface DashboardActiveOrder {
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
  targetPrice?: number;
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
  };
  updates?: DashboardOrderDynamicsUpdate[];
}

export interface DashboardDecision {
  id: string;
  timestamp: number;
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
  latencyMs: number;
  marketDate: string;
  summary: string;
}

export interface DashboardLiveData {
  persistenceEnabled: boolean;
  quoteSampleIntervalMs: number;
  retentionDays: number;
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
  riskAllowed: number;
  riskBlocked: number;
  /** Backward-compatible alias for signalsFired. */
  entriesFired: number;
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

export interface TradingDashboardSnapshot {
  startedAt: number;
  generatedAt: number;
  displayDate: string;
  displayTimeZone: string;
  nextDisplayRolloverAt: number;
  lastMarketDate?: string;
  lastExecutionError?: string;
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

const MISSED_ENTRY_HORIZON_SEC = 5;
const MISSED_ENTRY_MOVE_THRESHOLD_BPS = 2;
const FORWARD_SAMPLE_TOLERANCE_MS = 2_000;
const MISSED_ENTRY_CLUSTER_MS = 15_000;
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

/** Reconstructible read model derived only from durable execution audit events. */
export class TradingDashboardStore implements AuditRecorder, MarketHistorySink {
  readonly #startedAt: number;
  readonly #now: () => number;
  readonly #persistenceEnabled: boolean;
  readonly #quoteSampleIntervalMs: number;
  readonly #retentionDays: number;
  readonly #signals = new Map<string, DashboardSignal>();
  readonly #orders = new Map<string, DashboardOrder>();
  readonly #orderCards = new Map<string, DashboardOrderCard>();
  readonly #openTrades = new Map<string, MutableTrade>();
  readonly #closedTrades: MutableTrade[] = [];
  readonly #latestOptionQuotes = new Map<string, DashboardOptionQuote>();
  readonly #marketEventCounts = emptyMarketEventCounts();
  readonly #recentMarketEvents: DashboardLiveFeedEvent[] = [];
  readonly #lastFeedSampleAt = new Map<HistoricalMarketEventType, number>();
  readonly #decisions: DashboardDecision[] = [];
  readonly #potentialMisses: DashboardPotentialMiss[] = [];
  readonly #entryGateBlocks = new Map<string, number>();
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
  ) {
    this.#startedAt = startedAt;
    this.#now = now;
    this.#persistenceEnabled = persistenceEnabled;
    this.#quoteSampleIntervalMs = quoteSampleIntervalMs;
    this.#retentionDays = retentionDays;
    this.#displayDate = dashboardDisplayDate(now());
  }

  restoreOrderCards(cards: readonly DashboardOrderCard[]): void {
    this.#synchronizeDisplayWindow();
    for (const card of cards) {
      const timestamp = orderCardDisplayTimestamp(card);
      if (timestamp === undefined || dashboardDisplayDate(timestamp) !== this.#displayDate) continue;
      this.#orderCards.set(card.id, cloneOrderCard(card));
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
    else if (event.type === "exit_fill") this.#recordExitFill(event);
    else if (event.type === "execution_halted") {
      this.#lastExecutionError = stringValue(event.data.reason) ?? "Execution halted";
    }
    if (isDecisionEvent(event.type)) this.#recordDecision(event);
    const completedCards = this.#refreshProjectedOrderCards(event.timestamp);
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
    this.#synchronizeDisplayWindow();
    if (dashboardDisplayDate(event.receivedTimestamp) !== this.#displayDate) return;
    this.#lastMarketDate = event.marketDate;
    this.#marketEventCounts[event.type] += 1;
    this.#lastMarketEventReceivedAt = Math.max(this.#lastMarketEventReceivedAt ?? -Infinity, event.receivedTimestamp);
    this.#lastProviderTimestamp = Math.max(this.#lastProviderTimestamp ?? -Infinity, event.providerTimestamp);

    if (event.type === "option_quote") {
      const timestamp = numberValue(event.data.timestamp) ?? event.providerTimestamp;
      const bidPrice = numberValue(event.data.bidPrice);
      const askPrice = numberValue(event.data.askPrice);
      if (bidPrice !== undefined && askPrice !== undefined && bidPrice >= 0 && askPrice >= bidPrice) {
        const previous = this.#latestOptionQuotes.get(event.symbol);
        if (!previous || timestamp >= previous.timestamp) {
          this.#latestOptionQuotes.set(event.symbol, { timestamp, bidPrice, askPrice });
        }
        const trade = this.#openTrades.get(event.symbol);
        if (trade && timestamp >= trade.entryTimestamp) {
          const mark = (bidPrice + askPrice) / 2;
          trade.highWaterMark = Math.max(trade.highWaterMark, mark);
          trade.lowWaterMark = Math.min(trade.lowWaterMark, mark);
        }
        this.#refreshProjectedOrderCards(timestamp, event.symbol, "PNL");
        this.#pruneMap(this.#latestOptionQuotes, 5_000);
      }
    }

    const sampleInterval = ["stock_quote", "stock_trade", "option_quote"].includes(event.type) ? 250 : 0;
    const lastSample = this.#lastFeedSampleAt.get(event.type);
    if (lastSample === undefined || event.receivedTimestamp - lastSample >= sampleInterval) {
      this.#lastFeedSampleAt.set(event.type, event.receivedTimestamp);
      this.#recentMarketEvents.unshift({
        id: ++this.#feedSequence,
        type: event.type,
        channel: marketEventChannel(event.type),
        symbol: event.symbol,
        providerTimestamp: event.providerTimestamp,
        receivedTimestamp: event.receivedTimestamp,
        latencyMs: Math.max(0, event.receivedTimestamp - event.providerTimestamp),
        marketDate: event.marketDate,
        summary: marketEventSummary(event),
      });
      if (this.#recentMarketEvents.length > 100) this.#recentMarketEvents.length = 100;
    }
  }

  healthy(): boolean { return this.#orderCardPersistenceHealthy; }

  snapshot(): TradingDashboardSnapshot {
    const generatedAt = this.#now();
    this.#synchronizeDisplayWindow(generatedAt);
    const closed = this.#closedTrades;
    const realizedPnl = [...closed, ...this.#openTrades.values()].reduce((sum, trade) => sum + trade.realizedPnl, 0);
    const wins = closed.filter((trade) => trade.realizedPnl > 0).length;
    const losses = closed.filter((trade) => trade.realizedPnl < 0).length;
    const grossProfit = closed.reduce((sum, trade) => sum + Math.max(0, trade.realizedPnl), 0);
    const grossLoss = Math.abs(closed.reduce((sum, trade) => sum + Math.min(0, trade.realizedPnl), 0));
    const pnls = closed.map((trade) => trade.realizedPnl);
    const orders = [...this.#orders.values()];
    const signals = [...this.#signals.values()];
    const optionsSelected = signals.filter((signal) => signal.candidate !== undefined).length;
    const riskAllowed = signals.filter((signal) => signal.riskStatus === "ALLOWED").length;
    const riskBlocked = signals.filter((signal) => signal.riskStatus === "BLOCKED").length;
    this.#refreshProjectedOrderCards(generatedAt);
    const activeOrders = this.#activeOrders(generatedAt, orders).map((order) => ({
      ...order,
      ...(this.#orderCards.get(order.id)
        ? { updates: this.#orderCards.get(order.id)!.updates.map((update) => ({ ...update })) } : {}),
    }));
    const unrealizedPnl = activeOrders.reduce((sum, order) => sum + (order.unrealizedPnl ?? 0), 0);
    const orderCards = [...this.#orderCards.values()]
      .sort((a, b) =>
        Number(b.active) - Number(a.active) ||
        (b.exitTimestamp ?? b.entryTimestamp ?? b.updates.at(-1)?.timestamp ?? 0) -
          (a.exitTimestamp ?? a.entryTimestamp ?? a.updates.at(-1)?.timestamp ?? 0))
      .slice(0, 250)
      .map(cloneOrderCard);
    const publicOrders = orders.slice(-250).reverse().map((order) => this.#publicOrder(order, generatedAt));
    const publicTrades = [...closed, ...this.#openTrades.values()]
      .slice(-250).reverse().map((trade) => this.#publicTrade(trade));
    const entryQuality = this.#entryQuality(orders, [...closed, ...this.#openTrades.values()]);
    return {
      startedAt: this.#startedAt,
      generatedAt,
      displayDate: this.#displayDate,
      displayTimeZone: DASHBOARD_DISPLAY_TIME_ZONE,
      nextDisplayRolloverAt: nextDashboardDisplayRollover(generatedAt),
      ...(this.#lastMarketDate ? { lastMarketDate: this.#lastMarketDate } : {}),
      ...(this.#lastExecutionError ? { lastExecutionError: this.#lastExecutionError } : {}),
      performance: {
        signalsFired: signals.length,
        optionsSelected,
        riskAllowed,
        riskBlocked,
        entriesFired: signals.length,
        entryOrders: orders.filter((order) => order.purpose === "ENTRY").length,
        exitOrders: orders.filter((order) => order.purpose === "EXIT").length,
        filledEntryOrders: orders.filter((order) => order.purpose === "ENTRY" && order.filledQuantity > 0).length,
        closedTrades: closed.length,
        openTrades: this.#openTrades.size,
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
      decisions: this.#decisions.slice(0, 100).map(publicDecision),
      tuning: {
        summary: tuningSummary(entryQuality),
        entries: entryQuality,
        falseNegativeSummary: this.#falseNegativeSummary(),
        potentialMisses: this.#potentialMisses.slice(0, 250).map((miss) => ({
          ...miss, reasons: [...miss.reasons], failedGates: [...miss.failedGates],
        })),
      },
      liveData: {
        persistenceEnabled: this.#persistenceEnabled,
        quoteSampleIntervalMs: this.#quoteSampleIntervalMs,
        retentionDays: this.#retentionDays,
        uptimeMs: Math.max(0, generatedAt - this.#startedAt),
        totalEvents: Object.values(this.#marketEventCounts).reduce((sum, count) => sum + count, 0),
        eventCounts: { ...this.#marketEventCounts },
        ...(this.#lastMarketEventReceivedAt !== undefined ? {
          lastEventReceivedAt: this.#lastMarketEventReceivedAt,
          lastEventAgeMs: Math.max(0, generatedAt - this.#lastMarketEventReceivedAt),
        } : {}),
        ...(this.#lastProviderTimestamp !== undefined ? { lastProviderTimestamp: this.#lastProviderTimestamp } : {}),
        recentEvents: this.#recentMarketEvents.map((event) => ({ ...event })),
      },
      signals: [...this.#signals.values()].slice(-250).reverse().map((signal) => ({
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
    this.#recentMarketEvents.length = 0;
    this.#lastFeedSampleAt.clear();
    this.#decisions.length = 0;
    this.#potentialMisses.length = 0;
    this.#entryGateBlocks.clear();
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

    if (event.type === "live_entry_evaluation") {
      stage = "ENTRY_EVALUATION";
      outcome = stringValue(event.data.decision) ?? "UNKNOWN";
      regime = stringValue(event.data.regime) ?? "UNKNOWN";
      const feature = recordValue(event.data.feature);
      price = numberValue(feature.price);
      if (price !== undefined) this.#updateForwardEntryEvaluations(event.timestamp, price);
      this.#entryEvaluationCount += 1;
      if (outcome === "NO_SIGNAL") this.#noSignalEvaluationCount += 1;
      if (outcome === "NO_SIGNAL" || outcome === "SKIPPED") {
        for (const reason of reasons) this.#entryGateBlocks.set(reason, (this.#entryGateBlocks.get(reason) ?? 0) + 1);
      }
      summary = `${regime} · SPY ${formatFeedNumber(numberValue(feature.price))}`;
      directions = decisionDirections(event.data.directions);
    } else if (event.type === "live_signal_selection") {
      stage = "OPTION_SELECTION";
      outcome = symbol ? "SELECTED" : "NO_ELIGIBLE_OPTION";
      const count = numberValue(event.data.evaluatedContracts) ?? 0;
      summary = symbol ? `${symbol} selected from ${count} contracts` : `No option selected from ${count} contracts`;
      reasons = reasonCounts(event.data.rejectionCounts);
    } else if (event.type === "risk_decision") {
      stage = "RISK";
      const risk = recordValue(event.data.risk);
      outcome = risk.allowed === true ? "ALLOWED" : "BLOCKED";
      summary = risk.allowed === true
        ? `${numberValue(risk.quantity) ?? 0} contract(s) · stop ${formatFeedNumber(numberValue(risk.stopPrice))} · target ${formatFeedNumber(numberValue(risk.targetPrice))}`
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

  #updateForwardEntryEvaluations(timestamp: number, forwardPrice: number): void {
    const horizonMs = MISSED_ENTRY_HORIZON_SEC * 1_000;
    for (const decision of this.#decisions) {
      if (decision.stage !== "ENTRY_EVALUATION" || decision.price === undefined ||
          decision.forwardMoveBps !== undefined) continue;
      const elapsed = timestamp - decision.timestamp;
      if (elapsed < horizonMs) continue;
      if (elapsed > horizonMs + FORWARD_SAMPLE_TOLERANCE_MS) continue;
      const forwardMoveBps = 10_000 * (forwardPrice - decision.price) / decision.price;
      decision.forwardPrice = forwardPrice;
      decision.forwardMoveBps = forwardMoveBps;
      if (decision.outcome !== "NO_SIGNAL") continue;
      this.#matureNoSignalEvaluationCount += 1;
      if (!decision.reasons.includes("NO_DIRECTION_PASSED") ||
          Math.abs(forwardMoveBps) < MISSED_ENTRY_MOVE_THRESHOLD_BPS) continue;
      const direction: DashboardPotentialMiss["direction"] = forwardMoveBps > 0 ? "BULLISH" : "BEARISH";
      if (this.#potentialMisses.some((miss) => miss.direction === direction &&
          Math.abs(miss.timestamp - decision.timestamp) < MISSED_ENTRY_CLUSTER_MS)) continue;
      const directionDecision = decision.directions?.find((item) => item.direction === direction);
      const failedVotes = directionDecision?.votes.filter((vote) => !vote.passed).map((vote) =>
        `${vote.name} ${vote.value.toFixed(3)} vs ${vote.threshold.toFixed(3)}`) ?? [];
      this.#potentialMisses.unshift({
        id: `potential-miss-${decision.id}`,
        timestamp: decision.timestamp,
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

  #falseNegativeSummary(): DashboardFalseNegativeSummary {
    const potentialMisses = this.#potentialMisses.length;
    return {
      evaluations: this.#entryEvaluationCount,
      noSignalEvaluations: this.#noSignalEvaluationCount,
      matureNoSignalEvaluations: this.#matureNoSignalEvaluationCount,
      potentialMisses,
      potentialMissRate: this.#matureNoSignalEvaluationCount > 0
        ? potentialMisses / this.#matureNoSignalEvaluationCount : 0,
      bullishPotentialMisses: this.#potentialMisses.filter((miss) => miss.direction === "BULLISH").length,
      bearishPotentialMisses: this.#potentialMisses.filter((miss) => miss.direction === "BEARISH").length,
      horizonSec: MISSED_ENTRY_HORIZON_SEC,
      thresholdBps: MISSED_ENTRY_MOVE_THRESHOLD_BPS,
      gateBlocks: [...this.#entryGateBlocks.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    };
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
        ...(trade.targetPrice !== undefined ? { targetPrice: trade.targetPrice } : {}),
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

  #entryQuality(orders: DashboardOrder[], trades: MutableTrade[]): DashboardEntryQuality[] {
    const entryOrders = orders.filter((order) => order.purpose === "ENTRY");
    return [...this.#signals.values()].slice(-500).reverse().map((signal) => {
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
      ...(trade.targetPrice !== undefined ? { targetPrice: trade.targetPrice } : {}),
      highWaterMark: trade.highWaterMark,
      lowWaterMark: trade.lowWaterMark,
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
    const liveQuote = candidate ? this.#latestOptionQuotes.get(candidate) : undefined;
    const decisionBid = numberValue(eventQuote.bidPrice) ?? liveQuote?.bidPrice;
    const decisionAsk = numberValue(eventQuote.askPrice) ?? liveQuote?.askPrice;
    const decisionMid = numberValue(metrics.mid) ?? (decisionBid !== undefined && decisionAsk !== undefined
      ? (decisionBid + decisionAsk) / 2 : undefined);
    const decisionSpreadPct = numberValue(metrics.spreadPct) ??
      (decisionBid !== undefined && decisionAsk !== undefined && decisionMid !== undefined && decisionMid > 0
        ? (decisionAsk - decisionBid) / decisionMid : undefined);
    this.#signals.set(id, {
      id,
      timestamp: numberValue(event.data.timestamp) ?? event.timestamp,
      direction: stringValue(event.data.direction) ?? "UNKNOWN",
      kind: stringValue(event.data.kind) ?? "UNKNOWN",
      regime: stringValue(event.data.regime) ?? "UNKNOWN",
      ...(numberValue(event.data.projectedMoveBps) !== undefined
        ? { projectedMoveBps: numberValue(event.data.projectedMoveBps)! } : {}),
      ...(candidate ? { candidate } : {}),
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
      status: candidate ? "FIRED" : "NO_ELIGIBLE_OPTION",
      reasons: [],
    });
    this.#pruneMap(this.#signals, 1_000);
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
    const targetPrice = numberValue(position.targetPrice);
    const signalId = stringValue(event.data.signalId)
      ?? [...this.#orders.values()].reverse().find((order) => order.purpose === "ENTRY" && order.symbol === symbol)?.signalId
      ?? this.#matchingSignal(symbol, entryTimestamp)?.id;
    const order = [...this.#orders.values()].reverse().find((candidate) =>
      candidate.purpose === "ENTRY" && (candidate.signalId === signalId || candidate.symbol === symbol));
    if (order && order.firstFillTimestamp === undefined) order.firstFillTimestamp = event.timestamp;
    const highWaterMark = numberValue(position.highWaterMark) ?? averageEntryPrice;
    const lowWaterMark = numberValue(position.lowWaterMark) ?? averageEntryPrice;
    if (existing) {
      if (order) existing.entryOrderId = order.clientOrderId;
      existing.quantity = Math.max(existing.quantity, quantity);
      existing.averageEntryPrice = averageEntryPrice;
      if (stopPrice !== undefined) existing.stopPrice = stopPrice;
      if (targetPrice !== undefined) existing.targetPrice = targetPrice;
      existing.highWaterMark = Math.max(existing.highWaterMark, highWaterMark);
      existing.lowWaterMark = Math.min(existing.lowWaterMark, lowWaterMark);
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
        ...(targetPrice !== undefined ? { targetPrice } : {}),
        highWaterMark,
        lowWaterMark,
        realizedPnl: 0,
        status: "OPEN",
        exitedQuantity: 0,
        exitNotional: 0,
        ...(order ? { entryOrderId: order.clientOrderId } : {}),
      });
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
        highWaterMark: numberValue(event.data.highWaterMark) ?? numberValue(event.data.averageEntryPrice) ?? 0,
        lowWaterMark: numberValue(event.data.lowWaterMark) ?? numberValue(event.data.averageEntryPrice) ?? 0,
        realizedPnl: 0,
        status: "OPEN",
        exitedQuantity: 0,
        exitNotional: 0,
      };
      this.#openTrades.set(symbol, trade);
    }
    const quantity = numberValue(event.data.incrementalQuantity) ?? 0;
    const price = numberValue(event.data.incrementalPrice) ?? 0;
    const highWaterMark = numberValue(event.data.highWaterMark);
    const lowWaterMark = numberValue(event.data.lowWaterMark);
    if (highWaterMark !== undefined) trade.highWaterMark = Math.max(trade.highWaterMark, highWaterMark);
    if (lowWaterMark !== undefined) trade.lowWaterMark = Math.min(trade.lowWaterMark, lowWaterMark);
    if (price > 0) {
      trade.highWaterMark = Math.max(trade.highWaterMark, price);
      trade.lowWaterMark = Math.min(trade.lowWaterMark, price);
    }
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
      ...(active.targetPrice !== undefined ? { targetPrice: active.targetPrice } : {}),
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
      ...(trade.targetPrice !== undefined ? { targetPrice: trade.targetPrice } : {}),
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
    this.#orderCards.set(projected.id, {
      ...(existing ?? {}),
      ...projected,
      updates,
    });
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
"averageEntryPrice" | "highWaterMark" | "lowWaterMark" | "status" | "returnPct">): {
  maxFavorableExcursionPct?: number;
  maxAdverseExcursionPct?: number;
  capturePct?: number;
} {
  if (!(trade.averageEntryPrice > 0)) return {};
  const maxFavorableExcursionPct = 100 * (trade.highWaterMark - trade.averageEntryPrice) / trade.averageEntryPrice;
  const maxAdverseExcursionPct = 100 * (trade.lowWaterMark - trade.averageEntryPrice) / trade.averageEntryPrice;
  const capturePct = trade.status === "CLOSED" && trade.returnPct !== undefined && trade.returnPct > 0 &&
    maxFavorableExcursionPct > 0
    ? Math.max(0, Math.min(100, 100 * trade.returnPct / maxFavorableExcursionPct)) : undefined;
  return {
    maxFavorableExcursionPct,
    maxAdverseExcursionPct,
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
    option_snapshot: 0,
    feature_snapshot: 0,
  };
}

function marketEventChannel(type: HistoricalMarketEventType): DashboardLiveFeedEvent["channel"] {
  if (type === "stock_quote" || type === "stock_trade") return "SIP";
  if (type === "option_quote") return "OPRA";
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
  if (event.type === "option_contract") {
    return `${stringValue(data.type) ?? "option"} · strike ${formatFeedNumber(numberValue(data.strike))} · expires ${stringValue(data.expirationDate) ?? "—"}`;
  }
  if (event.type === "option_snapshot") {
    const greeks = recordValue(data.greeks);
    return `IV ${formatFeedNumber(numberValue(data.impliedVolatility), 4)} · delta ${formatFeedNumber(numberValue(greeks.delta), 3)} · volume ${formatFeedNumber(numberValue(data.dailyVolume), 0)}`;
  }
  const fast = recordValue(data.fast);
  return `SPY ${formatFeedNumber(numberValue(data.price))} · fast slope ${formatFeedNumber(numberValue(fast.normalizedSlope), 3)} · OFI5 ${formatFeedNumber(numberValue(data.ofi5), 3)}`;
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
  };
}

function sameDynamics(left: DashboardOrderDynamicsUpdate, right: DashboardOrderDynamicsUpdate): boolean {
  return left.stage === right.stage &&
    left.status === right.status &&
    left.remainingQuantity === right.remainingQuantity &&
    left.realizedPnl === right.realizedPnl &&
    left.currentBid === right.currentBid &&
    left.unrealizedPnl === right.unrealizedPnl &&
    left.totalPnl === right.totalPnl;
}

function cloneOrderCard(card: DashboardOrderCard): DashboardOrderCard {
  const quality = classifyOrderCardEntryQuality(card);
  return {
    ...card,
    ...quality,
    ...(card.workingOrder ? { workingOrder: { ...card.workingOrder } } : {}),
    updates: card.updates.map((update) => ({ ...update })),
  };
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
<title>SPY 0DTE Trading Dashboard</title><style>
:root{color-scheme:dark;--bg:#07111f;--panel:#0e1b2e;--line:#20324b;--text:#e7eef9;--muted:#91a4bd;--green:#35d07f;--red:#ff667a;--blue:#58a6ff;--amber:#f5c451}*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#06101c,#0a1830);color:var(--text);font:14px ui-sans-serif,system-ui,sans-serif}main{max-width:1500px;margin:auto;padding:24px}header{display:flex;justify-content:space-between;gap:18px;align-items:center;margin-bottom:18px}h1{font-size:24px;margin:0}h2{font-size:16px;margin:0 0 12px}.sub,.muted{color:var(--muted)}#state{display:flex;align-items:center;gap:8px;font-weight:700;padding:8px 12px;border:1px solid var(--line);border-radius:999px}.pulse-dot{width:9px;height:9px;border-radius:50%;background:currentColor;box-shadow:0 0 0 0 currentColor;animation:pulse 1.8s infinite}@keyframes pulse{70%{box-shadow:0 0 0 7px transparent}}.ok{color:var(--green)}.degraded{color:var(--amber)}.halted{color:var(--red)}.liveness-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:10px;margin-bottom:18px}.status-card{background:#0b192b;border:1px solid var(--line);border-radius:10px;padding:12px}.status-card .label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}.status-card strong{display:block;margin:5px 0 3px;font-size:14px}.status-detail{color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tabs{display:flex;gap:5px;border-bottom:1px solid var(--line);margin-bottom:16px}.tab{appearance:none;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted);font:inherit;font-weight:700;padding:11px 16px;cursor:pointer}.tab:hover{color:var(--text)}.tab.active{color:var(--blue);border-bottom-color:var(--blue)}.tab-panel{display:none}.tab-panel.active{display:block}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px;margin-bottom:18px}.card,.panel{background:rgba(14,27,46,.94);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 30px #0003}.card{padding:14px}.card .value{font-size:23px;font-weight:750;margin-top:6px}.card-detail{font-size:11px;margin-top:4px}.panel{padding:16px;margin:14px 0;overflow:auto}.live-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:14px}.live-card{background:linear-gradient(145deg,#12243d,#0b1729);border:1px solid #294262;border-radius:13px;padding:16px;min-width:0;box-shadow:inset 3px 0 0 var(--blue)}.live-card.profit{box-shadow:inset 3px 0 0 var(--green)}.live-card.loss{box-shadow:inset 3px 0 0 var(--red)}.live-card.completed{background:linear-gradient(145deg,#101d30,#091421)}.live-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.live-symbol{font-weight:750;font-size:16px;overflow-wrap:anywhere}.badge,.source{display:inline-block;margin-top:5px;padding:3px 7px;border-radius:999px;background:#58a6ff1c;color:var(--blue);font-size:11px;font-weight:700;letter-spacing:.04em}.source{margin:0}.live-pnl{text-align:right;font-size:22px;font-weight:800}.live-return{text-align:right;font-size:12px;margin-top:3px}.entry-quality{display:grid;gap:3px;border:1px solid var(--line);border-radius:8px;margin-top:13px;padding:9px 11px;background:#07111f80}.entry-quality strong{font-size:11px;letter-spacing:.05em}.entry-quality span{color:var(--muted);font-size:11px}.entry-quality.good{border-color:#35d07f66}.entry-quality.good strong{color:var(--green)}.entry-quality.good-entry-poor-exit,.entry-quality.marginal{border-color:#f5c45166}.entry-quality.good-entry-poor-exit strong,.entry-quality.marginal strong{color:var(--amber)}.entry-quality.poor{border-color:#ff667a66}.entry-quality.poor strong{color:var(--red)}.entry-quality.evaluating strong{color:var(--blue)}.entry-quality.not-rated strong{color:var(--muted)}.live-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:16px}.live-field span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}.live-field strong{font-size:14px}.order-strip{border-top:1px solid var(--line);margin-top:15px;padding-top:12px;display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:12px}.dynamics{border-top:1px solid var(--line);margin-top:14px;padding-top:12px}.dynamics-title{color:var(--muted);font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.05em;margin-bottom:7px}.dynamics-list{display:grid;gap:5px}.dynamics-row{display:grid;grid-template-columns:72px minmax(105px,1fr) 82px 76px;gap:7px;align-items:center;border-radius:6px;background:#07111f80;padding:7px;font-size:11px}.dynamics-row .dynamics-time,.dynamics-row .dynamics-state{color:var(--muted)}.dynamics-row .dynamics-pnl,.dynamics-row .dynamics-change{text-align:right;font-variant-numeric:tabular-nums}.empty{color:var(--muted);padding:22px;text-align:center;border:1px dashed var(--line);border-radius:10px}.section-note{color:var(--muted);font-size:12px;margin:-6px 0 12px}.decision-reasons{max-width:560px;white-space:normal;line-height:1.45}.outcome{font-weight:750}.outcome.pass{color:var(--green)}.outcome.block{color:var(--amber)}.tune-controls{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin-bottom:14px}.tune-control{display:grid;gap:5px}.tune-control label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}.tune-control select{min-width:150px;background:#0a1728;color:var(--text);border:1px solid var(--line);border-radius:7px;padding:8px 10px}.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:11px;margin:8px 0}.quality-status{font-weight:750}.quality-status.WIN,.quality-status.FILLED,.quality-status.OPEN{color:var(--green)}.quality-status.LOSS,.quality-status.BLOCKED{color:var(--red)}.quality-status.WORKING,.quality-status.NO_OPTION{color:var(--amber)}table{border-collapse:collapse;width:100%;min-width:850px}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}tbody tr:hover{background:#ffffff08}.positive{color:var(--green)}.negative{color:var(--red)}@media(max-width:700px){main{padding:14px}header{align-items:flex-start;flex-direction:column}.live-grid{grid-template-columns:1fr}.live-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.dynamics-row{grid-template-columns:64px 1fr 72px}.dynamics-change{display:none}.tab{padding:10px}.tune-control{width:100%}.tune-control select{width:100%}}
</style></head><body><main><header><div><h1>SPY 0DTE Option Day-Trade Dashboard</h1><div class="sub">Live SIP signals · OPRA options · Alpaca paper execution · PostgreSQL history</div></div><div id="state"><span class="pulse-dot"></span><span id="stateText">Loading…</span></div></header>
<section class="liveness-grid" aria-label="System liveness">
<div class="status-card"><div class="label">Engine heartbeat</div><strong id="engineState">Connecting</strong><div class="status-detail" id="engineDetail">Waiting for dashboard API</div></div>
<div class="status-card"><div class="label">SPY SIP feed</div><strong id="sipState">Connecting</strong><div class="status-detail" id="sipDetail">Waiting for stock stream</div></div>
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
<section class="panel"><h2>Orders</h2><div class="section-note">Active orders update with every observed P&amp;L or status change. Completed timelines remain in PostgreSQL, while visible cards reset with the rest of the dashboard at 10:00 PM Pacific.</div><div id="orderCards" class="live-grid"><div class="empty">Waiting for an option order…</div></div></section>
<section class="panel"><h2>Signal → Trade Funnel</h2><div class="section-note">A fired signal is not an order. Each row shows option selection, risk, and submission status explicitly.</div><table><thead><tr><th>Time</th><th>Direction</th><th>Kind</th><th>Regime</th><th>Projected</th><th>Option</th><th>Risk</th><th>Status</th><th>Reason</th></tr></thead><tbody id="signals"></tbody></table></section>
<section class="panel"><h2>Potential Missed Entry Review</h2><div class="section-note">Hindsight diagnostic, not an automatic trade recommendation. A row appears only when directional gates produced NO SIGNAL and SPY subsequently moved at least ${MISSED_ENTRY_MOVE_THRESHOLD_BPS.toFixed(1)} bps in one direction over the ${MISSED_ENTRY_HORIZON_SEC}-second projection horizon. Consecutive rows are clustered for readability.</div><table><thead><tr><th>Evaluation</th><th>Direction</th><th>Regime</th><th>SPY Start</th><th>SPY +${MISSED_ENTRY_HORIZON_SEC}s</th><th>Forward Move</th><th>Failed Gates / Votes</th><th>Decision Reason</th></tr></thead><tbody id="potentialMissRows"></tbody></table></section>
<section class="panel"><h2>Entry Gate Blocks</h2><div class="section-note">Counts every top-level reason that prevented an entry evaluation. This exposes global state failures such as incomplete opening-range recovery even when no hindsight row is created.</div><table><thead><tr><th>Gate / Reason</th><th>Blocked Evaluations</th><th>Share of Evaluations</th></tr></thead><tbody id="gateBlockRows"></tbody></table></section>
<section class="panel"><h2>Orders &amp; Executions</h2><table><thead><tr><th>Time</th><th>Purpose</th><th>Option</th><th>Side</th><th>Qty</th><th>Limit</th><th>Filled</th><th>Avg Fill</th><th>Status</th></tr></thead><tbody id="orders"></tbody></table></section>
<section class="panel"><h2>Trade Performance</h2><table><thead><tr><th>Entry</th><th>Exit</th><th>Option</th><th>Direction</th><th>Qty</th><th>Entry Px</th><th>Exit Px</th><th>P&amp;L</th><th>Return</th><th>Exit Reason</th><th>Status</th></tr></thead><tbody id="trades"></tbody></table></section>
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
<section class="panel"><h2>Entry Evaluations &amp; Decisions</h2><div class="section-note">Every evaluation remains stored, but routine one-second NO SIGNAL rows are hidden by default. Use All evaluations only when diagnosing individual gates.</div><div class="tune-controls"><div class="tune-control"><label for="decisionView">Rows shown</label><select id="decisionView"><option value="ACTIONABLE">Actionable stages only</option><option value="ALL">All evaluations</option><option value="NO_SIGNAL">NO SIGNAL only</option></select></div></div><table><thead><tr><th>Time</th><th>Stage</th><th>Outcome</th><th>Direction</th><th>Option</th><th>Decision</th><th>Gates, Votes &amp; Reasons</th></tr></thead><tbody id="decisions"></tbody></table></section>
<section class="panel"><h2>Live Feed Into System</h2><div class="section-note">The UI is sampled for readability. PostgreSQL retains quote baselines, full-resolution quotes for working/open options, and every trade, feature, decision, order, and fill.</div><table><thead><tr><th>Received</th><th>Feed</th><th>Type</th><th>Symbol</th><th>Value</th><th>Provider Latency</th><th>Storage Policy</th></tr></thead><tbody id="feedEventsBody"></tbody></table></section>
</div>
<div class="muted" id="updated"></div></main><script>
const $=id=>document.getElementById(id),money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n||0),num=(n,d=2)=>Number.isFinite(n)?n.toFixed(d):'—',count=n=>Number(n||0).toLocaleString(),time=n=>n?new Date(n).toLocaleString('en-US',{timeZone:'America/New_York'}):'—';
function cell(value,cls=''){const td=document.createElement('td');td.textContent=String(value??'—');if(cls)td.className=cls;return td}function rows(id,data,fields,empty=''){const body=$(id);if(data.length===0&&empty){const tr=document.createElement('tr'),td=cell(empty,'muted');td.colSpan=fields.length;tr.append(td);body.replaceChildren(tr);return}body.replaceChildren(...data.map(item=>{const tr=document.createElement('tr');for(const field of fields){const result=field(item);tr.append(cell(result.value,result.cls||''))}return tr}))}
function node(tag,cls,text){const value=document.createElement(tag);if(cls)value.className=cls;if(text!==undefined)value.textContent=String(text);return value}function field(label,value){const wrap=node('div','live-field'),caption=node('span','',label),content=node('strong','',value);wrap.append(caption,content);return wrap}function duration(ms){if(!Number.isFinite(ms))return '—';const seconds=Math.floor(ms/1000),minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60);return hours>0?hours+'h '+(minutes%60)+'m':minutes>0?minutes+'m '+(seconds%60)+'s':seconds+'s'}
function renderOrders(items){const root=$('orderCards');if(!items||items.length===0){root.replaceChildren(node('div','empty','No option orders have been recorded.'));return}const cards=items.map(x=>{const pnl=x.totalPnl===undefined?x.unrealizedPnl:x.totalPnl,pnlClass=pnl>0?'positive':pnl<0?'negative':'',card=node('article','live-card '+(x.active?'':'completed ')+(pnl>0?'profit':pnl<0?'loss':'')),head=node('div','live-head'),identity=node('div'),symbol=node('div','live-symbol',x.symbol),badge=node('div','badge',x.stage.replaceAll('_',' ')),pnlBox=node('div'),pnlValue=node('div','live-pnl '+pnlClass,pnl===undefined?'AWAITING FILL':money(pnl)),returnLabel=x.active?' open return':' final return',pnlReturn=node('div','live-return '+pnlClass,x.unrealizedReturnPct===undefined?(x.active?'P&L from executable bid':'Completed order'):num(x.unrealizedReturnPct)+'%'+returnLabel);identity.append(symbol,badge);pnlBox.append(pnlValue,pnlReturn);head.append(identity,pnlBox);const qualityKey=x.entryQuality||'NOT_RATED',qualityClass=qualityKey.toLowerCase().replaceAll('_','-'),quality=node('div','entry-quality '+qualityClass),qualityLabel=node('strong','','ENTRY QUALITY · '+qualityKey.replaceAll('_',' ')),qualityReason=node('span','',x.entryQualityReason||'No quality classification is available.');quality.append(qualityLabel,qualityReason);const fields=node('div','live-fields');fields.append(field('Position',x.remainingQuantity+' / '+x.quantity+' contracts'),field('Entry',x.entryPrice===undefined?'—':money(x.entryPrice)),field(x.active?'Bid / Ask':'Exit',x.active?(x.currentBid===undefined?'—':money(x.currentBid)+' / '+money(x.currentAsk)):(x.exitPrice===undefined?'—':money(x.exitPrice))),field('Stop',x.stopPrice===undefined?'—':money(x.stopPrice)),field('Target',x.targetPrice===undefined?'—':money(x.targetPrice)),field('Elapsed',duration(x.elapsedMs)),field('Realized',money(x.realizedPnl)),field(x.active?'Quote age':'Exit reason',x.active?(x.quoteAgeMs===undefined?'Waiting for quote':duration(x.quoteAgeMs)):(x.exitReason||x.status)),field('Direction',x.direction||'Pending entry'));card.append(head,quality,fields);if(x.workingOrder){const strip=node('div','order-strip'),left=node('span','',x.workingOrder.purpose+' '+x.workingOrder.status+' · '+x.workingOrder.filledQuantity+'/'+x.workingOrder.requestedQuantity+' filled'),right=node('span','',money(x.workingOrder.limitPrice)+' limit · '+x.workingOrder.replacements+' replaces');strip.append(left,right);card.append(strip)}const updates=x.updates||[],pnlUpdates=updates.filter(update=>(update.totalPnl===undefined?update.unrealizedPnl:update.totalPnl)!==undefined).length,statusUpdates=updates.length-pnlUpdates,dynamics=node('div','dynamics'),title=node('div','dynamics-title','Trackable timeline · '+pnlUpdates+' P&L · '+statusUpdates+' status'),list=node('div','dynamics-list');for(const update of [...updates].reverse()){const total=update.totalPnl===undefined?update.unrealizedPnl:update.totalPnl,change=update.pnlChange,row=node('div','dynamics-row'),at=node('span','dynamics-time',new Date(update.timestamp).toLocaleTimeString('en-US',{timeZone:'America/New_York'})),stateText=update.stage.replaceAll('_',' ')+' · '+update.status+(update.currentBid===undefined?'':' · bid '+money(update.currentBid)),state=node('span','dynamics-state',stateText),value=node('span','dynamics-pnl '+(total>0?'positive':total<0?'negative':''),total===undefined?'—':money(total)),delta=node('span','dynamics-change '+(change>0?'positive':change<0?'negative':''),change===undefined?'—':(change>0?'+':'')+money(change));row.append(at,state,value,delta);list.append(row)}if(updates.length===0)list.append(node('div','muted','Waiting for the first P&L or status update.'));dynamics.append(title,list);card.append(dynamics);return card});root.replaceChildren(...cards)}
function setStatus(valueId,detailId,value,detail,level){$(valueId).textContent=value;$(valueId).className=level;$(detailId).textContent=detail}function age(ms){return Number.isFinite(ms)?duration(ms)+' ago':'No events yet'}function storagePolicy(event,live){if(!live.persistenceEnabled)return 'Disabled';if(event.type==='stock_quote'||event.type==='option_quote')return (live.quoteSampleIntervalMs||0)+' ms baseline · active option full';return 'Full retention'}
function outcomeClass(value){return ['SIGNAL','SELECTED','ALLOWED','SUBMITTED','REQUESTED','FILLED'].includes(value)?'outcome pass':['NO_SIGNAL','NO_ELIGIBLE_OPTION','BLOCKED','SKIPPED'].includes(value)?'outcome block':'outcome'}
function decisionDetail(item){const details=[...(item.reasons||[])];for(const direction of item.directions||[]){const failedVotes=(direction.votes||[]).filter(v=>!v.passed).map(v=>v.name);const result=direction.passed?'PASS':(direction.reasons||[]).slice(0,6).join(', ');details.push(direction.direction+': '+result+(failedVotes.length?' · failed votes '+failedVotes.join(', '):''))}return details.join(' · ')||'All configured gates passed'}
let latestDecisions=[];
function renderDecisionRows(items){latestDecisions=items||[];const view=$('decisionView').value,filtered=view==='ALL'?latestDecisions:view==='NO_SIGNAL'?latestDecisions.filter(x=>x.stage==='ENTRY_EVALUATION'&&x.outcome==='NO_SIGNAL'):latestDecisions.filter(x=>!(x.stage==='ENTRY_EVALUATION'&&x.outcome==='NO_SIGNAL'));rows('decisions',filtered,[x=>({value:time(x.timestamp)}),x=>({value:x.stage.replaceAll('_',' ')}),x=>({value:x.outcome.replaceAll('_',' '),cls:outcomeClass(x.outcome)}),x=>({value:x.direction}),x=>({value:x.symbol}),x=>({value:x.summary}),x=>({value:decisionDetail(x),cls:'decision-reasons'})],view==='ACTIONABLE'?'No actionable signal, option-selection, risk, or order events yet. Routine NO SIGNAL evaluations remain recorded.':'No evaluations match this view.')}
function renderPotentialMisses(tuning){const summary=tuning?.falseNegativeSummary||{evaluations:0,noSignalEvaluations:0,matureNoSignalEvaluations:0,potentialMisses:0,potentialMissRate:0,horizonSec:5,thresholdBps:2,gateBlocks:[]},misses=tuning?.potentialMisses||[];$('potentialMisses').textContent=count(summary.potentialMisses);$('potentialMisses').className='value '+(summary.potentialMisses>0?'negative':'positive');$('potentialMissDetail').textContent=count(summary.potentialMisses)+' of '+count(summary.matureNoSignalEvaluations)+' mature · '+percent(100*summary.potentialMissRate,2);$('noSignalEvaluations').textContent=count(summary.noSignalEvaluations);$('noSignalDetail').textContent=count(summary.matureNoSignalEvaluations)+' have a +'+summary.horizonSec+'s outcome';rows('potentialMissRows',misses,[x=>({value:time(x.timestamp)}),x=>({value:x.direction,cls:x.direction==='BULLISH'?'positive':'negative'}),x=>({value:String(x.regime).replaceAll('_',' ')}),x=>({value:num(x.price)}),x=>({value:num(x.forwardPrice)}),x=>({value:signedBps(x.forwardMoveBps),cls:x.forwardMoveBps>0?'positive':'negative'}),x=>({value:(x.failedGates||[]).join(' · '),cls:'decision-reasons'}),x=>({value:(x.reasons||[]).join(' · '),cls:'decision-reasons'})],'No potential hindsight misses detected at the '+summary.horizonSec+'-second / '+num(summary.thresholdBps,1)+'-bps review threshold.');rows('gateBlockRows',summary.gateBlocks||[],[x=>({value:String(x.reason).replaceAll('_',' '),cls:'decision-reasons'}),x=>({value:count(x.count)}),x=>({value:percent(summary.evaluations>0?100*x.count/summary.evaluations:0,1)})],'No entry gates have blocked an evaluation.')}
let scheduledDisplayRolloverAt=0,displayRolloverTimer;
function scheduleDisplayRollover(timestamp){if(!Number.isFinite(timestamp)||timestamp===scheduledDisplayRolloverAt)return;scheduledDisplayRolloverAt=timestamp;if(displayRolloverTimer)clearTimeout(displayRolloverTimer);const delay=Math.max(0,timestamp-Date.now()+250);displayRolloverTimer=setTimeout(()=>window.location.reload(),Math.min(delay,2147483647))}
const percent=(value,d=1)=>Number.isFinite(value)?num(value,d)+'%':'—',latency=value=>!Number.isFinite(value)?'—':value<1000?Math.round(value)+' ms':value<60000?num(value/1000,2)+' s':duration(value),signedBps=value=>Number.isFinite(value)?(value>0?'+':'')+num(value,1)+' bps':'—';
function tuneAverage(values){const finite=values.filter(Number.isFinite);return finite.length?finite.reduce((sum,value)=>sum+value,0)/finite.length:undefined}
function tuneStats(items){const submitted=items.filter(x=>x.orderTimestamp!==undefined),filled=submitted.filter(x=>x.firstFillTimestamp!==undefined),closed=items.filter(x=>['WIN','LOSS','FLAT'].includes(x.status));return{signals:items.length,submitted:submitted.length,filled:filled.length,closed:closed.length,fillRate:submitted.length?filled.length/submitted.length:0,replacementRate:submitted.length?submitted.filter(x=>(x.replacements||0)>0).length/submitted.length:0,winRate:closed.length?closed.filter(x=>x.status==='WIN').length/closed.length:0,avgPnl:tuneAverage(closed.map(x=>x.realizedPnl)),avgReturn:tuneAverage(closed.map(x=>x.returnPct)),avgSignalOrder:tuneAverage(items.map(x=>x.signalToOrderMs)),avgOrderFill:tuneAverage(items.map(x=>x.orderToFirstFillMs)),avgSlippage:tuneAverage(items.map(x=>x.entrySlippageBps)),avgMfe:tuneAverage(items.map(x=>x.maxFavorableExcursionPct)),avgMae:tuneAverage(items.map(x=>x.maxAdverseExcursionPct)),avgCapture:tuneAverage(items.map(x=>x.capturePct))}}
function updateSelect(id,values,label){const select=$(id),current=select.value,unique=[...new Set(values.filter(Boolean))].sort(),all=document.createElement('option');all.value='ALL';all.textContent=label;select.replaceChildren(all,...unique.map(value=>{const option=document.createElement('option');option.value=value;option.textContent=value.replaceAll('_',' ');return option}));select.value=unique.includes(current)?current:'ALL'}
let latestTuning={entries:[]},latestQualityOrders=[];
function renderTuning(tuning,orders){latestTuning=tuning||{entries:[]};latestQualityOrders=orders||[];const all=latestTuning.entries||[];updateSelect('tuneDirection',all.map(x=>x.direction),'All directions');updateSelect('tuneRegime',all.map(x=>x.regime),'All regimes');updateSelect('tuneOutcome',all.map(x=>x.status),'All outcomes');const direction=$('tuneDirection').value,regime=$('tuneRegime').value,outcome=$('tuneOutcome').value,items=all.filter(x=>(direction==='ALL'||x.direction===direction)&&(regime==='ALL'||x.regime===regime)&&(outcome==='ALL'||x.status===outcome)),stats=tuneStats(items);$('tuneSignals').textContent=count(stats.signals);$('tuneFillRate').textContent=percent(100*stats.fillRate);$('tuneSignalOrder').textContent=latency(stats.avgSignalOrder);$('tuneOrderFill').textContent=latency(stats.avgOrderFill);$('tuneSlippage').textContent=signedBps(stats.avgSlippage);$('tuneSlippage').className='value '+(stats.avgSlippage>0?'negative':Number.isFinite(stats.avgSlippage)?'positive':'');$('tuneReplacements').textContent=percent(100*stats.replacementRate);$('tuneMfe').textContent=percent(stats.avgMfe);$('tuneMfe').className='value '+(stats.avgMfe>0?'positive':'');$('tuneMae').textContent=percent(stats.avgMae);$('tuneMae').className='value '+(stats.avgMae<0?'negative':'');$('tuneCapture').textContent=percent(stats.avgCapture);
rows('tuningEntries',items,[x=>({value:time(x.signalTimestamp)}),x=>({value:(x.symbol||'No option')+' · '+x.direction+' '+x.kind+' · '+x.regime}),x=>({value:x.status,cls:'quality-status '+x.status}),x=>({value:x.decisionBid===undefined?'—':money(x.decisionBid)+' / '+money(x.decisionAsk)}),x=>({value:x.decisionSpreadPct===undefined?'—':percent(100*x.decisionSpreadPct,2)}),x=>({value:latency(x.signalToOrderMs)}),x=>({value:latency(x.orderToFirstFillMs)}),x=>({value:x.averageFillPrice===undefined?'—':money(x.averageFillPrice)}),x=>({value:signedBps(x.entrySlippageBps),cls:x.entrySlippageBps>0?'negative':Number.isFinite(x.entrySlippageBps)?'positive':''}),x=>({value:x.replacements??'—'}),x=>({value:percent(x.maxFavorableExcursionPct),cls:x.maxFavorableExcursionPct>0?'positive':''}),x=>({value:percent(x.maxAdverseExcursionPct),cls:x.maxAdverseExcursionPct<0?'negative':''}),x=>({value:x.returnPct===undefined?'—':percent(x.returnPct)+' / '+money(x.realizedPnl),cls:x.realizedPnl>0?'positive':x.realizedPnl<0?'negative':''}),x=>({value:(x.exitReason||'—')+(x.holdMs===undefined?'':' · '+duration(x.holdMs))})],'No strategy entries match these filters.');
const ids=new Set(items.map(x=>x.signalId)),filteredOrders=latestQualityOrders.filter(order=>direction==='ALL'&&regime==='ALL'&&outcome==='ALL'||(order.signalId&&ids.has(order.signalId)));rows('tuningOrders',filteredOrders,[x=>({value:time(x.timestamp)}),x=>({value:x.purpose}),x=>({value:x.symbol}),x=>({value:x.filledQuantity+' / '+x.quantity}),x=>({value:money(x.initialLimitPrice)}),x=>({value:money(x.limitPrice)}),x=>({value:x.averageFillPrice===undefined?'—':money(x.averageFillPrice)}),x=>({value:percent(x.fillPercentage)}),x=>({value:latency(x.firstFillLatencyMs)}),x=>({value:latency(x.completionLatencyMs)}),x=>({value:signedBps(x.priceImprovementBps),cls:x.priceImprovementBps>0?'positive':x.priceImprovementBps<0?'negative':''}),x=>({value:x.replacements}),x=>({value:x.status})],'No orders match these filters.');
const key=$('tuneBreakdown').value,groups=new Map();for(const item of items){const label=item[key]||'UNKNOWN';if(!groups.has(label))groups.set(label,[]);groups.get(label).push(item)}const compared=[...groups.entries()].map(([label,group])=>({label,...tuneStats(group)})).sort((a,b)=>b.signals-a.signals);rows('tuningGroups',compared,[x=>({value:String(x.label).replaceAll('_',' ')}),x=>({value:x.signals}),x=>({value:x.filled}),x=>({value:percent(100*x.fillRate)}),x=>({value:x.closed}),x=>({value:percent(100*x.winRate)}),x=>({value:money(x.avgPnl),cls:x.avgPnl>0?'positive':x.avgPnl<0?'negative':''}),x=>({value:percent(x.avgReturn),cls:x.avgReturn>0?'positive':x.avgReturn<0?'negative':''}),x=>({value:signedBps(x.avgSlippage),cls:x.avgSlippage>0?'negative':x.avgSlippage<0?'positive':''}),x=>({value:latency(x.avgOrderFill)}),x=>({value:percent(x.avgMfe),cls:x.avgMfe>0?'positive':''}),x=>({value:percent(x.avgMae),cls:x.avgMae<0?'negative':''})],'No grouped samples match these filters.')}
document.querySelectorAll('.tab').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(tab=>{const active=tab===button;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active))});document.querySelectorAll('.tab-panel').forEach(panel=>panel.classList.toggle('active',panel.id===button.dataset.tab))}));
['tuneDirection','tuneRegime','tuneOutcome','tuneBreakdown'].forEach(id=>$(id).addEventListener('change',()=>renderTuning(latestTuning,latestQualityOrders)));
$('decisionView').addEventListener('change',()=>renderDecisionRows(latestDecisions));
async function refresh(){try{const response=await fetch('/api/dashboard',{cache:'no-store'});if(!response.ok)throw new Error('Dashboard API '+response.status);const data=await response.json(),p=data.performance,h=data.health||{},live=data.liveData||{eventCounts:{},recentEvents:[],totalEvents:0,uptimeMs:0,persistenceEnabled:false,quoteSampleIntervalMs:0,retentionDays:0};scheduleDisplayRollover(data.nextDisplayRolloverAt);$('stateText').textContent=(data.readiness||'unknown').toUpperCase()+' · '+(h.executionMode||'paper');$('state').className=data.readiness||'degraded';setStatus('engineState','engineDetail','LIVE','API heartbeat · uptime '+duration(live.uptimeMs),'ok');setStatus('sipState','sipDetail',h.websocketConnected?'CONNECTED':'DISCONNECTED',count(live.eventCounts.stock_quote)+' display-day quotes · '+age(live.lastEventAgeMs),h.websocketConnected?'ok':'halted');setStatus('opraState','opraDetail',h.optionWebsocketConnected?'CONNECTED':'DISCONNECTED',count(live.eventCounts.option_quote)+' display-day quotes · '+age(live.lastEventAgeMs),h.optionWebsocketConnected?'ok':'halted');const dbLevel=!live.persistenceEnabled?'degraded':h.recorderHealthy?'ok':'halted',retentionDetail=(live.quoteSampleIntervalMs===0?'full-resolution quotes':live.quoteSampleIntervalMs+' ms quote baseline')+' · '+live.retentionDays+'d raw retention';setStatus('databaseState','databaseDetail',!live.persistenceEnabled?'DISABLED':h.recorderHealthy?'WRITING':'UNHEALTHY',live.persistenceEnabled?retentionDetail:'Persistence is not enabled',dbLevel);setStatus('brokerState','brokerDetail',h.brokerAvailable?'CONNECTED':'UNAVAILABLE',(h.executionMode||'paper').toUpperCase()+' · '+count(h.openOrderCount)+' open order(s)',h.brokerAvailable?'ok':'degraded');setStatus('marketState','marketDetail',String(h.marketClockState||'unknown').replaceAll('-',' ').toUpperCase(),h.positionsReconciled?'Positions reconciled':'Reconciliation required',h.positionsReconciled?'ok':'halted');const strategyRequired=h.executionEnabled&&h.marketClockState==='market-open',strategyReady=h.strategyStateReady===true||!strategyRequired,strategyStatus=String(h.strategyStateStatus||(!strategyRequired?'NOT REQUIRED':'UNKNOWN')).replaceAll('_',' ');setStatus('strategyState','strategyDetail',strategyReady?'READY':'BLOCKED',strategyStatus+' · '+count(h.restoredStockEvents)+' SIP events / '+count(h.restoredFeatureBars??h.restoredBars)+' bars',strategyReady?'ok':'halted');const signalsFired=p.signalsFired??p.entriesFired??0,optionsSelected=p.optionsSelected??0;$('signalsFired').textContent=count(signalsFired);$('optionsSelected').textContent=count(optionsSelected);$('optionSelectionDetail').textContent=percent(signalsFired>0?100*optionsSelected/signalsFired:0)+' of signals';$('riskAllowed').textContent=count(p.riskAllowed);$('riskDetail').textContent=count(p.riskBlocked)+' blocked';$('entryOrders').textContent=p.entryOrders;$('filledEntries').textContent=p.filledEntryOrders;$('closedTrades').textContent=p.closedTrades;$('winRate').textContent=(p.winRate*100).toFixed(1)+'%';$('pnl').textContent=money(p.realizedPnl);$('pnl').className='value '+(p.realizedPnl>0?'positive':p.realizedPnl<0?'negative':'');$('openPnl').textContent=money(p.unrealizedPnl);$('openPnl').className='value '+(p.unrealizedPnl>0?'positive':p.unrealizedPnl<0?'negative':'');$('totalPnl').textContent=money(p.totalPnl);$('totalPnl').className='value '+(p.totalPnl>0?'positive':p.totalPnl<0?'negative':'');$('profitFactor').textContent=p.profitFactor===null?'—':num(p.profitFactor);$('openTrades').textContent=p.openTrades;$('subscriptions').textContent=h.subscribedOptionContracts||0;$('feedEvents').textContent=count(live.totalEvents);$('sipQuotes').textContent=count(live.eventCounts.stock_quote);$('sipTrades').textContent=count(live.eventCounts.stock_trade);$('opraQuotes').textContent=count(live.eventCounts.option_quote);$('featureEvents').textContent=count(live.eventCounts.feature_snapshot);$('feedAge').textContent=live.lastEventAgeMs===undefined?'—':duration(live.lastEventAgeMs);renderOrders(data.orderCards||data.activeOrders);
rows('signals',data.signals,[x=>({value:time(x.timestamp)}),x=>({value:x.direction}),x=>({value:x.kind}),x=>({value:x.regime}),x=>({value:num(x.projectedMoveBps)+' bps'}),x=>({value:x.candidate}),x=>({value:x.riskStatus||'—',cls:x.riskStatus==='ALLOWED'?'positive':x.riskStatus==='BLOCKED'?'negative':''}),x=>({value:x.status}),x=>({value:(x.riskReasons||x.reasons||[]).join(', ')})]);
rows('orders',data.orders,[x=>({value:time(x.timestamp)}),x=>({value:x.purpose}),x=>({value:x.symbol}),x=>({value:x.side}),x=>({value:x.quantity}),x=>({value:money(x.limitPrice)}),x=>({value:x.filledQuantity}),x=>({value:x.averageFillPrice?money(x.averageFillPrice):'—'}),x=>({value:x.status})]);
renderTuning(data.tuning||{entries:[]},data.orders||[]);renderPotentialMisses(data.tuning);
rows('trades',data.trades,[x=>({value:time(x.entryTimestamp)}),x=>({value:time(x.exitTimestamp)}),x=>({value:x.symbol}),x=>({value:x.direction}),x=>({value:x.quantity}),x=>({value:money(x.averageEntryPrice)}),x=>({value:x.averageExitPrice?money(x.averageExitPrice):'—'}),x=>({value:money(x.realizedPnl),cls:x.realizedPnl>0?'positive':x.realizedPnl<0?'negative':''}),x=>({value:x.returnPct===undefined?'—':num(x.returnPct)+'%'}),x=>({value:x.exitReason}),x=>({value:x.status})]);renderDecisionRows(data.decisions||[]);rows('feedEventsBody',live.recentEvents||[],[x=>({value:time(x.receivedTimestamp)}),x=>({value:x.channel.replaceAll('_',' ')}),x=>({value:x.type.replaceAll('_',' ')}),x=>({value:x.symbol}),x=>({value:x.summary}),x=>({value:x.latencyMs+' ms'}),x=>({value:storagePolicy(x,live),cls:live.persistenceEnabled?'positive':'muted'})],'No market events received yet. Connection cards above continue to show system liveness.');$('updated').textContent='Display day '+data.displayDate+' · Updated '+new Date(data.generatedAt).toLocaleString()+' · resets at 10:00 PM Pacific';}catch(error){$('stateText').textContent='DASHBOARD ERROR';$('state').className='halted';$('updated').textContent=String(error)}}refresh();setInterval(refresh,1000);
</script></body></html>`;
}
