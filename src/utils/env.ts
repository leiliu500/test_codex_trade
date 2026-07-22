export interface RuntimeEnvironment {
  tradingMode: "paper" | "live";
  liveOrdersEnabled: boolean;
  marketDataEnabled: boolean;
  stockDataFeed: "sip";
  optionDataFeed: "opra";
  historyDatabaseEnabled: boolean;
  historyQuoteSampleMs: number;
  historyRetentionDays: number;
  databaseUrl?: string;
  killSwitch: boolean;
  healthHost: string;
  healthPort: number;
  alpacaApiKey?: string;
  alpacaApiSecret?: string;
}

export function readEnvironment(env: NodeJS.ProcessEnv = process.env): RuntimeEnvironment {
  const tradingMode = env.TRADING_MODE === "live" ? "live" : "paper";
  const liveOrdersEnabled = env.ENABLE_LIVE_ORDERS === "true";
  const marketDataEnabled = env.MARKET_DATA_ENABLED === "true";
  const stockDataFeed = env.STOCK_DATA_FEED ?? "sip";
  const optionDataFeed = env.OPTION_DATA_FEED ?? "opra";
  const historyDatabaseEnabled = env.HISTORY_DATABASE_ENABLED === "true";
  const historyQuoteSampleMs = Number(env.MARKET_HISTORY_QUOTE_SAMPLE_MS ?? "250");
  const historyRetentionDays = Number(env.MARKET_HISTORY_RETENTION_DAYS ?? "7");
  const healthPort = Number(env.HEALTH_PORT ?? "3001");
  const healthHost = env.HEALTH_HOST?.trim() || "127.0.0.1";
  if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65_535) {
    throw new Error("HEALTH_PORT must be an integer between 1 and 65535");
  }
  if (!Number.isInteger(historyQuoteSampleMs) || historyQuoteSampleMs < 0 || historyQuoteSampleMs > 60_000) {
    throw new Error("MARKET_HISTORY_QUOTE_SAMPLE_MS must be an integer between 0 and 60000");
  }
  if (!Number.isInteger(historyRetentionDays) || historyRetentionDays < 0 || historyRetentionDays > 3_650) {
    throw new Error("MARKET_HISTORY_RETENTION_DAYS must be an integer between 0 and 3650");
  }
  if (stockDataFeed !== "sip") throw new Error("This runtime is hard-limited to the SPY SIP stock-data feed");
  if (optionDataFeed !== "opra") throw new Error("Executable option trading requires the real-time OPRA option-data feed");
  if (liveOrdersEnabled && !marketDataEnabled) {
    throw new Error("Broker order execution requires MARKET_DATA_ENABLED=true");
  }
  if (historyDatabaseEnabled && !env.DATABASE_URL) {
    throw new Error("HISTORY_DATABASE_ENABLED=true requires DATABASE_URL");
  }
  if (tradingMode === "live" && !liveOrdersEnabled) {
    throw new Error("Live mode requires ENABLE_LIVE_ORDERS=true; paper mode is the safe default");
  }
  if (tradingMode === "live" && (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET)) {
    throw new Error("Live mode requires broker credentials");
  }
  if (marketDataEnabled && (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET)) {
    throw new Error("SPY SIP market data requires ALPACA_API_KEY and ALPACA_API_SECRET");
  }
  return {
    tradingMode,
    liveOrdersEnabled,
    marketDataEnabled,
    stockDataFeed,
    optionDataFeed,
    historyDatabaseEnabled,
    historyQuoteSampleMs,
    historyRetentionDays,
    killSwitch: env.KILL_SWITCH === "true",
    healthHost,
    healthPort,
    ...(env.ALPACA_API_KEY ? { alpacaApiKey: env.ALPACA_API_KEY } : {}),
    ...(env.ALPACA_API_SECRET ? { alpacaApiSecret: env.ALPACA_API_SECRET } : {}),
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
  };
}

export function redactSecrets(value: unknown, secrets: readonly string[]): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return value;
  return JSON.parse(secrets.filter(Boolean).reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), serialized));
}
