export type DashboardOrderCardStage =
  | "ENTRY_WORKING"
  | "PARTIAL_ENTRY"
  | "POSITION_OPEN"
  | "EXIT_WORKING"
  | "CLOSED"
  | "CANCELLED"
  | "REJECTED";

export interface DashboardOrderDynamicsUpdate {
  timestamp: number;
  stage: DashboardOrderCardStage;
  status: string;
  remainingQuantity: number;
  realizedPnl: number;
  currentBid?: number;
  currentAsk?: number;
  unrealizedPnl?: number;
  totalPnl?: number;
  pnlChange?: number;
}

/**
 * Stable card for one entry-through-exit lifecycle. Completed cards and every
 * observed P&L/status update are stored independently of the dashboard day.
 */
export interface DashboardOrderCard {
  id: string;
  signalId?: string;
  symbol: string;
  direction?: string;
  active: boolean;
  stage: DashboardOrderCardStage;
  status: string;
  quantity: number;
  remainingQuantity: number;
  entryPrice?: number;
  exitPrice?: number;
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
  exitTimestamp?: number;
  elapsedMs?: number;
  lastQuoteTimestamp?: number;
  quoteAgeMs?: number;
  exitReason?: string;
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
  updates: DashboardOrderDynamicsUpdate[];
}

export interface OrderCardPersistence {
  saveOrderCard(card: DashboardOrderCard): Promise<void>;
}
