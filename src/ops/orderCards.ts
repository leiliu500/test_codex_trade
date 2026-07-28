import { defaultConfig } from "../config.js";

export type DashboardOrderCardStage =
  | "ENTRY_WORKING"
  | "PARTIAL_ENTRY"
  | "POSITION_OPEN"
  | "EXIT_WORKING"
  | "CLOSED"
  | "CANCELLED"
  | "REJECTED";

export type DashboardOrderEntryQuality =
  | "GOOD"
  | "GOOD_ENTRY_POOR_EXIT"
  | "MARGINAL"
  | "POOR"
  | "EVALUATING"
  | "NOT_RATED";

export interface DashboardOptionContinuation {
  deltaDollars?: number;
  gammaDollars?: number;
  vegaDollars?: number;
  thetaDollars?: number;
  holdingCostDollars?: number;
  uncertaintyDollars?: number;
  expectedChangeDollars?: number;
  lcbDollars?: number;
  ivCrushDetected?: boolean;
}

export interface DashboardOrderManagement {
  lifecycle?: string;
  tradeState?: string;
  managementDecision?: "HOLD" | "EXIT";
  managementReason?: string;
  exitTriggers?: string[];
  executablePnl?: number;
  liquidationPrice?: number;
  protectedFloorPnl?: number;
  floorBufferDollars?: number;
  highWaterPnl?: number;
  lowWaterPnl?: number;
  recoveryProbability?: number;
  continuationLcbDollars?: number;
  reversalCusum?: number;
  zeroCrossings?: number;
  pnlObservationCount?: number;
  optionContinuation?: DashboardOptionContinuation;
}

export interface DashboardOrderDynamicsUpdate extends DashboardOrderManagement {
  timestamp: number;
  stage: DashboardOrderCardStage;
  status: string;
  source?: "STATUS" | "PNL";
  remainingQuantity: number;
  realizedPnl: number;
  currentBid?: number;
  currentAsk?: number;
  unrealizedPnl?: number;
  totalPnl?: number;
  pnlChange?: number;
}

export interface DashboardOrderQuote {
  timestamp: number;
  bidPrice: number;
  askPrice: number;
}

/**
 * Stable card for one entry-through-exit lifecycle. Completed cards and every
 * observed P&L/status update are stored independently of the dashboard day.
 */
export interface DashboardOrderCard extends DashboardOrderManagement {
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
  entryTimestamp?: number;
  exitTimestamp?: number;
  elapsedMs?: number;
  lastQuoteTimestamp?: number;
  quoteAgeMs?: number;
  exitReason?: string;
  entryQuality?: DashboardOrderEntryQuality;
  entryQualityReason?: string;
  bestObservedPnl?: number;
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
  updates: DashboardOrderDynamicsUpdate[];
}

export interface OrderCardPersistence {
  saveOrderCard(card: DashboardOrderCard): Promise<void>;
}

export function classifyOrderCardEntryQuality(card: DashboardOrderCard): {
  entryQuality: DashboardOrderEntryQuality;
  entryQualityReason: string;
  bestObservedPnl?: number;
} {
  const observedPnl = card.updates
    .map((update) => update.totalPnl ?? update.unrealizedPnl)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (observedPnl.length === 0) {
    return {
      entryQuality: "NOT_RATED",
      entryQualityReason: "No post-fill P&L observations are available yet.",
    };
  }

  const bestObservedPnl = Math.max(...observedPnl);
  const finalPnl = card.totalPnl ?? card.realizedPnl;
  const epsilon = 0.005;
  const meaningfulProfit = defaultConfig.risk.directWinnerActivationDollars;
  const protectedEntry = card.tradeState === "PROTECTED_WINNER" ||
    card.tradeState === "PROTECTED_RECOVERED";
  const meaningfulProfitReached = protectedEntry ||
    bestObservedPnl >= meaningfulProfit - epsilon;
  if (card.active) {
    if (meaningfulProfitReached) {
      return {
        entryQuality: "GOOD",
        entryQualityReason:
          `Reached meaningful entry protection with best observed P&L ${formatSignedPnl(bestObservedPnl)}.`,
        bestObservedPnl,
      };
    }
    return {
      entryQuality: "EVALUATING",
      entryQualityReason:
        `Position is active; best observed P&L is ${formatSignedPnl(bestObservedPnl)} and entry protection requires ${formatSignedPnl(meaningfulProfit)}.`,
      bestObservedPnl,
    };
  }
  if (meaningfulProfitReached) {
    if (finalPnl > epsilon) {
      return {
        entryQuality: "GOOD",
        entryQualityReason:
          `Reached meaningful entry protection at ${formatSignedPnl(bestObservedPnl)} and closed ${formatSignedPnl(finalPnl)}.`,
        bestObservedPnl,
      };
    }
    return {
      entryQuality: "GOOD_ENTRY_POOR_EXIT",
      entryQualityReason:
        `Reached meaningful entry protection at ${formatSignedPnl(bestObservedPnl)}, but closed ${formatSignedPnl(finalPnl)}.`,
      bestObservedPnl,
    };
  }
  if (bestObservedPnl >= -epsilon) {
    return {
      entryQuality: "MARGINAL",
      entryQualityReason:
        `Reached only ${formatSignedPnl(bestObservedPnl)}, below the ${formatSignedPnl(meaningfulProfit)} entry-quality threshold, and closed ${formatSignedPnl(finalPnl)}.`,
      bestObservedPnl,
    };
  }
  return {
    entryQuality: "POOR",
    entryQualityReason:
      `Never recovered the opening spread; best observed P&L was ${formatSignedPnl(bestObservedPnl)} and never approached ${formatSignedPnl(meaningfulProfit)} protection.`,
    bestObservedPnl,
  };
}

