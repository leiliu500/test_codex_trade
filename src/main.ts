import { loadDotEnv } from "./utils/loadDotEnv.js";
import { readEnvironment } from "./utils/env.js";
import { defaultConfig, qqqConfig, validateConfig, type EngineConfig } from "./config.js";
import { combineHealthStates, startHealthServer, type HealthState } from "./ops/healthServer.js";
import { AlpacaStockWebSocket } from "./alpaca/stockStream.js";
import { AlpacaOptionWebSocket } from "./alpaca/optionStream.js";
import { AlpacaTradingRestClient, UnderlyingTradingRestClient } from "./alpaca/restClient.js";
import { SpySipReceiver } from "./runtime/spySipReceiver.js";
import { SpyOptionsTradingRuntime } from "./runtime/spyOptionsTradingRuntime.js";
import { SharedOptionStreamHub, SharedStockStreamHub } from "./runtime/sharedStreams.js";
import { PortfolioRiskCoordinator } from "./risk/portfolioRiskCoordinator.js";
import { CompositeRecorder, JsonLineRecorder, type AuditEvent } from "./ops/recorder.js";
import { TradingDashboardStore } from "./ops/tradingDashboard.js";
import { PostgresHistoryStore } from "./history/postgresHistory.js";
import { CompositeMarketHistorySink, SharedPriorityMarketHistoryHub } from "./history/types.js";
import { JsonLogger } from "./utils/logger.js";
import { marketDate } from "./utils/time.js";
import type { FeatureSnapshot, UnderlyingSymbol } from "./types.js";
import {
  mergeOrderCardQuoteDynamics,
  type DashboardOrderCard,
} from "./ops/orderCards.js";

loadDotEnv();
const environment = readEnvironment();
const configCatalog: Readonly<Record<UnderlyingSymbol, EngineConfig>> = {
  SPY: defaultConfig,
  QQQ: qqqConfig,
};
const configs = environment.tradingSymbols.map((symbol) => configCatalog[symbol]);
for (const config of configs) validateConfig(config);

if (environment.tradingMode === "live") {
  throw new Error("Live mode needs explicitly promoted multi-underlying adapters; refusing implicit live startup");
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
const restoredFeatureCheckpoints = new Map<UnderlyingSymbol, FeatureSnapshot>();
if (history) {
  await history.initialize();
  [restoredEvents, restoredOrderCards] = await Promise.all([
    history.loadAuditEvents(),
    history.loadOrderCards(),
  ]);
  const checkpoints = await Promise.all(configs.map((config) =>
    history.loadLatestRecoveredFeature(marketDate(Date.now(), config.timeZone), config.symbol)));
  for (let index = 0; index < configs.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint) restoredFeatureCheckpoints.set(configs[index]!.symbol, checkpoint);
  }
  dashboard.restoreOrderCards(restoredOrderCards);
  for (const event of restoredEvents) dashboard.record(event);
  const restoredCardIds = new Set(restoredOrderCards.map((card) => card.id));
  const completedOrderCards = dashboard.snapshot().orderCards.filter((card) => !card.active);
  const backfilledOrderCards = completedOrderCards.filter((card) => !restoredCardIds.has(card.id));
  const quotesByCard = await history.loadOrderCardQuotes(completedOrderCards);
  let backfilledPnlUpdates = 0;
  for (const card of completedOrderCards) {
    const quotes = quotesByCard.get(card.id) ?? [];
    const enriched = mergeOrderCardQuoteDynamics(card, quotes);
    backfilledPnlUpdates += Math.max(0, enriched.updates.length - card.updates.length);
    dashboard.restoreOrderCards([enriched]);
    if (quotes.length > 0 || !restoredCardIds.has(card.id)) await history.saveOrderCard(enriched);
  }
  dashboard.setOrderCardPersistence(history);
  logger.log("info", "postgres_history_ready", {
    restoredAuditEvents: restoredEvents.length,
    restoredOrderCards: restoredOrderCards.length,
    backfilledOrderCards: backfilledOrderCards.length,
    backfilledPnlUpdates,
    recoveredFeatureCheckpoints: [...restoredFeatureCheckpoints.keys()],
  });
}
const auditRecorder = new CompositeRecorder([
  new JsonLineRecorder((line) => process.stdout.write(line)),
  dashboard,
  ...(history ? [history] : []),
]);
const baseMarketHistory = new CompositeMarketHistorySink([
  dashboard,
  ...(history ? [history] : []),
]);
const priorityHistory = new SharedPriorityMarketHistoryHub(baseMarketHistory, environment.tradingSymbols);
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

const physicalStockStream = environment.marketDataEnabled ? new AlpacaStockWebSocket({
  apiKey: environment.alpacaApiKey!,
  apiSecret: environment.alpacaApiSecret!,
  feed: environment.stockDataFeed,
  symbols: environment.tradingSymbols,
}) : undefined;
const stockHub = physicalStockStream
  ? new SharedStockStreamHub(physicalStockStream, environment.tradingSymbols)
  : undefined;
const physicalOptionStream = environment.liveOrdersEnabled ? new AlpacaOptionWebSocket({
  apiKey: environment.alpacaApiKey!,
  apiSecret: environment.alpacaApiSecret!,
  feed: environment.optionDataFeed,
}) : undefined;
const optionHub = physicalOptionStream
  ? new SharedOptionStreamHub(physicalOptionStream, environment.tradingSymbols)
  : undefined;
