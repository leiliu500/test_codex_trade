import { correlation, mean, sampleStdDev, sum } from "../utils/statistics.js";

export interface CompletedTrade {
  sessionDate: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  entryTimestamp: number;
  exitTimestamp: number;
  fees: number;
  direction?: "BULLISH" | "BEARISH";
  kind?: "IMPULSE" | "GRIND";
  regime?: string;
  dte?: number;
  delta?: number;
  optionSpreadPct?: number;
  marks?: number[];
  estimatedTradingCost?: number;
}

export interface TradeMetric {
  pnl: number;
  returnOnPremium: number;
  holdingTimeMs: number;
  mfe?: number;
  mae?: number;
}

export interface StrategyMetrics {
  trades: number;
  wins: number;
  losses: number;
  grossPnl: number;
  netPnl: number;
  winRate?: number;
  expectancy?: number;
  averageWin?: number;
  averageLoss?: number;
  payoffRatio?: number;
  profitFactor?: number;
  maximumDrawdown: number;
  maximumDrawdownPct?: number;
  averageHoldingTimeMs?: number;
  sharpe?: number;
  sortino?: number;
  costRatio: number;
}

export interface ExecutionRecord {
  side: "buy" | "sell";
  accepted: boolean;
  rejected: boolean;
  canceled: boolean;
  requestedQuantity: number;
  filledQuantity: number;
  replacements: number;
  submittedAt: number;
  firstFillAt?: number;
  fullFillAt?: number;
  submissionMid: number;
  averageFillPrice?: number;
  signalTimestamp?: number;
  spread: number;
  signalReferencePrice?: number;
}

export interface ExecutionMetrics {
  orders: number;
  acceptanceRate: number;
  fullFillRate: number;
  partialFillRate: number;
  cancelRate: number;
  rejectionRate: number;
  averageTimeToFirstFillMs?: number;
  averageTimeToFullFillMs?: number;
  averageReplacements: number;
  averageAdverseSlippage?: number;
  averageSignalToFillDelayMs?: number;
  averageSignalToFillPriceLoss?: number;
  averageSpreadFractionPaid?: number;
}

export function computeExecutionMetrics(records: readonly ExecutionRecord[]): ExecutionMetrics {
  const count = records.length;
  const firstFill = records.filter((record) => record.firstFillAt !== undefined);
  const fullFill = records.filter((record) => record.fullFillAt !== undefined && record.filledQuantity === record.requestedQuantity);
  const slippages = records.flatMap((record) => record.averageFillPrice === undefined ? [] : [
    record.side === "buy" ? record.averageFillPrice - record.submissionMid : record.submissionMid - record.averageFillPrice,
  ]);
  const signalDelays = firstFill.flatMap((record) => record.signalTimestamp === undefined ? [] : [record.firstFillAt! - record.signalTimestamp]);
  const signalPriceLosses = records.flatMap((record) =>
    record.averageFillPrice === undefined || record.signalReferencePrice === undefined ? [] : [
      record.side === "buy"
        ? record.averageFillPrice - record.signalReferencePrice
        : record.signalReferencePrice - record.averageFillPrice,
    ]);
  const spreadFractions = records.flatMap((record) =>
    record.averageFillPrice === undefined || !(record.spread > 0) ? [] : [
      (record.side === "buy"
        ? record.averageFillPrice - (record.submissionMid - record.spread / 2)
        : (record.submissionMid + record.spread / 2) - record.averageFillPrice) / record.spread,
    ]);
  return {
    orders: count,
    acceptanceRate: count ? records.filter((record) => record.accepted).length / count : 0,
    fullFillRate: count ? fullFill.length / count : 0,
    partialFillRate: count ? records.filter((record) => record.filledQuantity > 0 && record.filledQuantity < record.requestedQuantity).length / count : 0,
    cancelRate: count ? records.filter((record) => record.canceled).length / count : 0,
    rejectionRate: count ? records.filter((record) => record.rejected).length / count : 0,
    ...(firstFill.length ? { averageTimeToFirstFillMs: mean(firstFill.map((record) => record.firstFillAt! - record.submittedAt)) } : {}),
    ...(fullFill.length ? { averageTimeToFullFillMs: mean(fullFill.map((record) => record.fullFillAt! - record.submittedAt)) } : {}),
    averageReplacements: count ? mean(records.map((record) => record.replacements)) : 0,
    ...(slippages.length ? { averageAdverseSlippage: mean(slippages) } : {}),
    ...(signalDelays.length ? { averageSignalToFillDelayMs: mean(signalDelays) } : {}),
    ...(signalPriceLosses.length ? { averageSignalToFillPriceLoss: mean(signalPriceLosses) } : {}),
    ...(spreadFractions.length ? { averageSpreadFractionPaid: mean(spreadFractions) } : {}),
  };
}

