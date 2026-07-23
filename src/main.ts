import { loadDotEnv } from "./utils/loadDotEnv.js";
import { readEnvironment } from "./utils/env.js";
import { defaultConfig, validateConfig } from "./config.js";
import { startHealthServer, type HealthState } from "./ops/healthServer.js";
import { AlpacaStockWebSocket } from "./alpaca/stockStream.js";
import { AlpacaOptionWebSocket } from "./alpaca/optionStream.js";
import { AlpacaTradingRestClient } from "./alpaca/restClient.js";
import { SpySipReceiver } from "./runtime/spySipReceiver.js";
import { SpyOptionsTradingRuntime } from "./runtime/spyOptionsTradingRuntime.js";
import { CompositeRecorder, JsonLineRecorder, type AuditEvent } from "./ops/recorder.js";
import { TradingDashboardStore } from "./ops/tradingDashboard.js";
import { PostgresHistoryStore } from "./history/postgresHistory.js";
import { CompositeMarketHistorySink } from "./history/types.js";
import { JsonLogger } from "./utils/logger.js";
import { marketDate } from "./utils/time.js";
import type { FeatureSnapshot } from "./types.js";
import type { DashboardOrderCard } from "./ops/orderCards.js";

loadDotEnv();
validateConfig(defaultConfig);
const environment = readEnvironment();

if (environment.tradingMode === "live") {
  throw new Error("Live mode needs an explicitly supplied TradingRestClient and stream adapters; refusing implicit live startup");
}

const logger = new JsonLogger([
  environment.alpacaApiKey ?? "", environment.alpacaApiSecret ?? "", environment.databaseUrl ?? "",
]);
const dashboard = new TradingDashboardStore(
  Date.now(),
  environment.historyDatabaseEnabled,
  environment.historyQuoteSampleMs,
  environment.historyRetentionDays,
);
const history = environment.historyDatabaseEnabled ? new PostgresHistoryStore({
  connectionString: environment.databaseUrl!,
  quoteSampleIntervalMs: environment.historyQuoteSampleMs,
  retentionDays: environment.historyRetentionDays,
  onError: (error) => logger.log("error", "postgres_history_error", {
    error: error instanceof Error ? error.message : String(error),
  }),
}) : undefined;
let restoredEvents: AuditEvent[] = [];
let restoredOrderCards: DashboardOrderCard[] = [];
let restoredFeatureCheckpoint: FeatureSnapshot | undefined;
if (history) {
  await history.initialize();
  [restoredEvents, restoredOrderCards] = await Promise.all([
    history.loadAuditEvents(),
    history.loadOrderCards(),
  ]);
  dashboard.restoreOrderCards(restoredOrderCards);
  restoredFeatureCheckpoint = await history.loadLatestRecoveredFeature(marketDate(Date.now(), defaultConfig.timeZone));
  for (const event of restoredEvents) dashboard.record(event);
  const restoredCardIds = new Set(restoredOrderCards.map((card) => card.id));
  const backfilledOrderCards = dashboard.snapshot().orderCards.filter((card) =>
    !card.active && !restoredCardIds.has(card.id));
  for (const card of backfilledOrderCards) await history.saveOrderCard(card);
  dashboard.setOrderCardPersistence(history);
  logger.log("info", "postgres_history_ready", {
    restoredAuditEvents: restoredEvents.length,
    restoredOrderCards: restoredOrderCards.length,
    backfilledOrderCards: backfilledOrderCards.length,
    recoveredFeatureCheckpoint: restoredFeatureCheckpoint !== undefined,
  });
}
const auditRecorder = new CompositeRecorder([
  new JsonLineRecorder((line) => process.stdout.write(line)),
  dashboard,
  ...(history ? [history] : []),
]);
const marketHistory = new CompositeMarketHistorySink([
  dashboard,
  ...(history ? [history] : []),
]);
const idleHealthState: HealthState = {
  ready: false,
  brokerRequired: false,
  subscribedOptionContracts: 0,
  websocketConnected: false,
  brokerAvailable: false,
  marketClockState: "paper-idle",
  openOrderCount: 0,
  positionsReconciled: true,
  recorderHealthy: history?.healthy() ?? true,
  killSwitch: environment.killSwitch,
};
const stockStream = environment.marketDataEnabled ? new AlpacaStockWebSocket({
  apiKey: environment.alpacaApiKey!,
  apiSecret: environment.alpacaApiSecret!,
  feed: environment.stockDataFeed,
  symbol: "SPY",
}) : undefined;
const tradingRuntime = environment.liveOrdersEnabled && stockStream ? new SpyOptionsTradingRuntime({
  config: defaultConfig,
  client: new AlpacaTradingRestClient({
    apiKey: environment.alpacaApiKey!,
    apiSecret: environment.alpacaApiSecret!,
    paper: true,
    optionFeed: environment.optionDataFeed,
  }),
  stockStream,
  optionStream: new AlpacaOptionWebSocket({
    apiKey: environment.alpacaApiKey!,
    apiSecret: environment.alpacaApiSecret!,
    feed: environment.optionDataFeed,
  }),
  executionEnabled: true,
  executionMode: "paper",
  killSwitch: environment.killSwitch,
  recorder: auditRecorder,
  history: marketHistory,
  requireStrategyRecovery: true,
  restoredAuditEvents: restoredEvents,
  ...(restoredFeatureCheckpoint ? { restoredFeatureCheckpoint } : {}),
  ...(history ? {
    loadStockHistory: (date: string, start: number, end: number, quoteStart?: number) =>
      history.streamStockEvents(date, start, end, quoteStart),
  } : {}),
  onEvent: (type, data) => logger.log("info", type, data),
  onError: (error) => logger.log("error", "spy_options_runtime_error", {
    error: error instanceof Error ? error.message : String(error),
  }),
}) : undefined;
const sipReceiver = environment.marketDataEnabled && stockStream && !tradingRuntime ? new SpySipReceiver({
  config: defaultConfig,
  stream: stockStream,
  onError: (error) => logger.log("warn", "spy_sip_stream_error", {
    error: error instanceof Error ? error.message : String(error),
  }),
}) : undefined;

