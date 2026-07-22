export type Direction = "BULLISH" | "BEARISH";
export type SignalKind = "IMPULSE" | "GRIND";
export type OptionType = "call" | "put";

export interface StockQuote {
  symbol: "SPY";
  timestamp: number;
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
  bidExchange?: string;
  askExchange?: string;
  conditions?: string[];
}

export interface StockTrade {
  symbol: "SPY";
  timestamp: number;
  price: number;
  size: number;
  exchange?: string;
  conditions?: string[];
}

export interface OptionQuote {
  symbol: string;
  timestamp: number;
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
}

export interface OptionSnapshot {
  symbol: string;
  timestamp?: number;
  impliedVolatility?: number;
  greeks?: {
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
  };
  dailyVolume?: number;
  openInterest?: number;
}

export interface OptionContract {
  symbol: string;
  underlying: "SPY";
  expirationDate: string;
  strike: number;
  type: OptionType;
  tradable: boolean;
  active: boolean;
  openInterest?: number;
}

export interface SecondBar {
  timestamp: number;
  microprice?: number;
  mid?: number;
  quoteImbalance?: number;
  micropriceDisplacementBps?: number;
  bidPrice?: number;
  askPrice?: number;
  bidSize?: number;
  askSize?: number;
  quoteCount: number;
  quoteAgeMs: number;
  ofiRaw: number;
  depthSum: number;
  depthEventCount: number;
  tradeVolume: number;
  tradeVwap?: number;
}

export interface RegressionResult {
  valid: boolean;
  reason?: string;
  windowSec: number;
  pointCount: number;
  coverageFraction: number;
  levelLog?: number;
  slopeBpsPerSec?: number;
  accelerationBpsPerSec2?: number;
  r2?: number;
  residualMad?: number;
  slopeStdErrorBpsPerSec?: number;
  slopeZScore?: number;
  coefficients?: [number, number, number];
}

export interface WindowMetrics {
  windowSec: number;
  regression: RegressionResult;
  realizedVolatilityBps: number;
  efficiencyRatio: number;
  noiseFloorBps: number;
  normalizedSlope: number;
  normalizedAcceleration: number;
  signChanges: number;
}

export interface VwapState {
  sessionVwap?: number;
  rollingVwap?: number;
  rollingVwapSlopeBpsPerSec?: number;
  anchoredVwaps: Record<string, number>;
  sessionDistanceBps?: number;
}

export interface OpeningRangeState {
  complete: boolean;
  high?: number;
  low?: number;
  midpoint?: number;
  widthBps?: number;
  percentile?: number;
  bullishBreakoutTimestamp?: number;
  bearishBreakoutTimestamp?: number;
  nearHigh: boolean;
  nearLow: boolean;
  bullishRetest: boolean;
  bearishRetest: boolean;
}

export interface ThresholdProfile {
  source: "static" | "calibrated";
  bucket: string;
  sampleCount: number;
  fastSlope: number;
  fastAcceleration: number;
  absoluteOfi5: number;
  efficiency60: number;
  highRv30?: number;
  volume60?: number;
  volume60Median?: number;
}

export interface FeatureSnapshot {
  symbol: "SPY";
  timestamp: number;
  marketDate: string;
  price: number;
  mid: number;
  spreadBps: number;
  quoteAgeMs: number;
  quoteImbalance: number;
  quoteImbalanceEwma5: number;
  quoteImbalanceEwma15: number;
  micropriceDisplacementBps: number;
  ofi1: number;
  ofi5: number;
  ofi15: number;
  volume60: number;
  relativeVolume60?: number;
  fast: WindowMetrics;
  medium: WindowMetrics;
  slow: WindowMetrics;
  efficiency60: number;
  signChanges60: number;
  vwap: VwapState;
  openingRange: OpeningRangeState;
  openingGapBps?: number;
  rvPercentile?: number;
  thresholds: ThresholdProfile;
  dataValid: boolean;
  invalidReasons: string[];
}

