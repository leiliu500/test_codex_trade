import { Client } from "pg";
import { defaultConfig } from "../config.js";
import { OptionBook } from "../options/optionBook.js";
import { OptionSelector } from "../options/optionSelector.js";
import { classifyRegime } from "../strategy/regimeClassifier.js";
import { SignalEngine } from "../strategy/signalEngine.js";
import type {
  FeatureSnapshot, OptionContract, OptionQuote, OptionSnapshot, TradeSignal,
} from "../types.js";
import { loadDotEnv } from "../utils/loadDotEnv.js";
import { zonedDateTimeToEpoch, zonedParts } from "../utils/time.js";

interface DayResult {
  date: string;
  featureSeconds: number;
  active: SignalSummary;
  experimentalContinuation: SignalSummary;
  staticProjectionOnly: SignalSummary;
  continuationDependent: SignalDetail[];
}

interface SignalSummary {
  signals: number;
  bullish: number;
  bearish: number;
  forwardDirectionalBps: Record<string, ForwardSummary>;
}

interface ForwardSummary {
  observations: number;
  average: number | null;
  median: number | null;
  alignedRate: number | null;
}

interface SignalDetail {
  timeEt: string;
  projectedMoveBps: number;
  baselineNearestTimeEt: string | null;
  baselineDeltaSec: number | null;
  forwardDirectionalBps: Record<string, number | null>;
  optionEligibility: OptionEligibility;
}

interface OptionEligibility {
  subscribedContracts: number;
  eligibleOptions: number;
  selectedSymbol: string | null;
  bestCandidate: {
    symbol: string;
    rejectionReasons: string[];
    projectedMoveBps: number;
    mid: number | null;
    spreadPct: number | null;
    delta: number | null;
    costMarginBps: number | null;
  } | null;
}