export function tradeMetric(trade: CompletedTrade): TradeMetric {
  const pnl = 100 * trade.quantity * (trade.exitPrice - trade.entryPrice) - trade.fees;
  const marks = trade.marks;
  return {
    pnl,
    returnOnPremium: pnl / (100 * trade.quantity * trade.entryPrice),
    holdingTimeMs: trade.exitTimestamp - trade.entryTimestamp,
    ...(marks && marks.length > 0 ? {
      mfe: 100 * trade.quantity * (Math.max(...marks) - trade.entryPrice),
      mae: 100 * trade.quantity * (Math.min(...marks) - trade.entryPrice),
    } : {}),
  };
}

export function maximumDrawdown(equityChanges: readonly number[], initialEquity = 0): { absolute: number; percentage?: number } {
  let equity = initialEquity;
  let peak = initialEquity;
  let maxAbsolute = 0;
  let maxPercentage = 0;
  let percentageDefined = initialEquity > 0;
  for (const change of equityChanges) {
    equity += change;
    peak = Math.max(peak, equity);
    const drawdown = peak - equity;
    maxAbsolute = Math.max(maxAbsolute, drawdown);
    if (peak > 0) {
      percentageDefined = true;
      maxPercentage = Math.max(maxPercentage, drawdown / peak);
    }
  }
  return { absolute: maxAbsolute, ...(percentageDefined ? { percentage: maxPercentage } : {}) };
}

export function computeStrategyMetrics(trades: readonly CompletedTrade[], initialEquity = 0): StrategyMetrics {
  const values = trades.map(tradeMetric);
  const pnls = values.map((value) => value.pnl);
  const wins = pnls.filter((pnl) => pnl > 0);
  const losses = pnls.filter((pnl) => pnl < 0);
  const grossProfit = sum(wins);
  const grossLoss = sum(losses);
  const daily = new Map<string, number>();
  for (let i = 0; i < trades.length; i += 1) daily.set(trades[i]!.sessionDate, (daily.get(trades[i]!.sessionDate) ?? 0) + pnls[i]!);
  const dailyReturns = [...daily.values()].map((pnl) => initialEquity > 0 ? pnl / initialEquity : pnl);
  const sharpe = annualizedSharpe(dailyReturns);
  const sortino = annualizedSortino(dailyReturns);
  const drawdown = maximumDrawdown(pnls, initialEquity);
  const averageWin = wins.length > 0 ? mean(wins) : undefined;
  const averageLoss = losses.length > 0 ? -mean(losses) : undefined;
  const totalEstimatedCost = sum(trades.map((trade) => trade.estimatedTradingCost ?? trade.fees));
  const grossEdge = sum(trades.map((trade) => Math.abs(100 * trade.quantity * (trade.exitPrice - trade.entryPrice))));
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    grossPnl: sum(trades.map((trade) => 100 * trade.quantity * (trade.exitPrice - trade.entryPrice))),
    netPnl: sum(pnls),
    ...(trades.length > 0 ? { winRate: wins.length / trades.length, expectancy: mean(pnls), averageHoldingTimeMs: mean(values.map((value) => value.holdingTimeMs)) } : {}),
    ...(averageWin !== undefined ? { averageWin } : {}),
    ...(averageLoss !== undefined ? { averageLoss } : {}),
    ...(averageWin !== undefined && averageLoss !== undefined ? { payoffRatio: averageWin / averageLoss } : {}),
    ...(losses.length > 0 ? { profitFactor: grossProfit / Math.abs(grossLoss) } : {}),
    maximumDrawdown: drawdown.absolute,
    ...(drawdown.percentage !== undefined ? { maximumDrawdownPct: drawdown.percentage } : {}),
    ...(sharpe !== undefined ? { sharpe } : {}),
    ...(sortino !== undefined ? { sortino } : {}),
    costRatio: totalEstimatedCost / (grossEdge + 1e-12),
  };
}

