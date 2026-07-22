import type { AuditEvent, AuditRecorder } from "./recorder.js";
import type { HistoricalMarketEvent, MarketHistorySink } from "../history/types.js";

export interface DashboardSignal {
  id: string;
  timestamp: number;
  direction: string;
  kind: string;
  regime: string;
  projectedMoveBps?: number;
  candidate?: string;
  status: "FIRED" | "NO_ELIGIBLE_OPTION" | "ORDER_SUBMITTED" | "ORDER_BLOCKED";
  brokerOrderId?: string;
  reasons: string[];
}

export interface DashboardOrder {
  clientOrderId: string;
  brokerOrderId?: string;
  timestamp: number;
  updatedAt: number;
  purpose: "ENTRY" | "EXIT";
  symbol: string;
  side: string;
  quantity: number;
  limitPrice: number;
  status: string;
  filledQuantity: number;
  averageFillPrice?: number;
  replacements: number;
  exitReason?: string;
}

export interface DashboardTrade {
  id: string;
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
  returnPct?: number;
  exitReason?: string;
  status: "OPEN" | "PARTIAL_EXIT" | "CLOSED";
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
}

export interface DashboardPerformance {
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
  lastMarketDate?: string;
  lastExecutionError?: string;
  performance: DashboardPerformance;
  activeOrders: DashboardActiveOrder[];
  signals: DashboardSignal[];
  orders: DashboardOrder[];
  trades: DashboardTrade[];
}

interface MutableTrade extends Omit<DashboardTrade,
  "remainingQuantity" | "currentBid" | "currentAsk" | "markPrice" | "lastQuoteTimestamp" |
  "unrealizedPnl" | "unrealizedReturnPct"> {
  exitedQuantity: number;
  exitNotional: number;
}

interface DashboardOptionQuote {
  timestamp: number;
  bidPrice: number;
  askPrice: number;
}

/** Reconstructible read model derived only from durable execution audit events. */
export class TradingDashboardStore implements AuditRecorder, MarketHistorySink {
  readonly #startedAt: number;
  readonly #signals = new Map<string, DashboardSignal>();
  readonly #orders = new Map<string, DashboardOrder>();
  readonly #openTrades = new Map<string, MutableTrade>();
  readonly #closedTrades: MutableTrade[] = [];
  readonly #latestOptionQuotes = new Map<string, DashboardOptionQuote>();
  #lastMarketDate: string | undefined;
  #lastExecutionError: string | undefined;

