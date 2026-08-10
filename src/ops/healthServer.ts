import { createServer, type Server } from "node:http";
import { tradingDashboardHtml, type TradingDashboardSnapshot } from "./tradingDashboard.js";
import type { CircuitState, OpraQuoteDiagnosis } from "../marketData/opraQuoteHealth.js";

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
  lastOptionQuoteProviderAgeMs?: number;
  optionQuotePrimed?: boolean;
  optionQuoteProviderLagged?: boolean;
  optionQuoteDiagnosis?: OpraQuoteDiagnosis;
  optionTransportAgeMs?: number;
  optionExactSymbolReceiveAgeMs?: number;
  optionObservedContracts?: number;
  optionActiveContracts?: number;
  optionFreshContracts?: number;
  optionDiagnosableContracts?: number;
  optionDelayedContracts?: number;
  optionDelayedContractFraction?: number;
  optionFreshContractFraction?: number;
  optionMedianArrivalLagMs?: number;
  optionMedianAbsoluteDeviationMs?: number;
  optionProviderAdvanceRatio?: number;
  optionProviderTimeVelocity?: number;
  optionQuoteFreshnessThresholdMs?: number;
  optionQuoteStalled?: boolean;
  optionQuoteStallThresholdMs?: number;
  optionSubscriptionsRequired?: boolean;
  optionRestFallbackEnabled?: boolean;
  optionRestFallbackInFlight?: boolean;
  optionRestFallbackRequests?: number;
  optionRestFallbackFreshQuotes?: number;
  optionRestRepeatedQuotes?: number;
  optionRestCircuitState?: CircuitState;
  optionRestCircuitFailures?: number;
  optionRestCircuitRetryAfterMs?: number;
  lastOptionRestFallbackAgeMs?: number;
  lastOptionRestQuoteProviderAgeMs?: number;
  lastOptionRestFallbackError?: string;
  completedBars?: number;
  restoredStockEvents?: number;
  restoredBars?: number;
  restorationRejectedEvents?: number;
  rejectedMarketEvents?: number;
  lastFeatureTimestamp?: number;
  reconnectAttempt?: number;
  lastStreamError?: string;
  stockWebsocketConnected?: boolean;
  optionWebsocketConnected?: boolean;
  marketDataIdle?: boolean;
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
  marketClockAvailable?: boolean;
  lastMarketClockError?: string;
  openOrderCount: number;
  positionsReconciled: boolean;
  recorderHealthy: boolean;
  killSwitch: boolean;
  strategyStateReady?: boolean;
  strategyStateStatus?: string;
  strategyStateMarketDate?: string;
  strategyOpeningRangeEnd?: string;
  restoredFeatureBars?: number;
  strategyRecoveryError?: string;
  underlyingStates?: Record<string, HealthState>;
}

