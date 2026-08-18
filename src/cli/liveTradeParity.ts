import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import {
  defaultConfig, mergeConfig, validateConfig, type EngineConfig,
} from "../config.js";
import {
  replayLiveTradeManagement,
  type LiveManagementEvent,
  type LiveTradeParityResult,
  type ObservedLiveExit,
} from "../backtest/liveTradeParity.js";
import type { FeatureSnapshot, OptionQuote, OptionSnapshot, PositionState } from "../types.js";
import { loadDotEnv } from "../utils/loadDotEnv.js";

interface AuditRow {
  id: string;
  timestamp: string;
  type: string;
  configVersion: string;
  data: Record<string, unknown>;
}

interface MarketRow {
  id: string;
  receivedTimestamp: string;
  providerTimestamp: string;
  type: "feature_snapshot" | "option_quote" | "option_snapshot";
  data: Record<string, unknown>;
}

interface ConfigResolution {
  config: EngineConfig;
  source: "explicit" | "runtime_snapshot" | "current_default" | "version_archive";
  timerIntervalMs: number;
}

interface TradeReport {
  configSource: ConfigResolution["source"];
  timerIntervalMs: number;
  result: LiveTradeParityResult;
  strictParity: boolean;
}

const PRE_ENTRY_CONTEXT_MS = 5 * 60_000;
const POST_FILL_CONTEXT_MS = 5_000;
const TIMESTAMP_TOLERANCE_MS = 10;
const PNL_TOLERANCE_DOLLARS = 0.01;
const PRICE_TOLERANCE_DOLLARS = 0.000_001;