async function main(): Promise<void> {
  const startDate = process.argv[2] ?? "2026-07-22";
  const endDate = process.argv[3] ?? "2026-07-31";
  if (![startDate, endDate].every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)) || startDate > endDate) {
    throw new Error("Usage: npm run verify:feature-regression -- YYYY-MM-DD YYYY-MM-DD");
  }
  loadDotEnv();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const days: DayResult[] = [];
    for (const date of datesBetween(startDate, endDate)) {
      const features = await loadFeatures(client, date);
      if (features.length === 0) continue;
      const activeSignals = evaluate(
        features,
        defaultConfig.signals.bullishTrendContinuation.enabled,
      );
      const experimentalSignals = evaluate(features, true);
      const staticSignals = evaluate(features, false);
      const priceByTimestamp = new Map(features.map((feature) => [feature.timestamp, feature.price]));
      const dependentSignals = experimentalSignals.filter((signal) => signal.reasons.some((reason) =>
        reason.includes("aligned bullish continuation")));
      const continuationDependent: SignalDetail[] = [];
      for (const signal of dependentSignals) {
        continuationDependent.push({
          ...detail(signal, staticSignals, priceByTimestamp),
          optionEligibility: await optionEligibility(client, date, signal),
        });
      }
      days.push({
        date,
        featureSeconds: features.length,
        active: summarize(activeSignals, priceByTimestamp),
        experimentalContinuation: summarize(experimentalSignals, priceByTimestamp),
        staticProjectionOnly: summarize(staticSignals, priceByTimestamp),
        continuationDependent,
      });
    }
    process.stdout.write(`${JSON.stringify({
      startDate,
      endDate,
      symbol: defaultConfig.symbol,
      source: "preserved PostgreSQL feature_snapshot history (read-only)",
      days,
      aggregate: aggregate(days),
    }, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

async function loadFeatures(client: Client, date: string): Promise<FeatureSnapshot[]> {
  const start = zonedDateTimeToEpoch(date, defaultConfig.session.marketOpen, defaultConfig.timeZone);
  const end = zonedDateTimeToEpoch(date, defaultConfig.options.zeroDteEntryCutoff, defaultConfig.timeZone);
  const result = await client.query<{ data: FeatureSnapshot }>(`
    SELECT DISTINCT ON ((data->>'timestamp')::bigint) data
    FROM market_events
    WHERE symbol = $1
      AND event_type = 'feature_snapshot'
      AND provider_timestamp BETWEEN $2 AND $3
      AND (data->>'timestamp')::bigint BETWEEN $2 AND $3
    ORDER BY (data->>'timestamp')::bigint, id DESC
  `, [defaultConfig.symbol, start, end]);
  return result.rows.map((row) => row.data).sort((a, b) => a.timestamp - b.timestamp);
}

function evaluate(features: readonly FeatureSnapshot[], continuationEnabled: boolean): TradeSignal[] {
  const config = structuredClone(defaultConfig);
  config.signals.bullishTrendContinuation.enabled = continuationEnabled;
  const engine = new SignalEngine(config);
  const signals: TradeSignal[] = [];
  for (const feature of features) {
    const signal = engine.evaluate(feature, classifyRegime(feature, config.regimes));
    if (signal) signals.push(signal);
  }
  return signals;
}

function summarize(
  signals: readonly TradeSignal[], priceByTimestamp: ReadonlyMap<number, number>,
): SignalSummary {
  const forwardDirectionalBps: Record<string, ForwardSummary> = {};
  for (const horizonSec of [5, 15, 30, 60]) {
    const values = signals.flatMap((signal) => {
      const value = forward(signal, horizonSec, priceByTimestamp);
      return value === null ? [] : [value];
    });
    const sorted = [...values].sort((a, b) => a - b);
    forwardDirectionalBps[String(horizonSec)] = {
      observations: values.length,
      average: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      median: values.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : null,
      alignedRate: values.length > 0 ? values.filter((value) => value >= 0).length / values.length : null,
    };
  }
  return {
    signals: signals.length,
    bullish: signals.filter((signal) => signal.direction === "BULLISH").length,
    bearish: signals.filter((signal) => signal.direction === "BEARISH").length,
    forwardDirectionalBps,
  };
}

function detail(
  signal: TradeSignal,
  baselineSignals: readonly TradeSignal[],
  priceByTimestamp: ReadonlyMap<number, number>,
): Omit<SignalDetail, "optionEligibility"> {
  const nearest = baselineSignals
    .filter((candidate) => candidate.direction === signal.direction)
    .map((candidate) => ({ candidate, delta: candidate.timestamp - signal.timestamp }))
    .filter(({ delta }) => Math.abs(delta) <= 30_000)
    .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];
  return {
    timeEt: formatEt(signal.timestamp),
    projectedMoveBps: signal.projectedMoveBps,
    baselineNearestTimeEt: nearest ? formatEt(nearest.candidate.timestamp) : null,
    baselineDeltaSec: nearest ? nearest.delta / 1000 : null,
    forwardDirectionalBps: Object.fromEntries([5, 15, 30, 60].map((horizonSec) =>
      [String(horizonSec), forward(signal, horizonSec, priceByTimestamp)])),
  };
}

async function optionEligibility(
  client: Client, date: string, signal: TradeSignal,
): Promise<OptionEligibility> {
  const snapshots = await client.query<{ data: OptionSnapshot }>(`
    SELECT DISTINCT ON (symbol) data
    FROM market_events
    WHERE market_date = $1
      AND event_type = 'option_snapshot'
      AND provider_timestamp BETWEEN $2 AND $3
    ORDER BY symbol, provider_timestamp DESC, id DESC
  `, [date, signal.timestamp - 90_000, signal.timestamp]);
  const symbols = snapshots.rows.map((row) => row.data.symbol);
  if (symbols.length === 0) return emptyOptionEligibility();
  const contracts = await client.query<{ data: OptionContract }>(`
    SELECT DISTINCT ON (symbol) data
    FROM market_events
    WHERE market_date = $1
      AND event_type = 'option_contract'
      AND symbol = ANY($2::text[])
      AND provider_timestamp <= $3
    ORDER BY symbol, provider_timestamp DESC, id DESC
  `, [date, symbols, signal.timestamp]);
  const quotes = await client.query<{ data: OptionQuote }>(`
    SELECT DISTINCT ON (symbol) data
    FROM market_events
    WHERE market_date = $1
      AND event_type = 'option_quote'
      AND symbol = ANY($2::text[])
      AND provider_timestamp BETWEEN $3 AND $4
    ORDER BY symbol, provider_timestamp DESC, id DESC
  `, [date, symbols, signal.timestamp - defaultConfig.dataQuality.maxOptionQuoteAgeMs, signal.timestamp]);
  const book = new OptionBook();
  for (const row of contracts.rows) book.upsertContract(row.data);
  for (const row of snapshots.rows) book.updateSnapshot(row.data);
  for (const row of quotes.rows) book.updateQuote(row.data);
  const contractValues = contracts.rows.map((row) => row.data);
  const selection = new OptionSelector(defaultConfig).select(
    signal, contractValues, book, signal.timestamp,
  );
  const best = [...selection.evaluations].sort((a, b) =>
    a.rejectionReasons.length - b.rejectionReasons.length ||
    (b.costMarginBps ?? -Infinity) - (a.costMarginBps ?? -Infinity))[0];
  return {
    subscribedContracts: contractValues.length,
    eligibleOptions: selection.evaluations.filter((candidate) => candidate.eligible).length,
    selectedSymbol: selection.selected?.symbol ?? null,
    bestCandidate: best ? {
      symbol: best.symbol,
      rejectionReasons: best.rejectionReasons,
      projectedMoveBps: signal.projectedMoveBps,
      mid: best.mid ?? null,
      spreadPct: best.spreadPct ?? null,
      delta: best.delta ?? null,
      costMarginBps: best.costMarginBps ?? null,
    } : null,
  };
}

function emptyOptionEligibility(): OptionEligibility {
  return {
    subscribedContracts: 0,
    eligibleOptions: 0,
    selectedSymbol: null,
    bestCandidate: null,
  };
}

function forward(
  signal: TradeSignal, horizonSec: number, priceByTimestamp: ReadonlyMap<number, number>,
): number | null {
  const price = priceByTimestamp.get(signal.timestamp + horizonSec * 1000);
  if (price === undefined) return null;
  const sign = signal.direction === "BULLISH" ? 1 : -1;
  return sign * (price / signal.featureSnapshot.price - 1) * 10_000;
}

function aggregate(days: readonly DayResult[]): Record<string, unknown> {
  const dependent = days.flatMap((day) => day.continuationDependent);
  const optionEligible = dependent.filter((signal) => signal.optionEligibility.eligibleOptions > 0);
  return {
    tradingDays: days.length,
    featureSeconds: days.reduce((sum, day) => sum + day.featureSeconds, 0),
    activeSignals: days.reduce((sum, day) => sum + day.active.signals, 0),
    experimentalContinuationSignals:
      days.reduce((sum, day) => sum + day.experimentalContinuation.signals, 0),
    staticProjectionOnlySignals: days.reduce((sum, day) => sum + day.staticProjectionOnly.signals, 0),
    continuationDependentSignals: dependent.length,
    optionEligibleContinuationSignals: optionEligible.length,
    continuationDependentForwardDirectionalBps: Object.fromEntries([5, 15, 30, 60].map((horizonSec) => {
      const values = dependent.flatMap((signal) => {
        const value = signal.forwardDirectionalBps[String(horizonSec)];
        return value === null || value === undefined ? [] : [value];
      });
      return [String(horizonSec), summarizeValues(values)];
    })),
    optionEligibleContinuationForwardDirectionalBps: Object.fromEntries([5, 15, 30, 60].map((horizonSec) => {
      const values = optionEligible.flatMap((signal) => {
        const value = signal.forwardDirectionalBps[String(horizonSec)];
        return value === null || value === undefined ? [] : [value];
      });
      return [String(horizonSec), summarizeValues(values)];
    })),
  };
}

function summarizeValues(values: readonly number[]): ForwardSummary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    observations: values.length,
    average: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    median: values.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : null,
    alignedRate: values.length > 0 ? values.filter((value) => value >= 0).length / values.length : null,
  };
}

function datesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let timestamp = Date.parse(`${startDate}T00:00:00Z`);
    timestamp <= Date.parse(`${endDate}T00:00:00Z`);
    timestamp += 86_400_000) {
    const date = new Date(timestamp);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) {
      dates.push(date.toISOString().slice(0, 10));
    }
  }
  return dates;
}

function formatEt(timestamp: number): string {
  const parts = zonedParts(timestamp, defaultConfig.timeZone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:` +
    `${String(parts.second).padStart(2, "0")}`;
}

await main();