/**
 * Rebuilds the reviewable P&L timeline for a card from durable option quotes.
 * Existing lifecycle/status rows are retained, while only actual bid/P&L
 * changes are added. The operation is idempotent so it is safe at every start.
 */
export function mergeOrderCardQuoteDynamics(
  card: DashboardOrderCard,
  quotes: readonly DashboardOrderQuote[],
): DashboardOrderCard {
  if (!(card.entryPrice !== undefined && card.entryPrice > 0) ||
      card.entryTimestamp === undefined || card.quantity <= 0) {
    const cloned = cloneCard(card);
    return { ...cloned, ...classifyOrderCardEntryQuality(cloned) };
  }

  const statusUpdates = card.updates.map((update, index) => ({
    update: { ...update },
    index,
  }));
  const quoteUpdates: Array<{ update: DashboardOrderDynamicsUpdate; index: number }> = [];
  const sortedQuotes = [...quotes]
    .filter((quote) =>
      Number.isFinite(quote.timestamp) &&
      Number.isFinite(quote.bidPrice) &&
      Number.isFinite(quote.askPrice) &&
      quote.bidPrice >= 0 &&
      quote.askPrice >= quote.bidPrice &&
      quote.timestamp >= card.entryTimestamp! &&
      (card.exitTimestamp === undefined || quote.timestamp < card.exitTimestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
  let previousBid: number | undefined;

  for (const quote of sortedQuotes) {
    if (quote.bidPrice === previousBid) continue;
    previousBid = quote.bidPrice;
    const state = [...statusUpdates].reverse().find(({ update }) => update.timestamp <= quote.timestamp)?.update;
    const stage = state?.stage ?? "POSITION_OPEN";
    if (!["PARTIAL_ENTRY", "POSITION_OPEN", "EXIT_WORKING"].includes(stage)) continue;
    const remainingQuantity = state?.remainingQuantity ?? card.quantity;
    if (remainingQuantity <= 0) continue;
    const realizedPnl = state?.realizedPnl ?? 0;
    const unrealizedPnl = 100 * remainingQuantity * (quote.bidPrice - card.entryPrice);
    quoteUpdates.push({
      update: {
        timestamp: quote.timestamp,
        stage,
        status: state?.status ?? "OPEN",
        source: "PNL",
        remainingQuantity,
        realizedPnl,
        currentBid: quote.bidPrice,
        currentAsk: quote.askPrice,
        unrealizedPnl,
        totalPnl: realizedPnl + unrealizedPnl,
        ...copyManagementState(state ?? card),
      },
      index: quoteUpdates.length,
    });
  }

  const merged = [
    ...statusUpdates.map(({ update, index }) => ({ update, index, priority: 0 })),
    ...quoteUpdates.map(({ update, index }) => ({ update, index, priority: 1 })),
  ].sort((left, right) =>
    left.update.timestamp - right.update.timestamp ||
    left.priority - right.priority ||
    left.index - right.index);
  const updates: DashboardOrderDynamicsUpdate[] = [];
  let previousPnl: number | undefined;

  for (const item of merged) {
    const update = { ...item.update };
    const duplicate = updates.some((existing) =>
      existing.timestamp === update.timestamp && sameDynamics(existing, update));
    if (duplicate) continue;
    delete update.pnlChange;
    const pnl = update.totalPnl ?? update.unrealizedPnl;
    if (pnl !== undefined) {
      if (previousPnl !== undefined) update.pnlChange = pnl - previousPnl;
      previousPnl = pnl;
    }
    updates.push(update);
  }

  const mergedCard = { ...cloneCard(card), updates };
  return { ...mergedCard, ...classifyOrderCardEntryQuality(mergedCard) };
}

function sameDynamics(left: DashboardOrderDynamicsUpdate, right: DashboardOrderDynamicsUpdate): boolean {
  return left.stage === right.stage &&
    left.status === right.status &&
    left.remainingQuantity === right.remainingQuantity &&
    left.realizedPnl === right.realizedPnl &&
    left.currentBid === right.currentBid &&
    left.unrealizedPnl === right.unrealizedPnl &&
    left.totalPnl === right.totalPnl &&
    sameManagementState(left, right);
}

function cloneCard(card: DashboardOrderCard): DashboardOrderCard {
  return {
    ...card,
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

function copyManagementState(
  state: DashboardOrderManagement,
): DashboardOrderManagement {
  return {
    ...(state.lifecycle ? { lifecycle: state.lifecycle } : {}),
    ...(state.tradeState ? { tradeState: state.tradeState } : {}),
    ...(state.managementDecision
      ? { managementDecision: state.managementDecision }
      : {}),
    ...(state.managementReason ? { managementReason: state.managementReason } : {}),
    ...(state.exitTriggers ? { exitTriggers: [...state.exitTriggers] } : {}),
    ...(state.executablePnl !== undefined
      ? { executablePnl: state.executablePnl }
      : {}),
    ...(state.liquidationPrice !== undefined
      ? { liquidationPrice: state.liquidationPrice }
      : {}),
    ...(state.protectedFloorPnl !== undefined
      ? { protectedFloorPnl: state.protectedFloorPnl }
      : {}),
    ...(state.floorBufferDollars !== undefined
      ? { floorBufferDollars: state.floorBufferDollars }
      : {}),
    ...(state.highWaterPnl !== undefined ? { highWaterPnl: state.highWaterPnl } : {}),
    ...(state.lowWaterPnl !== undefined ? { lowWaterPnl: state.lowWaterPnl } : {}),
    ...(state.recoveryProbability !== undefined
      ? { recoveryProbability: state.recoveryProbability }
      : {}),
    ...(state.continuationLcbDollars !== undefined
      ? { continuationLcbDollars: state.continuationLcbDollars }
      : {}),
    ...(state.reversalCusum !== undefined ? { reversalCusum: state.reversalCusum } : {}),
    ...(state.zeroCrossings !== undefined ? { zeroCrossings: state.zeroCrossings } : {}),
    ...(state.pnlObservationCount !== undefined
      ? { pnlObservationCount: state.pnlObservationCount }
      : {}),
    ...(state.optionContinuation
      ? { optionContinuation: { ...state.optionContinuation } }
      : {}),
  };
}

function sameManagementState(
  left: DashboardOrderManagement,
  right: DashboardOrderManagement,
): boolean {
  return left.lifecycle === right.lifecycle &&
    left.tradeState === right.tradeState &&
    left.managementDecision === right.managementDecision &&
    left.managementReason === right.managementReason &&
    JSON.stringify(left.exitTriggers ?? []) === JSON.stringify(right.exitTriggers ?? []) &&
    left.executablePnl === right.executablePnl &&
    left.liquidationPrice === right.liquidationPrice &&
    left.protectedFloorPnl === right.protectedFloorPnl &&
    left.floorBufferDollars === right.floorBufferDollars &&
    left.highWaterPnl === right.highWaterPnl &&
    left.lowWaterPnl === right.lowWaterPnl &&
    left.recoveryProbability === right.recoveryProbability &&
    left.continuationLcbDollars === right.continuationLcbDollars &&
    left.reversalCusum === right.reversalCusum &&
    left.zeroCrossings === right.zeroCrossings &&
    left.pnlObservationCount === right.pnlObservationCount &&
    JSON.stringify(left.optionContinuation ?? {}) ===
      JSON.stringify(right.optionContinuation ?? {});
}

function formatSignedPnl(value: number): string {
  const rounded = Math.abs(value) < 0.005 ? 0 : value;
  return rounded < 0 ? `-$${Math.abs(rounded).toFixed(2)}` : `+$${rounded.toFixed(2)}`;
}