const server = startHealthServer(
  () => tradingRuntime?.healthState() ?? sipReceiver?.healthState(environment.killSwitch) ?? idleHealthState,
  environment.healthPort,
  environment.healthHost,
  () => dashboard.snapshot(),
);

server.on("listening", () => {
  process.stdout.write(`${JSON.stringify({
    status: "running",
    mode: "paper",
    symbol: defaultConfig.symbol,
    marketData: tradingRuntime ? "spy-sip-and-opra-connecting"
      : environment.marketDataEnabled ? "spy-sip-connecting" : "disabled",
    orderSubmission: tradingRuntime ? "alpaca-paper-enabled" : "disabled",
    configVersion: defaultConfig.version,
    health: `http://${environment.healthHost}:${environment.healthPort}`,
    dashboard: `http://${environment.healthHost}:${environment.healthPort}/dashboard`,
    historyDatabase: history ? "postgres-ready" : "disabled",
    message: tradingRuntime
      ? "Paper execution runtime is connecting SPY SIP signals, OPRA option quotes, and the Alpaca paper broker."
      : environment.marketDataEnabled
      ? "Paper-safe runtime is connecting to SPY SIP quotes and trades."
      : "Paper-safe runtime is alive with market data disabled.",
  })}\n`);
});

server.on("error", (error) => {
  process.stderr.write(`${JSON.stringify({ status: "startup_failed", error: error.message })}\n`);
  process.exitCode = 1;
});

if (tradingRuntime) {
  void tradingRuntime.start().then(() => {
    logger.log("info", "spy_options_paper_runtime_started", {
      underlying: "SPY",
      underlyingOrdersAllowed: false,
      expiration: "current-market-day-only",
      stockFeed: "sip",
      optionFeed: "opra",
    });
  }).catch((error: unknown) => {
    logger.log("error", "spy_options_runtime_startup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
} else if (sipReceiver) {
  void sipReceiver.start().then(() => {
    logger.log("info", "spy_sip_subscription_ready", { symbol: "SPY", feed: "sip", orderSubmission: "disabled" });
  }).catch((error: unknown) => {
    logger.log("error", "spy_sip_initial_connection_failed_retrying", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`${JSON.stringify({ status: "stopping", signal })}\n`);
  const forcedExit = setTimeout(() => process.exit(1), 9_000);
  forcedExit.unref();
  try {
    await tradingRuntime?.close();
    await sipReceiver?.close();
    await history?.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  } catch (error) {
    logger.log("error", "shutdown_failed", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    clearTimeout(forcedExit);
  }
}

process.once("SIGINT", (signal) => void shutdown(signal));
process.once("SIGTERM", (signal) => void shutdown(signal));