async function main(): Promise<void> {
  const marketDate = process.argv[2];
  const selectedEntry = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
  const explicitConfigPath = process.argv[4];
  if (!marketDate || !/^\d{4}-\d{2}-\d{2}$/.test(marketDate) ||
      (selectedEntry !== undefined && !Number.isSafeInteger(selectedEntry))) {
    throw new Error(
      "Usage: npm run parity:live -- YYYY-MM-DD [ENTRY_TIMESTAMP_MS] [CONFIG_JSON]",
    );
  }

  loadDotEnv();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const audits = await loadAudits(client, marketDate);
    const entries = brokerConfirmedEntries(audits).filter((position) =>
      selectedEntry === undefined || position.entryTimestamp === selectedEntry);
    if (entries.length === 0) {
      throw new Error(
        selectedEntry === undefined
          ? `No broker-confirmed entries found for ${marketDate}`
          : `No broker-confirmed entry ${selectedEntry} found for ${marketDate}`,
      );
    }

    const reports: TradeReport[] = [];
    const skipped: Array<{ entryTimestamp: number; symbol: string; reason: string }> = [];
    for (const position of entries) {
      const entryAudit = audits.find((event) =>
        event.type === "entry_fill" &&
        numberValue(objectValue(event.data.position).entryTimestamp) === position.entryTimestamp);
      if (!entryAudit) continue;
      const exitFills = audits.filter((event) =>
        event.type === "exit_fill" &&
        numberValue(event.data.entryTimestamp) === position.entryTimestamp);
      if (exitFills.length === 0) {
        skipped.push({
          entryTimestamp: position.entryTimestamp,
          symbol: position.symbol,
          reason: "trade has no broker-confirmed exit fill",
        });
        continue;
      }
      const exitIntentId = stringValue(exitFills[0]!.data.exitIntentId);
      const exitRequest = audits.find((event) =>
        event.type === "broker_order_request" &&
        event.data.purpose === "EXIT" &&
        (!exitIntentId || event.data.exitIntentId === exitIntentId));
      if (!exitRequest) {
        skipped.push({
          entryTimestamp: position.entryTimestamp,
          symbol: position.symbol,
          reason: "trade has no matching live exit order request",
        });
        continue;
      }

      const resolution = await resolveConfig(
        audits,
        entryAudit.configVersion,
        position.entryTimestamp,
        explicitConfigPath,
      );
      const observedExit = aggregateObservedExit(exitRequest, exitFills);
      const events = await loadMarketEvents(
        client,
        resolution.config.symbol,
        position.symbol,
        position.entryTimestamp - PRE_ENTRY_CONTEXT_MS,
        observedExit.fillTimestamp + POST_FILL_CONTEXT_MS,
      );
      const result = replayLiveTradeManagement({
        config: resolution.config,
        sourceConfigVersion: entryAudit.configVersion,
        position,
        events,
        observedExit,
        timerIntervalMs: resolution.timerIntervalMs,
        dailyRealizedPnlBeforeEntry: audits
          .filter((event) =>
            event.type === "exit_fill" &&
            Number(event.timestamp) < position.entryTimestamp &&
            stringValue(event.data.underlying) === resolution.config.symbol)
          .reduce((sum, event) => sum + (numberValue(event.data.realizedPnl) ?? 0), 0),
      });
      reports.push({
        configSource: resolution.source,
        timerIntervalMs: resolution.timerIntervalMs,
        result,
        strictParity: strictParity(result),
      });
    }

    process.stdout.write(`${JSON.stringify({
      marketDate,
      selectedEntryTimestamp: selectedEntry ?? null,
      methodology: {
        entry: "broker-confirmed contract, quantity, timestamp, and average fill",
        decisions: "live feature ticks, accepted last quote per OPRA callback batch, and recorded runtime timer cadence",
        pnl: "decision executable mark, submitted limit, quote bid near fill, and broker fill are reported separately",
        strictTolerance: {
          decisionTimestampMs: TIMESTAMP_TOLERANCE_MS,
          executablePnlDollars: PNL_TOLERANCE_DOLLARS,
          submittedLimitPriceDollars: PRICE_TOLERANCE_DOLLARS,
        },
      },
      summary: {
        brokerConfirmedEntries: entries.length,
        completedCompared: reports.length,
        strictParityMatches: reports.filter((report) => report.strictParity).length,
        skipped: skipped.length,
      },
      trades: reports,
      skipped,
    }, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

async function loadAudits(client: Client, marketDate: string): Promise<AuditRow[]> {
  const result = await client.query<{
    id: string;
    event_timestamp: string;
    event_type: string;
    config_version: string;
    data: Record<string, unknown>;
  }>(`
    SELECT id, event_timestamp, event_type, config_version, data
    FROM audit_events
    WHERE market_date = $1
      AND event_type IN (
        'runtime_config_snapshot', 'entry_fill', 'broker_order_request', 'exit_fill'
      )
    ORDER BY id
  `, [marketDate]);
  return result.rows.map((row) => ({
    id: row.id,
    timestamp: row.event_timestamp,
    type: row.event_type,
    configVersion: row.config_version,
    data: row.data,
  }));
}

async function loadMarketEvents(
  client: Client,
  underlying: EngineConfig["symbol"],
  optionSymbol: string,
  startTimestamp: number,
  endTimestamp: number,
): Promise<LiveManagementEvent[]> {
  const result = await client.query<{
    id: string;
    received_timestamp: string;
    provider_timestamp: string;
    event_type: MarketRow["type"];
    data: Record<string, unknown>;
  }>(`
    SELECT id, received_timestamp, provider_timestamp, event_type, data
    FROM market_events
    WHERE received_timestamp BETWEEN $1 AND $2
      AND (
        (event_type = 'feature_snapshot' AND symbol = $3) OR
        (event_type IN ('option_quote', 'option_snapshot') AND symbol = $4)
      )
    ORDER BY received_timestamp, id
  `, [startTimestamp, endTimestamp, underlying, optionSymbol]);
  return result.rows.map((row) => {
    const common = {
      sequence: Number(row.id),
      receivedTimestamp: Number(row.received_timestamp),
      providerTimestamp: Number(row.provider_timestamp),
    };
    if (row.event_type === "feature_snapshot") {
      return { ...common, type: row.event_type, data: row.data as unknown as FeatureSnapshot };
    }
    if (row.event_type === "option_quote") {
      return { ...common, type: row.event_type, data: row.data as unknown as OptionQuote };
    }
    return { ...common, type: row.event_type, data: row.data as unknown as OptionSnapshot };
  });
}

function brokerConfirmedEntries(audits: readonly AuditRow[]): PositionState[] {
  const positions = new Map<number, PositionState>();
  for (const event of audits) {
    if (event.type !== "entry_fill") continue;
    const candidate = objectValue(event.data.position) as unknown as PositionState;
    if (Number.isSafeInteger(candidate.entryTimestamp) && candidate.symbol) {
      positions.set(candidate.entryTimestamp, structuredClone(candidate));
    }
  }
  return [...positions.values()].sort((left, right) => left.entryTimestamp - right.entryTimestamp);
}

function aggregateObservedExit(
  request: AuditRow,
  exitFills: readonly AuditRow[],
): ObservedLiveExit {
  const ordered = [...exitFills].sort((left, right) => Number(left.timestamp) - Number(right.timestamp));
  const order = objectValue(request.data.order);
  let quantity = 0;
  let notional = 0;
  let realizedPnl = 0;
  for (const fill of ordered) {
    const incrementalQuantity = numberValue(fill.data.incrementalQuantity) ?? 0;
    quantity += incrementalQuantity;
    notional += incrementalQuantity * requiredNumber(fill.data.incrementalPrice, "exit fill price");
    realizedPnl += requiredNumber(fill.data.realizedPnl, "exit realized P&L");
  }
  if (!(quantity > 0)) throw new Error("Exit audit has no positive broker-filled quantity");
  const decisionTimestamp = Number(request.timestamp);
  const fillTimestamp = numberValue(ordered.at(-1)!.data.brokerFillTimestamp) ??
    Number(ordered.at(-1)!.timestamp);
  return {
    decisionTimestamp,
    fillTimestamp,
    fillPrice: notional / quantity,
    realizedPnl,
    reason: stringValue(request.data.reason) ?? stringValue(ordered[0]!.data.reason) ?? "UNKNOWN",
    submittedLimitPrice: requiredNumber(order.limitPrice, "submitted exit limit"),
    ...(numberValue(request.data.executablePnl) !== undefined
      ? { decisionExecutablePnl: numberValue(request.data.executablePnl)! }
      : {}),
    fillLatencyMs: fillTimestamp - decisionTimestamp,
  };
}

async function resolveConfig(
  audits: readonly AuditRow[],
  sourceVersion: string,
  entryTimestamp: number,
  explicitPath?: string,
): Promise<ConfigResolution> {
  if (explicitPath) {
    return { config: await readConfig(explicitPath), source: "explicit", timerIntervalMs: 250 };
  }
  const snapshot = [...audits].reverse().find((event) =>
    event.type === "runtime_config_snapshot" &&
    event.configVersion === sourceVersion &&
    Number(event.timestamp) <= entryTimestamp &&
    objectValue(event.data.config).version === sourceVersion);
  if (snapshot) {
    return {
      config: normalizeConfig(objectValue(snapshot.data.config)),
      source: "runtime_snapshot",
      timerIntervalMs: nonNegativeInteger(snapshot.data.executionTickMs) ?? 250,
    };
  }
  if (defaultConfig.version === sourceVersion) {
    return {
      config: structuredClone(defaultConfig), source: "current_default", timerIntervalMs: 250,
    };
  }
  if (/^[a-zA-Z0-9._-]+$/.test(sourceVersion)) {
    const archivePath = resolve(process.cwd(), "config", "history", `${sourceVersion}.json`);
    if (await exists(archivePath)) {
      return {
        config: await readConfig(archivePath), source: "version_archive", timerIntervalMs: 250,
      };
    }
  }
  throw new Error(
    `No exact configuration is available for ${sourceVersion}; ` +
    "provide its JSON path explicitly instead of comparing against a different version",
  );
}

async function readConfig(path: string): Promise<EngineConfig> {
  const parsed: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  if (!isObject(parsed)) throw new Error(`Configuration ${path} is not a JSON object`);
  return normalizeConfig(parsed);
}

function normalizeConfig(value: Record<string, unknown>): EngineConfig {
  const config = mergeConfig(value as Partial<EngineConfig>);
  validateConfig(config);
  return config;
}

function strictParity(result: LiveTradeParityResult): boolean {
  return result.configVersionMatches !== false &&
    result.parity.reasonMatches === true &&
    result.parity.decisionTimestampDeltaMs !== undefined &&
    Math.abs(result.parity.decisionTimestampDeltaMs) <= TIMESTAMP_TOLERANCE_MS &&
    (result.parity.decisionExecutablePnlDelta === undefined ||
      Math.abs(result.parity.decisionExecutablePnlDelta) <= PNL_TOLERANCE_DOLLARS) &&
    result.parity.submittedLimitPriceDelta !== undefined &&
    Math.abs(result.parity.submittedLimitPriceDelta) <= PRICE_TOLERANCE_DOLLARS;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function requiredNumber(value: unknown, label: string): number {
  const number = numberValue(value);
  if (number === undefined) throw new Error(`Live audit is missing ${label}`);
  return number;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

await main();
