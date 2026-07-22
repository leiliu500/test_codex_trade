import { loadDotEnv } from "./utils/loadDotEnv.js";
import { readEnvironment } from "./utils/env.js";
import { defaultConfig, validateConfig } from "./config.js";

loadDotEnv();
validateConfig(defaultConfig);
const environment = readEnvironment();

if (environment.tradingMode === "live") {
  throw new Error("Live mode needs an explicitly supplied TradingRestClient and stream adapters; refusing implicit live startup");
}

process.stdout.write(`${JSON.stringify({
  status: "ready",
  mode: "paper",
  symbol: defaultConfig.symbol,
  configVersion: defaultConfig.version,
  message: "Use the replay CLI or inject provider adapters into the serialized engine queue.",
})}\n`);