  constructor(startedAt = Date.now()) { this.#startedAt = startedAt; }

  record(event: AuditEvent): void {
    if (event.marketDate) this.#lastMarketDate = event.marketDate;
    if (event.type === "live_signal_selection") this.#recordSignal(event);
    else if (event.type === "paper_order_submission_result") this.#recordSubmissionResult(event);
    else if (event.type === "broker_order_request") this.#recordOrderRequest(event);
    else if (event.type === "broker_order_state") this.#recordOrderState(event);
    else if (event.type === "broker_order_replaced") this.#recordOrderReplacement(event);
    else if (event.type === "entry_fill") this.#recordEntryFill(event);
    else if (event.type === "exit_fill") this.#recordExitFill(event);
    else if (event.type === "execution_halted") {
      this.#lastExecutionError = stringValue(event.data.reason) ?? "Execution halted";
    }
  }

  recordMarketEvent(event: HistoricalMarketEvent): void {
    if (event.type !== "option_quote") return;
    const timestamp = numberValue(event.data.timestamp) ?? event.providerTimestamp;
    const bidPrice = numberValue(event.data.bidPrice);
    const askPrice = numberValue(event.data.askPrice);
    if (bidPrice === undefined || askPrice === undefined || bidPrice < 0 || askPrice < bidPrice) return;
    const previous = this.#latestOptionQuotes.get(event.symbol);
    if (!previous || timestamp >= previous.timestamp) {
      this.#latestOptionQuotes.set(event.symbol, { timestamp, bidPrice, askPrice });
    }
    this.#pruneMap(this.#latestOptionQuotes, 5_000);
  }

  healthy(): boolean { return true; }

  snapshot(): TradingDashboardSnapshot {
    const generatedAt = Date.now();
    const closed = this.#closedTrades;
    const realizedPnl = [...closed, ...this.#openTrades.values()].reduce((sum, trade) => sum + trade.realizedPnl, 0);
    const wins = closed.filter((trade) => trade.realizedPnl > 0).length;
    const losses = closed.filter((trade) => trade.realizedPnl < 0).length;
    const grossProfit = closed.reduce((sum, trade) => sum + Math.max(0, trade.realizedPnl), 0);
    const grossLoss = Math.abs(closed.reduce((sum, trade) => sum + Math.min(0, trade.realizedPnl), 0));
    const pnls = closed.map((trade) => trade.realizedPnl);
    const orders = [...this.#orders.values()];
    const activeOrders = this.#activeOrders(generatedAt, orders);
    const unrealizedPnl = activeOrders.reduce((sum, order) => sum + (order.unrealizedPnl ?? 0), 0);
    return {
      startedAt: this.#startedAt,
      generatedAt,
      ...(this.#lastMarketDate ? { lastMarketDate: this.#lastMarketDate } : {}),
      ...(this.#lastExecutionError ? { lastExecutionError: this.#lastExecutionError } : {}),
      performance: {
        entriesFired: this.#signals.size,
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
      signals: [...this.#signals.values()].slice(-250).reverse().map((signal) => ({ ...signal, reasons: [...signal.reasons] })),
      orders: orders.slice(-250).reverse().map((order) => ({ ...order })),
      trades: [...closed, ...this.#openTrades.values()].slice(-250).reverse().map((trade) => this.#publicTrade(trade)),
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
        id: trade.id,
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
        elapsedMs: Math.max(0, generatedAt - order.timestamp),
        workingOrder: publicWorkingOrder(order),
      });
    }
    return cards.sort((a, b) => (b.entryTimestamp ?? 0) - (a.entryTimestamp ?? 0));
  }

  #publicTrade(trade: MutableTrade): DashboardTrade {
    const remainingQuantity = Math.max(0, trade.quantity - trade.exitedQuantity);
    const quote = trade.status === "CLOSED" ? undefined : this.#latestOptionQuotes.get(trade.symbol);
    const markPrice = quote?.bidPrice;
    const unrealizedPnl = markPrice === undefined
      ? undefined : 100 * remainingQuantity * (markPrice - trade.averageEntryPrice);
    const openCost = 100 * remainingQuantity * trade.averageEntryPrice;
    return {
      id: trade.id,
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
      ...(trade.returnPct !== undefined ? { returnPct: trade.returnPct } : {}),
      ...(trade.exitReason ? { exitReason: trade.exitReason } : {}),
      status: trade.status,
    };
  }

  #recordSignal(event: AuditEvent): void {
    const id = stringValue(event.data.signalId);
    if (!id) return;
    const candidate = stringValue(event.data.candidate);
    this.#signals.set(id, {
      id,
      timestamp: numberValue(event.data.timestamp) ?? event.timestamp,
      direction: stringValue(event.data.direction) ?? "UNKNOWN",
      kind: stringValue(event.data.kind) ?? "UNKNOWN",
      regime: stringValue(event.data.regime) ?? "UNKNOWN",
      ...(numberValue(event.data.projectedMoveBps) !== undefined
        ? { projectedMoveBps: numberValue(event.data.projectedMoveBps)! } : {}),
      ...(candidate ? { candidate } : {}),
      status: candidate ? "FIRED" : "NO_ELIGIBLE_OPTION",
      reasons: [],
    });
    this.#pruneMap(this.#signals, 1_000);
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
    this.#orders.set(clientOrderId, {
      clientOrderId,
      timestamp: numberValue(order.submittedAt) ?? event.timestamp,
      updatedAt: event.timestamp,
      purpose,
      symbol: stringValue(order.symbol) ?? "UNKNOWN",
      side: stringValue(order.side) ?? "UNKNOWN",
      quantity: numberValue(order.requestedQuantity) ?? 0,
      limitPrice: numberValue(order.limitPrice) ?? 0,
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
    existing.filledQuantity = numberValue(broker.filledQuantity) ?? numberValue(local.filledQuantity) ?? existing.filledQuantity;
    existing.limitPrice = numberValue(local.limitPrice) ?? existing.limitPrice;
    existing.replacements = numberValue(local.replacements) ?? existing.replacements;
    const brokerOrderId = stringValue(broker.id);
    if (brokerOrderId) existing.brokerOrderId = brokerOrderId;
    const averageFillPrice = positiveNumber(broker.averageFillPrice) ?? positiveNumber(local.averageFillPrice);
    if (averageFillPrice !== undefined) existing.averageFillPrice = averageFillPrice;
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
    if (existing) {
      existing.quantity = Math.max(existing.quantity, quantity);
      existing.averageEntryPrice = averageEntryPrice;
      if (stopPrice !== undefined) existing.stopPrice = stopPrice;
      if (targetPrice !== undefined) existing.targetPrice = targetPrice;
      existing.status = "OPEN";
    } else {
      this.#openTrades.set(symbol, {
        id, symbol,
        direction: stringValue(position.direction) ?? "UNKNOWN",
        entryTimestamp,
        quantity,
        averageEntryPrice,
        ...(stopPrice !== undefined ? { stopPrice } : {}),
        ...(targetPrice !== undefined ? { targetPrice } : {}),
        realizedPnl: 0,
        status: "OPEN",
        exitedQuantity: 0,
        exitNotional: 0,
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
        realizedPnl: 0,
        status: "OPEN",
        exitedQuantity: 0,
        exitNotional: 0,
      };
      this.#openTrades.set(symbol, trade);
    }
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

  #pruneMap<K, V>(map: Map<K, V>, maximum: number): void {
    while (map.size > maximum) {
      const first = map.keys().next();
      if (first.done) return;
      map.delete(first.value);
    }
  }
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
:root{color-scheme:dark;--bg:#07111f;--panel:#0e1b2e;--line:#20324b;--text:#e7eef9;--muted:#91a4bd;--green:#35d07f;--red:#ff667a;--blue:#58a6ff;--amber:#f5c451}*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#06101c,#0a1830);color:var(--text);font:14px ui-sans-serif,system-ui,sans-serif}main{max-width:1500px;margin:auto;padding:24px}header{display:flex;justify-content:space-between;gap:18px;align-items:center;margin-bottom:20px}h1{font-size:24px;margin:0}h2{font-size:16px;margin:0 0 12px}.sub,.muted{color:var(--muted)}#state{font-weight:700;padding:8px 12px;border:1px solid var(--line);border-radius:999px}.ok{color:var(--green)}.degraded{color:var(--amber)}.halted{color:var(--red)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px;margin-bottom:18px}.card,.panel{background:rgba(14,27,46,.94);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 30px #0003}.card{padding:14px}.card .value{font-size:23px;font-weight:750;margin-top:6px}.panel{padding:16px;margin:14px 0;overflow:auto}.live-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:14px}.live-card{background:linear-gradient(145deg,#12243d,#0b1729);border:1px solid #294262;border-radius:13px;padding:16px;min-width:0;box-shadow:inset 3px 0 0 var(--blue)}.live-card.profit{box-shadow:inset 3px 0 0 var(--green)}.live-card.loss{box-shadow:inset 3px 0 0 var(--red)}.live-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.live-symbol{font-weight:750;font-size:16px;overflow-wrap:anywhere}.badge{display:inline-block;margin-top:5px;padding:3px 7px;border-radius:999px;background:#58a6ff1c;color:var(--blue);font-size:11px;font-weight:700;letter-spacing:.04em}.live-pnl{text-align:right;font-size:22px;font-weight:800}.live-return{text-align:right;font-size:12px;margin-top:3px}.live-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:16px}.live-field span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}.live-field strong{font-size:14px}.order-strip{border-top:1px solid var(--line);margin-top:15px;padding-top:12px;display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:12px}.empty{color:var(--muted);padding:22px;text-align:center;border:1px dashed var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;min-width:850px}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}tbody tr:hover{background:#ffffff08}.positive{color:var(--green)}.negative{color:var(--red)}@media(max-width:700px){main{padding:14px}header{align-items:flex-start;flex-direction:column}.live-fields{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head><body><main><header><div><h1>SPY 0DTE Option Day-Trade Dashboard</h1><div class="sub">Live SIP signals · OPRA options · Alpaca paper execution · PostgreSQL history</div></div><div id="state">Loading…</div></header>
<section class="cards">
<div class="card"><div class="muted">Entries Fired</div><div class="value" id="entries">0</div></div>
<div class="card"><div class="muted">Entry Orders</div><div class="value" id="entryOrders">0</div></div>
<div class="card"><div class="muted">Closed Trades</div><div class="value" id="closedTrades">0</div></div>
<div class="card"><div class="muted">Win Rate</div><div class="value" id="winRate">0%</div></div>
<div class="card"><div class="muted">Realized P&amp;L</div><div class="value" id="pnl">$0.00</div></div>
<div class="card"><div class="muted">Open P&amp;L</div><div class="value" id="openPnl">$0.00</div></div>
<div class="card"><div class="muted">Total P&amp;L</div><div class="value" id="totalPnl">$0.00</div></div>
<div class="card"><div class="muted">Profit Factor</div><div class="value" id="profitFactor">—</div></div>
<div class="card"><div class="muted">Open Trades</div><div class="value" id="openTrades">0</div></div>
<div class="card"><div class="muted">Option Subs</div><div class="value" id="subscriptions">0</div></div>
</section>
<section class="panel"><h2>Live Orders</h2><div id="liveOrders" class="live-grid"><div class="empty">Waiting for an active option order…</div></div></section>
<section class="panel"><h2>Entries Fired</h2><table><thead><tr><th>Time</th><th>Direction</th><th>Kind</th><th>Regime</th><th>Projected</th><th>Option</th><th>Status</th><th>Reason</th></tr></thead><tbody id="signals"></tbody></table></section>
<section class="panel"><h2>Orders &amp; Executions</h2><table><thead><tr><th>Time</th><th>Purpose</th><th>Option</th><th>Side</th><th>Qty</th><th>Limit</th><th>Filled</th><th>Avg Fill</th><th>Status</th></tr></thead><tbody id="orders"></tbody></table></section>
<section class="panel"><h2>Trade Performance</h2><table><thead><tr><th>Entry</th><th>Exit</th><th>Option</th><th>Direction</th><th>Qty</th><th>Entry Px</th><th>Exit Px</th><th>P&amp;L</th><th>Return</th><th>Exit Reason</th><th>Status</th></tr></thead><tbody id="trades"></tbody></table></section>
<div class="muted" id="updated"></div></main><script>
const $=id=>document.getElementById(id),money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n||0),num=(n,d=2)=>Number.isFinite(n)?n.toFixed(d):'—',time=n=>n?new Date(n).toLocaleString('en-US',{timeZone:'America/New_York'}):'—';
function cell(value,cls=''){const td=document.createElement('td');td.textContent=String(value??'—');if(cls)td.className=cls;return td}function rows(id,data,fields){const body=$(id);body.replaceChildren(...data.map(item=>{const tr=document.createElement('tr');for(const field of fields){const result=field(item);tr.append(cell(result.value,result.cls||''))}return tr}))}
function node(tag,cls,text){const value=document.createElement(tag);if(cls)value.className=cls;if(text!==undefined)value.textContent=String(text);return value}function field(label,value){const wrap=node('div','live-field'),caption=node('span','',label),content=node('strong','',value);wrap.append(caption,content);return wrap}function duration(ms){if(!Number.isFinite(ms))return '—';const seconds=Math.floor(ms/1000),minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60);return hours>0?hours+'h '+(minutes%60)+'m':minutes>0?minutes+'m '+(seconds%60)+'s':seconds+'s'}
function renderLiveOrders(items){const root=$('liveOrders');if(!items||items.length===0){root.replaceChildren(node('div','empty','No active option orders or open option positions.'));return}const cards=items.map(x=>{const pnl=x.totalPnl===undefined?x.unrealizedPnl:x.totalPnl,pnlClass=pnl>0?'positive':pnl<0?'negative':'',card=node('article','live-card '+(pnl>0?'profit':pnl<0?'loss':'')),head=node('div','live-head'),identity=node('div'),symbol=node('div','live-symbol',x.symbol),badge=node('div','badge',x.stage.replaceAll('_',' ')),pnlBox=node('div'),pnlValue=node('div','live-pnl '+pnlClass,pnl===undefined?'AWAITING FILL':money(pnl)),pnlReturn=node('div','live-return '+pnlClass,x.unrealizedReturnPct===undefined?'P&L from executable bid':num(x.unrealizedReturnPct)+'% open return');identity.append(symbol,badge);pnlBox.append(pnlValue,pnlReturn);head.append(identity,pnlBox);const fields=node('div','live-fields');fields.append(field('Position',x.remainingQuantity+' / '+x.quantity+' contracts'),field('Entry',x.entryPrice===undefined?'—':money(x.entryPrice)),field('Bid / Ask',x.currentBid===undefined?'—':money(x.currentBid)+' / '+money(x.currentAsk)),field('Stop',x.stopPrice===undefined?'—':money(x.stopPrice)),field('Target',x.targetPrice===undefined?'—':money(x.targetPrice)),field('Elapsed',duration(x.elapsedMs)),field('Realized',money(x.realizedPnl)),field('Quote age',x.quoteAgeMs===undefined?'Waiting for quote':duration(x.quoteAgeMs)),field('Direction',x.direction||'Pending entry'));card.append(head,fields);if(x.workingOrder){const strip=node('div','order-strip'),left=node('span','',x.workingOrder.purpose+' '+x.workingOrder.status+' · '+x.workingOrder.filledQuantity+'/'+x.workingOrder.requestedQuantity+' filled'),right=node('span','',money(x.workingOrder.limitPrice)+' limit · '+x.workingOrder.replacements+' replaces');strip.append(left,right);card.append(strip)}return card});root.replaceChildren(...cards)}
async function refresh(){try{const response=await fetch('/api/dashboard',{cache:'no-store'});const data=await response.json(),p=data.performance,h=data.health||{};$('state').textContent=(data.readiness||'unknown').toUpperCase()+' · '+(h.executionMode||'paper');$('state').className=data.readiness||'degraded';$('entries').textContent=p.entriesFired;$('entryOrders').textContent=p.entryOrders;$('closedTrades').textContent=p.closedTrades;$('winRate').textContent=(p.winRate*100).toFixed(1)+'%';$('pnl').textContent=money(p.realizedPnl);$('pnl').className='value '+(p.realizedPnl>0?'positive':p.realizedPnl<0?'negative':'');$('openPnl').textContent=money(p.unrealizedPnl);$('openPnl').className='value '+(p.unrealizedPnl>0?'positive':p.unrealizedPnl<0?'negative':'');$('totalPnl').textContent=money(p.totalPnl);$('totalPnl').className='value '+(p.totalPnl>0?'positive':p.totalPnl<0?'negative':'');$('profitFactor').textContent=p.profitFactor===null?'—':num(p.profitFactor);$('openTrades').textContent=p.openTrades;$('subscriptions').textContent=h.subscribedOptionContracts||0;renderLiveOrders(data.activeOrders);
rows('signals',data.signals,[x=>({value:time(x.timestamp)}),x=>({value:x.direction}),x=>({value:x.kind}),x=>({value:x.regime}),x=>({value:num(x.projectedMoveBps)+' bps'}),x=>({value:x.candidate}),x=>({value:x.status}),x=>({value:(x.reasons||[]).join(', ')})]);
rows('orders',data.orders,[x=>({value:time(x.timestamp)}),x=>({value:x.purpose}),x=>({value:x.symbol}),x=>({value:x.side}),x=>({value:x.quantity}),x=>({value:money(x.limitPrice)}),x=>({value:x.filledQuantity}),x=>({value:x.averageFillPrice?money(x.averageFillPrice):'—'}),x=>({value:x.status})]);
rows('trades',data.trades,[x=>({value:time(x.entryTimestamp)}),x=>({value:time(x.exitTimestamp)}),x=>({value:x.symbol}),x=>({value:x.direction}),x=>({value:x.quantity}),x=>({value:money(x.averageEntryPrice)}),x=>({value:x.averageExitPrice?money(x.averageExitPrice):'—'}),x=>({value:money(x.realizedPnl),cls:x.realizedPnl>0?'positive':x.realizedPnl<0?'negative':''}),x=>({value:x.returnPct===undefined?'—':num(x.returnPct)+'%'}),x=>({value:x.exitReason}),x=>({value:x.status})]);$('updated').textContent='Updated '+new Date(data.generatedAt).toLocaleString();}catch(error){$('state').textContent='DASHBOARD ERROR';$('state').className='halted';$('updated').textContent=String(error)}}refresh();setInterval(refresh,1000);
</script></body></html>`;
}
