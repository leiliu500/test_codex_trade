import type { MultiUnderlyingTradingRestClient } from "../alpaca/restClient.js";
import type { AuditEvent } from "../ops/recorder.js";
import type { DashboardOrderCard } from "../ops/orderCards.js";
import { parseOccSymbol } from "../options/occSymbol.js";
import { isUnderlyingSymbol, type UnderlyingSymbol } from "../types.js";
import { marketDate } from "../utils/time.js";

const TERMINAL_ORDER_STATUSES = new Set([
  "filled", "rejected", "canceled", "expired", "done_for_day", "replaced", "calculated",
]);

export interface BrokerHistoryRecoveryResult {
  checkedOrders: number;
  events: AuditEvent[];
  errors: string[];
}

/** Repairs durable dashboard history when Alpaca completed an order after the last local audit. */
export async function recoverTerminalDashboardOrders(
  client: MultiUnderlyingTradingRestClient,
  cards: readonly DashboardOrderCard[],
  configVersions: Readonly<Record<UnderlyingSymbol, string>>,
  timeZone: string,
): Promise<BrokerHistoryRecoveryResult> {
  const events: AuditEvent[] = [];
  const errors: string[] = [];
  let checkedOrders = 0;
  for (const card of cards) {
    const working = card.active ? card.workingOrder : undefined;
    if (!working?.brokerOrderId) continue;
    checkedOrders += 1;
    try {
      const broker = await client.getOrder(working.brokerOrderId);
      if (broker.symbol !== card.symbol) {
        errors.push(`Broker order ${broker.id} returned ${broker.symbol}, expected ${card.symbol}`);
        continue;
      }
      const status = broker.status.toLowerCase();
      if (!TERMINAL_ORDER_STATUSES.has(status)) continue;
      const underlying = parseOccSymbol(card.symbol)?.underlying;
      if (!isUnderlyingSymbol(underlying)) {
        errors.push(`Cannot recover non-OCC dashboard order ${card.symbol}`);
        continue;
      }
      const timestamp = broker.filledAt ?? broker.canceledAt ?? broker.updatedAt ?? Date.now();
      const base = {
        timestamp,
        marketDate: marketDate(timestamp, timeZone),
        configVersion: configVersions[underlying],
      };
      events.push({
        ...base,
        type: "broker_order_state",
        data: {
          underlying,
          purpose: working.purpose,
          broker,
          localOrder: {
            clientOrderId: working.clientOrderId,
            symbol: card.symbol,
            side: working.side,
            status: status === "filled" ? "FILLED" : status.toUpperCase(),
            requestedQuantity: working.requestedQuantity,
            filledQuantity: broker.filledQuantity,
            averageFillPrice: broker.averageFillPrice ?? 0,
            limitPrice: working.limitPrice,
            replacements: working.replacements,
            events: [],
          },
          recoveredFromBroker: true,
        },
      });

      const incrementalQuantity = Math.max(0, broker.filledQuantity - working.filledQuantity);
      if (working.purpose !== "EXIT" || incrementalQuantity === 0 ||
          !(broker.averageFillPrice !== undefined && broker.averageFillPrice > 0) ||
          !(card.entryPrice !== undefined && card.entryPrice > 0)) continue;
      const realizedPnl = 100 * incrementalQuantity * (broker.averageFillPrice - card.entryPrice);
      events.push({
        ...base,
        type: "exit_fill",
        data: {
          underlying,
          reason: card.exitReason ?? card.managementReason ?? "BROKER_OR_POSITION_RISK",
          incrementalQuantity,
          incrementalPrice: broker.averageFillPrice,
          realizedPnl,
          remainingQuantity: Math.max(0, card.remainingQuantity - incrementalQuantity),
          symbol: card.symbol,
          direction: card.direction ?? "UNKNOWN",
          entryTimestamp: card.entryTimestamp ?? timestamp,
          averageEntryPrice: card.entryPrice,
          highWaterPnl: card.highWaterPnl ?? 0,
          lowWaterPnl: card.lowWaterPnl ?? 0,
          executablePnl: realizedPnl,
          protectedFloorPnl: card.protectedFloorPnl ?? null,
          tradeState: card.tradeState ?? "OPEN_UNPROTECTED",
          exitIntentId: working.exitIntentId ?? null,
          exitTriggers: working.triggers ?? card.exitTriggers ?? [],
          recoveredFromBroker: true,
        },
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { checkedOrders, events, errors };
}