export function annualizedSharpe(dailyReturns: readonly number[], dailyRiskFreeRate = 0): number | undefined {
  if (dailyReturns.length < 2) return undefined;
  const excess = dailyReturns.map((value) => value - dailyRiskFreeRate);
  const deviation = sampleStdDev(excess);
  return deviation > 0 ? Math.sqrt(252) * mean(excess) / deviation : undefined;
}

export function annualizedSortino(dailyReturns: readonly number[], target = 0): number | undefined {
  if (dailyReturns.length === 0) return undefined;
  const downsideDeviation = Math.sqrt(mean(dailyReturns.map((value) => Math.min(0, value - target) ** 2)));
  return downsideDeviation > 0 ? Math.sqrt(252) * (mean(dailyReturns) - target) / downsideDeviation : undefined;
}

export interface PredictionMetrics {
  mae: number;
  rmse: number;
  directionalAccuracy?: number;
  informationCoefficient?: number;
}

export function predictionMetrics(projected: readonly number[], realized: readonly number[], deadZoneBps = 0): PredictionMetrics {
  if (projected.length !== realized.length || projected.length === 0) throw new Error("Prediction arrays must have equal nonzero length");
  const errors = projected.map((value, i) => realized[i]! - value);
  const directional = realized.map((value, i) => ({ value, predicted: projected[i]! }))
    .filter((item) => Math.abs(item.value) > deadZoneBps);
  const ic = correlation(projected, realized);
  return {
    mae: mean(errors.map(Math.abs)),
    rmse: Math.sqrt(mean(errors.map((value) => value ** 2))),
    ...(directional.length > 0 ? {
      directionalAccuracy: directional.filter((item) => Math.sign(item.value) === Math.sign(item.predicted)).length / directional.length,
    } : {}),
    ...(ic !== undefined ? { informationCoefficient: ic } : {}),
  };
}

export function futureReturnBps(currentMicroprice: number, futureMicroprice: number): number {
  return 10_000 * Math.log(futureMicroprice / currentMicroprice);
}

export function directionalLabel(returnBps: number, deadZoneBps: number): -1 | 0 | 1 {
  return returnBps > deadZoneBps ? 1 : returnBps < -deadZoneBps ? -1 : 0;
}

export function segmentTradeMetrics(
  trades: readonly CompletedTrade[], key: (trade: CompletedTrade) => string,
): Record<string, StrategyMetrics> {
  const groups = new Map<string, CompletedTrade[]>();
  for (const trade of trades) groups.set(key(trade), [...(groups.get(key(trade)) ?? []), trade]);
  return Object.fromEntries([...groups].map(([name, group]) => [name, computeStrategyMetrics(group)]));
}

export interface BootstrapInterval { lower: number; median: number; upper: number }
export interface BootstrapResult {
  expectancy: BootstrapInterval;
  maximumDrawdown: BootstrapInterval;
  profitFactor?: BootstrapInterval;
}

/** Complete-session bootstrap with injectable RNG for reproducibility. */
export function sessionBootstrap(
  trades: readonly CompletedTrade[], iterations = 1_000, random: () => number = Math.random,
): BootstrapResult | undefined {
  const grouped = new Map<string, CompletedTrade[]>();
  for (const trade of trades) grouped.set(trade.sessionDate, [...(grouped.get(trade.sessionDate) ?? []), trade]);
  const sessions = [...grouped.values()];
  if (sessions.length === 0 || iterations < 1) return undefined;
  const expectancy: number[] = [];
  const drawdown: number[] = [];
  const profitFactor: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampled: CompletedTrade[] = [];
    for (let i = 0; i < sessions.length; i += 1) sampled.push(...sessions[Math.min(sessions.length - 1, Math.floor(random() * sessions.length))]!);
    const metrics = computeStrategyMetrics(sampled);
    expectancy.push(metrics.expectancy ?? 0);
    drawdown.push(metrics.maximumDrawdown);
    if (metrics.profitFactor !== undefined && Number.isFinite(metrics.profitFactor)) profitFactor.push(metrics.profitFactor);
  }
  return {
    expectancy: percentileInterval(expectancy),
    maximumDrawdown: percentileInterval(drawdown),
    ...(profitFactor.length > 0 ? { profitFactor: percentileInterval(profitFactor) } : {}),
  };
}

function percentileInterval(values: readonly number[]): BootstrapInterval {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]!;
  return { lower: at(0.025), median: at(0.5), upper: at(0.975) };
}
