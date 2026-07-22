import { createServer, type Server } from "node:http";

export interface HealthState {
  ready: boolean;
  lastStockQuoteAgeMs?: number;
  lastStockTradeAgeMs?: number;
  subscribedOptionContracts: number;
  openPositionOptionQuoteAgeMs?: number;
  websocketConnected: boolean;
  brokerAvailable: boolean;
  marketClockState: string;
  openOrderCount: number;
  positionsReconciled: boolean;
  recorderHealthy: boolean;
  killSwitch: boolean;
}

export function healthReadiness(state: HealthState): { status: "ok" | "degraded" | "halted"; checks: HealthState } {
  if (state.killSwitch || !state.positionsReconciled || !state.recorderHealthy) return { status: "halted", checks: state };
  if (!state.ready || !state.websocketConnected || !state.brokerAvailable) return { status: "degraded", checks: state };
  return { status: "ok", checks: state };
}

export function clockDriftMs(providerTimestamp: number, localTimestamp = Date.now()): number {
  return Math.abs(localTimestamp - providerTimestamp);
}

export function startHealthServer(getState: () => HealthState, port = 8080, host = "127.0.0.1"): Server {
  const server = createServer((request, response) => {
    const health = healthReadiness(getState());
    if (request.url === "/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "alive" }));
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