const broker = environment.liveOrdersEnabled ? new AlpacaTradingRestClient({
  apiKey: environment.alpacaApiKey!,
  apiSecret: environment.alpacaApiSecret!,
  paper: true,
  optionFeed: environment.optionDataFeed,
  underlyings: environment.tradingSymbols,
}) : undefined;
const portfolioRisk = broker ? new PortfolioRiskCoordinator({
  timeZone: defaultConfig.timeZone,
  maxConcurrentUnderlyings: configs.length,
  maxAggregateRiskDollars: configs.reduce((total, config) => total + config.risk.maxRiskDollarsPerTrade, 0),
  maxAggregatePremiumDollars: configs.reduce((total, config) => total + config.risk.maxPremiumDollarsPerTrade, 0),
  maxDailyLossDollars: Math.min(...configs.map((config) => config.risk.maxDailyLossDollars)),
}, Date.now(), restoredPortfolioPnl(restoredEvents, Date.now(), defaultConfig.timeZone)) : undefined;

const tradingRuntimes = broker && stockHub && optionHub ? configs.map((config) => {
  const symbol = config.symbol;
  return new SpyOptionsTradingRuntime({
    config,
    client: new UnderlyingTradingRestClient(broker, symbol),
    stockStream: stockHub.channel(symbol),
    optionStream: optionHub.channel(symbol),
    executionEnabled: true,
    executionMode: "paper",
    killSwitch: environment.killSwitch,
    recorder: auditRecorder,
    history: priorityHistory.channel(symbol),
    requireStrategyRecovery: true,
    restoredAuditEvents: restoredEvents,
    portfolioRisk: portfolioRisk!,
    ...(restoredFeatureCheckpoints.has(symbol)
      ? { restoredFeatureCheckpoint: restoredFeatureCheckpoints.get(symbol)! }
      : {}),
    ...(history ? {
      loadStockHistory: (date: string, start: number, end: number, quoteStart?: number) =>
        history.streamStockEvents(date, start, end, quoteStart),
    } : {}),
    onEvent: (type, data) => logger.log("info", type, { underlying: symbol, ...data }),
    onError: (error) => logger.log("error", "options_runtime_error", {
      underlying: symbol,
      error: error instanceof Error ? error.message : String(error),
    }),
  });
}) : [];

const sipReceivers = environment.marketDataEnabled && stockHub && tradingRuntimes.length === 0
  ? configs.map((config) => new SpySipReceiver({
      config,
      stream: stockHub.channel(config.symbol),
      onError: (error) => logger.log("warn", "sip_stream_error", {
        underlying: config.symbol,
        error: error instanceof Error ? error.message : String(error),
      }),
    }))
  : [];

const getHealth = (): HealthState => {
  if (tradingRuntimes.length > 0) {
    return combineHealthStates(Object.fromEntries(configs.map((config, index) => [
      config.symbol, tradingRuntimes[index]!.healthState(),
    ])));
  }
  if (sipReceivers.length > 0) {
    return combineHealthStates(Object.fromEntries(configs.map((config, index) => [
      config.symbol, sipReceivers[index]!.healthState(environment.killSwitch),
    ])));
  }
  return idleHealthState;
};

const server = startHealthServer(
  getHealth,
  environment.healthPort,
  environment.healthHost,
  () => dashboard.snapshot(),
);

server.on("listening", () => {
  process.stdout.write(`${JSON.stringify({
    status: "running",
    mode: "paper",
    symbols: environment.tradingSymbols,
    marketData: tradingRuntimes.length > 0 ? "sip-and-opra-connecting"
      : environment.marketDataEnabled ? "sip-connecting" : "disabled",
    orderSubmission: tradingRuntimes.length > 0 ? "alpaca-paper-enabled" : "disabled",
    configVersions: Object.fromEntries(configs.map((config) => [config.symbol, config.version])),
    health: `http://${environment.healthHost}:${environment.healthPort}`,
    dashboard: `http://${environment.healthHost}:${environment.healthPort}/dashboard`,
    historyDatabase: history ? "postgres-ready" : "disabled",
    message: tradingRuntimes.length > 0
      ? "Paper runtimes are connecting isolated SIP signals and option state through shared market-data and broker boundaries."
      : environment.marketDataEnabled
      ? "Paper-safe SIP receivers are connecting."
      : "Paper-safe runtime is alive with market data disabled.",
  })}\n`);
});

server.on("error", (error) => {
  process.stderr.write(`${JSON.stringify({ status: "startup_failed", error: error.message })}\n`);
  process.exitCode = 1;
});

if (tradingRuntimes.length > 0) {
  void Promise.all(tradingRuntimes.map((runtime) => runtime.start())).then(() => {
    logger.log("info", "multi_underlying_paper_runtime_started", {
      underlyings: environment.tradingSymbols,
      underlyingOrdersAllowed: false,
      expiration: "current-market-day-only",
      stockFeed: "sip",
      optionFeed: "opra",
    });
  }).catch((error: unknown) => {
    logger.log("error", "multi_underlying_runtime_startup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
} else if (sipReceivers.length > 0) {
  void Promise.all(sipReceivers.map((receiver) => receiver.start())).then(() => {
    logger.log("info", "sip_subscriptions_ready", {
      symbols: environment.tradingSymbols, feed: "sip", orderSubmission: "disabled",
    });
  }).catch((error: unknown) => {
    logger.log("error", "sip_initial_connection_failed_retrying", {
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
    await Promise.allSettled([
      ...tradingRuntimes.map((runtime) => runtime.close()),
      ...sipReceivers.map((receiver) => receiver.close()),
    ]);
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

function restoredPortfolioPnl(events: readonly AuditEvent[], timestamp: number, timeZone: string): number {
  const date = marketDate(timestamp, timeZone);
  return events.reduce((total, event) => {
    const eventDate = event.marketDate ?? marketDate(event.timestamp, timeZone);
    const pnl = event.type === "exit_fill" && eventDate === date ? event.data.realizedPnl : undefined;
    return total + (typeof pnl === "number" && Number.isFinite(pnl) ? pnl : 0);
  }, 0);
}
