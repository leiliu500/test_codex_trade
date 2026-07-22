export interface RuntimeEnvironment {
  tradingMode: "paper" | "live";
  liveOrdersEnabled: boolean;
  marketDataEnabled: boolean;
  stockDataFeed: "sip";
  optionDataFeed: "opra";
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
  const healthPort = Number(env.HEALTH_PORT ?? "8080");
  const healthHost = env.HEALTH_HOST?.trim() || "127.0.0.1";
  if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65_535) {
    throw new Error("HEALTH_PORT must be an integer between 1 and 65535");
  }
  if (stockDataFeed !== "sip") throw new Error("This runtime is hard-limited to the SPY SIP stock-data feed");
  if (optionDataFeed !== "opra") throw new Error("Executable option trading requires the real-time OPRA option-data feed");
  if (liveOrdersEnabled && !marketDataEnabled) {
    throw new Error("Broker order execution requires MARKET_DATA_ENABLED=true");
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
    killSwitch: env.KILL_SWITCH === "true",
    healthHost,
    healthPort,
    ...(env.ALPACA_API_KEY ? { alpacaApiKey: env.ALPACA_API_KEY } : {}),
    ...(env.ALPACA_API_SECRET ? { alpacaApiSecret: env.ALPACA_API_SECRET } : {}),
  };
}

export function redactSecrets(value: unknown, secrets: readonly string[]): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return value;
  return JSON.parse(secrets.filter(Boolean).reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), serialized));
}
