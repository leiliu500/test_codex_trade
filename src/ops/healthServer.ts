import { createServer, type Server } from "node:http";
import { tradingDashboardHtml, type TradingDashboardSnapshot } from "./tradingDashboard.js";

export interface HealthState {
  ready: boolean;
  brokerRequired?: boolean;
  marketDataFeed?: string;
  optionDataFeed?: string;
  lastStockQuoteAgeMs?: number;
  lastStockTradeAgeMs?: number;
  receivedStockQuotes?: number;
  receivedStockTrades?: number;
  receivedOptionQuotes?: number;
  lastOptionQuoteAgeMs?: number;
  completedBars?: number;
  restoredStockEvents?: number;
  restoredBars?: number;
  restorationRejectedEvents?: number;
  rejectedMarketEvents?: number;
  lastFeatureTimestamp?: number;
  reconnectAttempt?: number;
  lastStreamError?: string;
  optionWebsocketConnected?: boolean;
  executionEnabled?: boolean;
  executionMode?: "paper" | "live";
  accountOptionsApproved?: boolean;
  positionOpen?: boolean;
  pendingOrder?: boolean;
  subscribedOptionContracts: number;
  openPositionOptionQuoteAgeMs?: number;
  websocketConnected: boolean;
  brokerAvailable: boolean;
  marketClockState: string;
  openOrderCount: number;
  positionsReconciled: boolean;
  recorderHealthy: boolean;
  killSwitch: boolean;
  strategyStateReady?: boolean;
  strategyStateStatus?: string;
  strategyStateMarketDate?: string;
  restoredFeatureBars?: number;
  strategyRecoveryError?: string;
}

export function healthReadiness(state: HealthState): { status: "ok" | "degraded" | "halted"; checks: HealthState } {
  if (state.killSwitch || !state.positionsReconciled || !state.recorderHealthy) return { status: "halted", checks: state };
  if (!state.ready || !state.websocketConnected || (state.brokerRequired !== false && !state.brokerAvailable)) {
    return { status: "degraded", checks: state };
  }
  return { status: "ok", checks: state };
}

export function clockDriftMs(providerTimestamp: number, localTimestamp = Date.now()): number {
  return Math.abs(localTimestamp - providerTimestamp);
}

export function startHealthServer(
  getState: () => HealthState,
  port = 3001,
  host = "127.0.0.1",
  getDashboard?: () => TradingDashboardSnapshot,
): Server {
  const server = createServer((request, response) => {
    const health = healthReadiness(getState());
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", "no-store");
    if (request.url === "/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "alive" }));
      return;
    }
    if (request.url === "/api/dashboard" && getDashboard) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...getDashboard(), readiness: health.status, health: health.checks }));
      return;
    }
    if (request.url === "/dashboard" && getDashboard) {
      response.setHeader("content-security-policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(tradingDashboardHtml());
      return;
    }
    if (request.url === "/" && getDashboard) {
      response.writeHead(302, { location: "/dashboard" });
      response.end();
      return;
    }
    if (request.url === "/ready") {
      response.writeHead(health.status === "ok" ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify(health));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  return server.listen(port, host);
}
