import { defaultConfig, type EngineConfig } from "../config.js";
import { SecondAggregator } from "../features/secondAggregator.js";
import { FeatureEngine } from "../features/featureEngine.js";
import { classifyRegime } from "../strategy/regimeClassifier.js";
import { SignalEngine } from "../strategy/signalEngine.js";
import type { SecondBar, StockQuote, TradeSignal } from "../types.js";
import { loadDotEnv } from "../utils/loadDotEnv.js";
import { marketDate, zonedDateTimeToEpoch, zonedParts } from "../utils/time.js";

type StockFeed = "iex" | "sip";

interface RawQuote { t: string; bp: number; ap: number; bs: number; as: number; bx?: string; ax?: string; c?: string[] }
interface RawTrade { t: string; p: number; s: number; x?: string; c?: string[] }
interface TradeBucket { volume: number; notional: number }

async function main(): Promise<void> {
  const date = process.argv[2] ?? "2026-07-21";
  const feed = (process.argv[3] ?? "sip") as StockFeed;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !["iex", "sip"].includes(feed)) {
    throw new Error("Usage: npm run test:historical -- YYYY-MM-DD [iex|sip]");
  }
  loadDotEnv();
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) throw new Error("ALPACA_API_KEY and ALPACA_API_SECRET are required");
  const headers = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
  const start = zonedDateTimeToEpoch(date, defaultConfig.session.marketOpen, defaultConfig.timeZone);
  const end = zonedDateTimeToEpoch(date, defaultConfig.session.forceExit, defaultConfig.timeZone);
  const common = {
    start: new Date(start).toISOString(), end: new Date(end).toISOString(), feed, limit: "10000", sort: "asc",
  };

  process.stderr.write(`Downloading ${feed.toUpperCase()} SPY trades for ${date}...\n`);
  const tradeBuckets = new Map<number, TradeBucket>();
  let previousTradeKey: string | undefined;
  let rejectedTrades = 0;
  const [tradeCount, priorClose] = await Promise.all([
    fetchPages<RawTrade>("/v2/stocks/SPY/trades", "trades", common, headers, (page) => {
      for (const trade of page) {
        const timestamp = Date.parse(trade.t);
        const tradeKey = JSON.stringify([trade.t, trade.p, trade.s, trade.x, trade.c]);
        if (!Number.isFinite(timestamp) || !(trade.p > 0) || !(trade.s > 0) || tradeKey === previousTradeKey) {
          rejectedTrades += 1;
          previousTradeKey = tradeKey;
          continue;
        }
        previousTradeKey = tradeKey;
        const bucketEnd = Math.floor(timestamp / 1000) * 1000 + 1000;
        const bucket = tradeBuckets.get(bucketEnd) ?? { volume: 0, notional: 0 };
        bucket.volume += trade.s;
        bucket.notional += trade.p * trade.s;
        tradeBuckets.set(bucketEnd, bucket);
      }
    }),
    fetchPriorClose(date, feed, headers),
  ]);

  process.stderr.write(`Downloading ${feed.toUpperCase()} SPY quotes and aggregating each second...\n`);
  const aggregator = new SecondAggregator(defaultConfig.dataQuality);
  const bars: SecondBar[] = [];
  let rejectedQuotes = 0;
  const quoteCount = await fetchPages<RawQuote>("/v2/stocks/SPY/quotes", "quotes", common, headers, (page) => {
    for (const quote of page) {
      const timestamp = Date.parse(quote.t);
      const data: StockQuote = {
        symbol: "SPY", timestamp, bidPrice: quote.bp, askPrice: quote.ap, bidSize: quote.bs, askSize: quote.as,
        ...(quote.bx ? { bidExchange: quote.bx } : {}), ...(quote.ax ? { askExchange: quote.ax } : {}),
        ...(quote.c ? { conditions: quote.c } : {}),
      };
      const result = aggregator.ingestQuote(data);
      bars.push(...result.bars);
      if (result.rejected) rejectedQuotes += 1;
    }
  });
  bars.push(...aggregator.flushThrough(end));

  for (const bar of bars) {
    const trades = tradeBuckets.get(bar.timestamp);
    if (!trades) continue;
    bar.tradeVolume = trades.volume;
    bar.tradeVwap = trades.notional / trades.volume;
  }
  process.stderr.write(
    `Processed ${quoteCount.toLocaleString()} quotes and ${tradeCount.toLocaleString()} trades into ${bars.length.toLocaleString()} second bars. Evaluating...\n`,
  );

  const features = new FeatureEngine(defaultConfig);
  features.setPriorClose(priorClose);
  const signalEngine = new SignalEngine(defaultConfig);
  const signals: TradeSignal[] = [];
  const regimes: Record<string, number> = {};
  const invalidReasons: Record<string, number> = {};
  let decisionSeconds = 0;
  let validFeatureSeconds = 0;
  for (const bar of bars) {
    const feature = features.onBar(bar);
    if (!feature) continue;
    decisionSeconds += 1;
    if (feature.dataValid) validFeatureSeconds += 1;
    for (const reason of feature.invalidReasons) invalidReasons[reason] = (invalidReasons[reason] ?? 0) + 1;
    const regime = classifyRegime(feature, defaultConfig.regimes);
    regimes[regime.regime] = (regimes[regime.regime] ?? 0) + 1;
    const signal = signalEngine.evaluate(feature, regime);
    if (signal) signals.push(signal);
  }

  const byKind: Record<string, number> = {};
  const byDirection: Record<string, number> = {};
  const bySignalRegime: Record<string, number> = {};
  for (const signal of signals) {
    byKind[signal.kind] = (byKind[signal.kind] ?? 0) + 1;
    byDirection[signal.direction] = (byDirection[signal.direction] ?? 0) + 1;
    bySignalRegime[signal.regime] = (bySignalRegime[signal.regime] ?? 0) + 1;
  }
  const signalDetails = signals.map((signal) => ({
    timeEt: formatEt(signal.timestamp), direction: signal.direction, kind: signal.kind,
    regime: signal.regime, projectedMoveBps: signal.projectedMoveBps,
    votesPassed: signal.votes.filter((vote) => vote.passed).map((vote) => vote.name),
    price: signal.featureSnapshot.price,
  }));
  const baselineConfig = structuredClone(defaultConfig);
  baselineConfig.signals.followThroughMinSec = 0;
  baselineConfig.signals.followThroughMaxSec = 0;
  baselineConfig.signals.bullishImpulseCutoff = baselineConfig.session.entryEnd;
  baselineConfig.options.zeroDteEntryCutoff = baselineConfig.session.entryEnd;
  const baselineSignals = evaluateSignals(bars, priorClose, baselineConfig);
  const impulseConfirmationConfig = structuredClone(defaultConfig);
  impulseConfirmationConfig.signals.followThroughScope = "IMPULSE";
  const impulseConfirmationSignals = evaluateSignals(bars, priorClose, impulseConfirmationConfig);
  const allEntryConfirmationConfig = structuredClone(defaultConfig);
  allEntryConfirmationConfig.signals.followThroughScope = "ALL";
  const allEntryConfirmationSignals = evaluateSignals(bars, priorClose, allEntryConfirmationConfig);
  const baselineSummary = summarizeSignals(baselineSignals, bars);
  const guardedSummary = summarizeSignals(signals, bars);
  process.stdout.write(`${JSON.stringify({
    date, symbol: "SPY", feed, priorClose,
    sourceEvents: { quotes: quoteCount, trades: tradeCount, rejectedQuotes, rejectedTrades },
    secondBars: bars.length,
    decisionSeconds,
    validFeatureSeconds,
    signals: signals.length,
    byKind, byDirection, bySignalRegime,
    regimeSeconds: regimes,
    invalidFeatureReasons: invalidReasons,
    signalDetails,
    guardComparison: {
      baseline: baselineSummary,
      guarded: guardedSummary,
      profiles: {
        immediateEntry: baselineSummary,
        bullishImpulseConfirmation: guardedSummary,
        impulseConfirmation: summarizeSignals(impulseConfirmationSignals, bars),
        allEntryConfirmation: summarizeSignals(allEntryConfirmationSignals, bars),
      },
      suppressedOrDelayedSignals: Math.max(0, baselineSignals.length - signals.length),
    },
    optionBacktest: {
      performed: false,
      reason: "Alpaca historical options data does not provide timestamped bid/ask quotes required by the spread and cost gate.",
      trades: null,
      pnl: null,
    },
  }, null, 2)}\n`);
}

