export type Direction = "BULLISH" | "BEARISH";
export type SignalKind = "IMPULSE" | "GRIND";
export type OptionType = "call" | "put";
export type UnderlyingSymbol = "SPY" | "QQQ";

export interface StockQuote {
  symbol: UnderlyingSymbol;
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
  symbol: UnderlyingSymbol;
  timestamp: number;
  price: number;
  size: number;
  exchange?: string;
  conditions?: string[];
}

export interface OptionQuote {
  symbol: string;
  /** Provider event time. Never replace this with local receive time. */
  timestamp: number;
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
  bidExchange?: string;
  askExchange?: string;
  conditions?: string[];
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
  underlying: UnderlyingSymbol;
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
  symbol: UnderlyingSymbol;
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
  reasons: string[];
}

export interface PositionState {
  symbol: string;
  direction: Direction;
  quantity: number;
  averageEntryPrice: number;
  entryTimestamp: number;
  stopPrice: number;
  underlyingEntryPrice?: number;
  invalidSince?: number;
  /** First distinct feature timestamp in the current opposite-regime run. */
  oppositeRegimeSince?: number;
  /** Distinct feature observations in the current opposite-regime run. */
  oppositeRegimeObservationCount?: number;
  /** Prevents repeated option ticks from counting one feature more than once. */
  lastOppositeRegimeFeatureTimestamp?: number;
  /** Broker-confirmed trade state. Order submission never changes quantity. */
  tradeState:
    | "OPEN_UNPROTECTED"
    | "PROTECTED_SOFT"
    | "PROTECTED_WINNER"
    | "PROTECTED_RECOVERED";
  /** Conservative, bid-based liquidation P&L after modeled execution error. */
  executablePnl: number;
  highWaterPnl: number;
  lowWaterPnl: number;
  protectedFloorPnl?: number;
  lastPnlTimestamp: number;
  lastHighTimestamp: number;
  previousExecutablePnl: number;
  pnlEwmaDriftPerSec: number;
  pnlEwmaVariancePerSec: number;
  reversalCusum: number;
  lastReversalFeatureTimestamp?: number;
  zeroCrossings: number;
  previousPnlSign: -1 | 0 | 1;
  /** Observation count at the first executable soft-activation touch. */
  softProtectionCandidateObservationCount?: number;
  softProtectionActivatedAt?: number;
  /** Resettable confirmation state for a microstructure-sized soft-floor breach. */
  softFloorBreachStartedAt?: number;
  softFloorBreachCandidateObservationCount?: number;
  protectionActivatedAt?: number;
  pnlObservationCount: number;
  estimatedRecoveryProbability?: number;
  recoveryProbabilityInvalidSince?: number;
  entryImpliedVolatility?: number;
  lastImpliedVolatility?: number;
  lastOptionSnapshotTimestamp?: number;
  lastUnderlyingPrice?: number;
  lastUnderlyingTimestamp?: number;
  optionContinuationLcbDollars?: number;
  optionContinuationInvalidSince?: number;
  optionContinuation?: {
    deltaDollars: number;
    gammaDollars: number;
    vegaDollars: number;
    thetaDollars: number;
    holdingCostDollars: number;
    uncertaintyDollars: number;
    expectedChangeDollars: number;
    lcbDollars: number;
    ivCrushDetected: boolean;
    /** Modeled estimates remain diagnostic until fresh provider Greeks are present. */
    providerGreeksAvailable: boolean;
  };
}

export type ExitReason =
  | "KILL_SWITCH"
  | "FORCED_SESSION_EXIT"
  | "STALE_DATA"
  | "HARD_STOP"
  | "PROFIT_FLOOR_EXIT"
  | "MAX_HOLD"
  | "OPPOSITE_REGIME"
  | "TREND_INVALIDATION"
  | "RECOVERY_TIMEOUT"
  | "RECOVERY_PROBABILITY_TOO_LOW"
  | "CONTINUATION_LCB_NON_POSITIVE"
  | "REVERSAL_CUSUM"
  | "STALL_OR_OPPORTUNITY_COST"
  | "DAILY_RISK_SHUTDOWN"
  | "BROKER_OR_POSITION_RISK"
  | "GREEKS_CONTINUATION_LCB_NON_POSITIVE";

export type ExitTrigger =
  | "BROKER_OR_POSITION_RISK"
  | "FORCED_TIME_EXIT"
  | "HARD_LOSS_BOUNDARY"
  | "STRUCTURAL_INVALIDATION"
  | "PROFIT_FLOOR_BREACH"
  | "REVERSAL_CUSUM"
  | "RECOVERY_PROBABILITY_TOO_LOW"
  | "CONTINUATION_LCB_NON_POSITIVE"
  | "STALL_OR_OPPORTUNITY_COST"
  | "DAILY_RISK_SHUTDOWN";

export interface ExitDecision {
  exit: boolean;
  reason?: ExitReason;
  triggers?: ExitTrigger[];
  markPrice?: number;
  liquidationPrice?: number;
  executablePnl?: number;
  protectedFloorPnl?: number;
  recoveryProbability?: number;
  continuationLcbDollars?: number;
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
  | { type: "prior_close"; timestamp: number; data: { symbol: UnderlyingSymbol; close: number } };