export type Regime =
  | "HIGH_VOL_WHIPSAW"
  | "GAP_AND_GO_UP"
  | "GAP_AND_GO_DOWN"
  | "REVERSAL_UP"
  | "REVERSAL_DOWN"
  | "STRONG_UP"
  | "STRONG_DOWN"
  | "GRIND_UP"
  | "GRIND_DOWN"
  | "CHOP_DOJI"
  | "UNCLASSIFIED";

export interface RegimeDecision {
  regime: Regime;
  confidence: number;
  reasons: string[];
}

export interface SignalVote {
  name: "FAST_SLOPE" | "FAST_ACCELERATION" | "OFI_5" | "MICROPRICE_DISPLACEMENT";
  passed: boolean;
  value: number;
  threshold: number;
}

export interface TradeSignal {
  id: string;
  timestamp: number;
  direction: Direction;
  kind: SignalKind;
  regime: Regime;
  projectedMoveBps: number;
  votes: SignalVote[];
  reasons: string[];
  featureSnapshot: FeatureSnapshot;
}

export interface OptionCandidateEvaluation {
  symbol: string;
  contract?: OptionContract;
  delta?: number;
  gamma?: number;
  impliedVolatility?: number;
  mid?: number;
  spreadPct?: number;
  roundTripCostPerShare?: number;
  equivalentUnderlyingCostBps?: number;
  requiredMoveBps?: number;
  costMarginBps?: number;
  gammaAwareProjectedOptionMove?: number;
  score?: number;
  eligible: boolean;
  rejectionReasons: string[];
}

export interface AccountState {
  equity: number;
  optionBuyingPower: number;
  active: boolean;
  optionsApproved: boolean;
  killSwitch: boolean;
}

export interface RiskDecision {
  allowed: boolean;
  quantity: number;
  maxLossPerContract: number;
  stopPrice: number;
  targetPrice: number;
  reasons: string[];
}

export interface PositionState {
  symbol: string;
  direction: Direction;
  quantity: number;
  averageEntryPrice: number;
  entryTimestamp: number;
  stopPrice: number;
  targetPrice: number;
  highWaterMark: number;
  invalidSince?: number;
}

export type ExitReason =
  | "KILL_SWITCH"
  | "FORCED_SESSION_EXIT"
  | "STALE_DATA"
  | "HARD_STOP"
  | "PROFIT_TARGET"
  | "TRAILING_STOP"
  | "MAX_HOLD"
  | "OPPOSITE_REGIME"
  | "TREND_INVALIDATION";

export interface ExitDecision {
  exit: boolean;
  reason?: ExitReason;
  markPrice?: number;
  liquidationPrice?: number;
  updatedPosition: PositionState;
}

export interface CalibrationBucket {
  sampleCount: number;
  fastSlopeQ70: number;
  fastAccelerationQ65: number;
  absoluteOfi5Q65: number;
  efficiency60Q60: number;
  rv30Quantiles: Array<{ percentile: number; value: number }>;
  volume60Q60: number;
  volume60Median?: number;
}

export interface CalibrationProfile {
  version: string;
  trainingStartDate: string;
  trainingEndDate: string;
  sourceDataVersion: string;
  parameterHash: string;
  buckets: Record<string, CalibrationBucket>;
  openingRangeWidthsBps?: number[];
}

export type ReplayEvent =
  | { type: "stock_quote"; timestamp: number; data: StockQuote }
  | { type: "stock_trade"; timestamp: number; data: StockTrade }
  | { type: "option_contract"; timestamp: number; data: OptionContract }
  | { type: "option_quote"; timestamp: number; data: OptionQuote }
  | { type: "option_snapshot"; timestamp: number; data: OptionSnapshot }
  | { type: "prior_close"; timestamp: number; data: { symbol: "SPY"; close: number } };