function evaluateSignals(
  bars: readonly SecondBar[], priorClose: number, config: EngineConfig,
): TradeSignal[] {
  const features = new FeatureEngine(config);
  features.setPriorClose(priorClose);
  const signalEngine = new SignalEngine(config);
  const signals: TradeSignal[] = [];
  for (const bar of bars) {
    const feature = features.onBar(bar);
    if (!feature) continue;
    const signal = signalEngine.evaluate(feature, classifyRegime(feature, config.regimes));
    if (signal) signals.push(signal);
  }
  return signals;
}

function summarizeSignals(signals: readonly TradeSignal[], bars: readonly SecondBar[]): Record<string, unknown> {
  const prices = new Map<number, number>();
  for (const bar of bars) {
    const price = bar.microprice ?? bar.mid ?? bar.tradeVwap;
    if (price !== undefined && Number.isFinite(price)) prices.set(bar.timestamp, price);
  }
  const byKind: Record<string, number> = {};
  const byDirection: Record<string, number> = {};
  let bullishImpulseAfter1300 = 0;
  let after1430 = 0;
  for (const signal of signals) {
    byKind[signal.kind] = (byKind[signal.kind] ?? 0) + 1;
    byDirection[signal.direction] = (byDirection[signal.direction] ?? 0) + 1;
    const time = zonedParts(signal.timestamp, defaultConfig.timeZone);
    const seconds = time.hour * 3600 + time.minute * 60 + time.second;
    if (signal.direction === "BULLISH" && signal.kind === "IMPULSE" && seconds > 13 * 3600) bullishImpulseAfter1300 += 1;
    if (seconds > 14 * 3600 + 30 * 60) after1430 += 1;
  }
  const forwardDirectionalBps: Record<string, unknown> = {};
  for (const horizonSec of [5, 15, 30, 60]) {
    const values = signals.flatMap((signal) => {
      const future = prices.get(signal.timestamp + horizonSec * 1000);
      if (future === undefined) return [];
      const sign = signal.direction === "BULLISH" ? 1 : -1;
      return [sign * (future / signal.featureSnapshot.price - 1) * 10_000];
    });
    const sorted = [...values].sort((a, b) => a - b);
    forwardDirectionalBps[String(horizonSec)] = {
      observations: values.length,
      average: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      median: values.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null,
      alignedRate: values.length > 0 ? values.filter((value) => value >= 0).length / values.length : null,
    };
  }
  return {
    signals: signals.length,
    byKind,
    byDirection,
    bullishImpulseAfter1300,
    after1430,
    forwardDirectionalBps,
  };
}

