export interface RuntimeEnvironment {
  tradingMode: "paper" | "live";
  liveOrdersEnabled: boolean;
  killSwitch: boolean;
  alpacaApiKey?: string;
  alpacaApiSecret?: string;
}

export function readEnvironment(env: NodeJS.ProcessEnv = process.env): RuntimeEnvironment {
  const tradingMode = env.TRADING_MODE === "live" ? "live" : "paper";
  const liveOrdersEnabled = env.ENABLE_LIVE_ORDERS === "true";
  if (tradingMode === "live" && !liveOrdersEnabled) {
    throw new Error("Live mode requires ENABLE_LIVE_ORDERS=true; paper mode is the safe default");
  }
  if (tradingMode === "live" && (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET)) {
    throw new Error("Live mode requires broker credentials");
  }
  return {
    tradingMode,
    liveOrdersEnabled,
    killSwitch: env.KILL_SWITCH === "true",
    ...(env.ALPACA_API_KEY ? { alpacaApiKey: env.ALPACA_API_KEY } : {}),
    ...(env.ALPACA_API_SECRET ? { alpacaApiSecret: env.ALPACA_API_SECRET } : {}),
  };
}

export function redactSecrets(value: unknown, secrets: readonly string[]): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return value;
  return JSON.parse(secrets.filter(Boolean).reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), serialized));
}