export function combineHealthStates(states: Readonly<Record<string, HealthState>>): HealthState {
  const entries = Object.entries(states);
  if (entries.length === 0) {
    return {
      ready: false, brokerRequired: false, subscribedOptionContracts: 0,
      websocketConnected: false, brokerAvailable: false, marketClockState: "idle",
      openOrderCount: 0, positionsReconciled: true, recorderHealthy: true, killSwitch: false,
    };
  }
  const values = entries.map(([, state]) => state);
  const sum = (key: keyof HealthState): number => values.reduce((total, state) => {
    const value = state[key];
    return total + (typeof value === "number" ? value : 0);
  }, 0);
  const marketStates = new Set(values.map((state) => state.marketClockState));
  const maximum = (key: keyof HealthState): number | undefined => {
    const numbers = values.flatMap((state) => typeof state[key] === "number" ? [state[key] as number] : []);
    return numbers.length > 0 ? Math.max(...numbers) : undefined;
  };
  const minimum = (key: keyof HealthState): number | undefined => {
    const numbers = values.flatMap((state) => typeof state[key] === "number" ? [state[key] as number] : []);
    return numbers.length > 0 ? Math.min(...numbers) : undefined;
  };
  const lastOptionQuoteAgeMs = maximum("lastOptionQuoteAgeMs");
  const lastOptionQuoteProviderAgeMs = maximum("lastOptionQuoteProviderAgeMs");
  const lastOptionRestFallbackAgeMs = maximum("lastOptionRestFallbackAgeMs");
  const lastOptionRestQuoteProviderAgeMs = maximum("lastOptionRestQuoteProviderAgeMs");
  const optionQuoteFreshnessThresholdMs = minimum("optionQuoteFreshnessThresholdMs");
  const optionQuoteStallThresholdMs = minimum("optionQuoteStallThresholdMs");
  const diagnosisPriority: OpraQuoteDiagnosis[] = [
    "HEALTHY", "NO_DATA", "CONTRACT_IDLE", "OLD_EVENT_ARRIVED", "PROVIDER_DELAYED", "TRANSPORT_DISCONNECTED",
  ];
  const optionQuoteDiagnosis = values
    .flatMap((state) => state.optionQuoteDiagnosis ? [state.optionQuoteDiagnosis] : [])
    .sort((left, right) => diagnosisPriority.indexOf(right) - diagnosisPriority.indexOf(left))[0];
  const optionDiagnosableContracts = sum("optionDiagnosableContracts");
  const optionDelayedContracts = sum("optionDelayedContracts");
  const optionFreshContracts = sum("optionFreshContracts");
  const subscribedOptionContracts = sum("subscribedOptionContracts");
  const circuitPriority: CircuitState[] = ["CLOSED", "HALF_OPEN", "OPEN"];
  const optionRestCircuitState = values
    .flatMap((state) => state.optionRestCircuitState ? [state.optionRestCircuitState] : [])
    .sort((left, right) => circuitPriority.indexOf(right) - circuitPriority.indexOf(left))[0];
  const optionTransportAgeMs = maximum("optionTransportAgeMs");
  const optionExactSymbolReceiveAgeMs = maximum("optionExactSymbolReceiveAgeMs");
  const optionMedianArrivalLagMs = maximum("optionMedianArrivalLagMs");
  const optionMedianAbsoluteDeviationMs = maximum("optionMedianAbsoluteDeviationMs");
  const optionProviderAdvanceRatio = minimum("optionProviderAdvanceRatio");
  const optionProviderTimeVelocity = minimum("optionProviderTimeVelocity");
  const optionRestCircuitRetryAfterMs = maximum("optionRestCircuitRetryAfterMs");
  return {
    ready: values.every((state) => state.ready),
    brokerRequired: values.some((state) => state.brokerRequired !== false),
    marketDataFeed: "sip",
    ...(values.some((state) => state.optionDataFeed === "opra") ? { optionDataFeed: "opra" } : {}),
    receivedStockQuotes: sum("receivedStockQuotes"),
    receivedStockTrades: sum("receivedStockTrades"),
    receivedOptionQuotes: sum("receivedOptionQuotes"),
    ...(lastOptionQuoteAgeMs !== undefined ? { lastOptionQuoteAgeMs } : {}),
    ...(lastOptionQuoteProviderAgeMs !== undefined ? { lastOptionQuoteProviderAgeMs } : {}),
    optionQuotePrimed: values.every((state) => state.optionQuotePrimed !== false),
    optionQuoteProviderLagged: values.some((state) => state.optionQuoteProviderLagged === true),
    ...(optionQuoteDiagnosis ? { optionQuoteDiagnosis } : {}),
    ...(optionTransportAgeMs !== undefined ? { optionTransportAgeMs } : {}),
    ...(optionExactSymbolReceiveAgeMs !== undefined ? { optionExactSymbolReceiveAgeMs } : {}),
    optionObservedContracts: sum("optionObservedContracts"),
    optionActiveContracts: sum("optionActiveContracts"),
    optionFreshContracts,
    optionDiagnosableContracts,
    optionDelayedContracts,
    optionDelayedContractFraction: optionDiagnosableContracts === 0
      ? 0 : optionDelayedContracts / optionDiagnosableContracts,
    optionFreshContractFraction: subscribedOptionContracts === 0
      ? 0 : optionFreshContracts / subscribedOptionContracts,
    ...(optionMedianArrivalLagMs !== undefined ? { optionMedianArrivalLagMs } : {}),
    ...(optionMedianAbsoluteDeviationMs !== undefined ? { optionMedianAbsoluteDeviationMs } : {}),
    ...(optionProviderAdvanceRatio !== undefined ? { optionProviderAdvanceRatio } : {}),
    ...(optionProviderTimeVelocity !== undefined ? { optionProviderTimeVelocity } : {}),
    ...(optionQuoteFreshnessThresholdMs !== undefined ? { optionQuoteFreshnessThresholdMs } : {}),
    optionQuoteStalled: values.some((state) => state.optionQuoteStalled === true),
    ...(optionQuoteStallThresholdMs !== undefined ? { optionQuoteStallThresholdMs } : {}),
    optionSubscriptionsRequired: values.some((state) => state.optionSubscriptionsRequired === true),
    optionRestFallbackEnabled: values.some((state) => state.optionRestFallbackEnabled === true),
    optionRestFallbackInFlight: values.some((state) => state.optionRestFallbackInFlight === true),
    optionRestFallbackRequests: sum("optionRestFallbackRequests"),
    optionRestFallbackFreshQuotes: sum("optionRestFallbackFreshQuotes"),
    optionRestRepeatedQuotes: sum("optionRestRepeatedQuotes"),
    ...(optionRestCircuitState ? { optionRestCircuitState } : {}),
    optionRestCircuitFailures: sum("optionRestCircuitFailures"),
    ...(optionRestCircuitRetryAfterMs !== undefined ? { optionRestCircuitRetryAfterMs } : {}),
    ...(lastOptionRestFallbackAgeMs !== undefined ? { lastOptionRestFallbackAgeMs } : {}),
    ...(lastOptionRestQuoteProviderAgeMs !== undefined ? { lastOptionRestQuoteProviderAgeMs } : {}),
    ...(values.find((state) => state.lastOptionRestFallbackError)?.lastOptionRestFallbackError
      ? { lastOptionRestFallbackError: values.find((state) => state.lastOptionRestFallbackError)!.lastOptionRestFallbackError }
      : {}),
    completedBars: sum("completedBars"),
    rejectedMarketEvents: sum("rejectedMarketEvents"),
    restoredStockEvents: sum("restoredStockEvents"),
    restoredFeatureBars: sum("restoredFeatureBars"),
    reconnectAttempt: Math.max(...values.map((state) => state.reconnectAttempt ?? 0)),
    stockWebsocketConnected: values.every((state) => state.stockWebsocketConnected !== false),
    optionWebsocketConnected: values
      .filter((state) => state.optionDataFeed === "opra")
      .every((state) => state.optionWebsocketConnected === true),
    websocketConnected: values.every((state) => state.websocketConnected),
    marketDataIdle: values.every((state) => state.marketDataIdle === true),
    executionEnabled: values.some((state) => state.executionEnabled === true),
    ...(values.find((state) => state.executionMode)?.executionMode
      ? { executionMode: values.find((state) => state.executionMode)!.executionMode }
      : {}),
    accountOptionsApproved: values.every((state) => state.accountOptionsApproved !== false),
    positionOpen: values.some((state) => state.positionOpen === true),
    pendingOrder: values.some((state) => state.pendingOrder === true),
    subscribedOptionContracts,
    brokerAvailable: values.filter((state) => state.brokerRequired !== false).every((state) => state.brokerAvailable),
    marketClockState: marketStates.size === 1 ? values[0]!.marketClockState : "mixed",
    marketClockAvailable: values.every((state) => state.marketClockAvailable !== false),
    ...(values.find((state) => state.lastMarketClockError)?.lastMarketClockError
      ? { lastMarketClockError: values.find((state) => state.lastMarketClockError)!.lastMarketClockError }
      : {}),
    openOrderCount: sum("openOrderCount"),
    positionsReconciled: values.every((state) => state.positionsReconciled),
    recorderHealthy: values.every((state) => state.recorderHealthy),
    killSwitch: values.some((state) => state.killSwitch),
    strategyStateReady: values.every((state) => state.strategyStateReady !== false),
    ...(values.every((state) => state.strategyStateStatus === values[0]!.strategyStateStatus) &&
        values[0]!.strategyStateStatus !== undefined
      ? { strategyStateStatus: values[0]!.strategyStateStatus }
      : { strategyStateStatus: "MIXED" }),
    underlyingStates: Object.fromEntries(entries),
  };
}

export function healthReadiness(state: HealthState): { status: "ok" | "degraded" | "halted"; checks: HealthState } {
  if (state.killSwitch || !state.positionsReconciled || !state.recorderHealthy) return { status: "halted", checks: state };
  if (!state.ready || (!state.websocketConnected && !state.marketDataIdle) ||
      (state.brokerRequired !== false && !state.brokerAvailable)) {
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