async function fetchPages<T>(
  path: string,
  field: string,
  parameters: Record<string, string>,
  headers: Record<string, string>,
  onPage: (events: T[]) => void,
): Promise<number> {
  let count = 0;
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const query = new URLSearchParams(parameters);
    if (pageToken) query.set("page_token", pageToken);
    const response = await fetch(`https://data.alpaca.markets${path}?${query}`, { headers });
    if (!response.ok) throw new Error(`Alpaca ${path} HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const body = await response.json() as Record<string, unknown>;
    const events = (body[field] as T[] | undefined) ?? [];
    onPage(events);
    count += events.length;
    pageToken = typeof body.next_page_token === "string" ? body.next_page_token : undefined;
    pages += 1;
    if (pages % 20 === 0) process.stderr.write(`${field}: ${count.toLocaleString()} events...\n`);
  } while (pageToken);
  return count;
}

async function fetchPriorClose(date: string, feed: StockFeed, headers: Record<string, string>): Promise<number> {
  const dateEpoch = Date.parse(`${date}T00:00:00Z`);
  const start = new Date(dateEpoch - 10 * 86_400_000).toISOString();
  const query = new URLSearchParams({ timeframe: "1Day", start, end: date, feed, adjustment: "raw", sort: "asc", limit: "100" });
  const response = await fetch(`https://data.alpaca.markets/v2/stocks/SPY/bars?${query}`, { headers });
  if (!response.ok) throw new Error(`Alpaca prior-close HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const body = await response.json() as { bars?: Array<{ t: string; c: number }> };
  const earlier = (body.bars ?? []).filter((bar) => marketDate(Date.parse(bar.t), defaultConfig.timeZone) < date);
  const close = earlier.at(-1)?.c;
  if (!(close && close > 0)) throw new Error(`No prior SPY close found before ${date}`);
  return close;
}

function formatEt(timestamp: number): string {
  const p = zonedParts(timestamp, defaultConfig.timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")}`;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
