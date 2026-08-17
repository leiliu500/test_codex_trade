import { performance } from "node:perf_hooks";
import type { OptionQuote } from "../types.js";

export type OpraQuoteDiagnosis =
  | "NO_DATA"
  | "TRANSPORT_DISCONNECTED"
  | "HEALTHY"
  | "CONTRACT_IDLE"
  | "OLD_EVENT_ARRIVED"
  | "PROVIDER_DELAYED";

export interface OpraQuoteObservation {
  quote: OptionQuote;
  receiveWallTimestamp: number;
  receiveMonotonicTimestamp: number;
  websocketConnectionId?: number;
  subscriptionSymbols?: readonly string[];
}

interface StoredQuoteObservation {
  providerTimestamp: number;
  receiveWallTimestamp: number;
  receiveMonotonicTimestamp: number;
  arrivalLagMs: number;
  fingerprint: string;
}

export interface OpraQuoteHealth {
  diagnosis: OpraQuoteDiagnosis;
  transportAgeMs: number;
  symbolReceiveAgeMs: number;
  latestProviderAgeMs: number;
  sampleCount: number;
  medianArrivalLagMs?: number;
  medianAbsoluteDeviationMs?: number;
  providerAdvanceRatio?: number;
  providerTimeVelocity?: number;
  lagSlope?: number;
  entryEligible: boolean;
}

export interface OpraChainHealth {
  diagnosis: OpraQuoteDiagnosis;
  transportAgeMs: number;
  exactSymbolReceiveAgeMs?: number;
  latestProviderAgeMs?: number;
  symbolCount: number;
  observedSymbolCount: number;
  activeSymbolCount: number;
  freshSymbolCount: number;
  diagnosableSymbolCount: number;
  delayedSymbolCount: number;
  delayedSymbolFraction: number;
  freshSymbolFraction: number;
  medianArrivalLagMs?: number;
  medianAbsoluteDeviationMs?: number;
  providerAdvanceRatio?: number;
  providerTimeVelocity?: number;
  entryEligible: boolean;
}

export interface OpraQuoteHealthMonitorOptions {
  executionMaxQuoteAgeMs?: number;
  transportTimeoutMs?: number;
  diagnosticWindowMs?: number;
  minimumDelaySamples?: number;
  minimumDelayedSymbols?: number;
  delayedSymbolFraction?: number;
  minimumProviderAdvanceRatio?: number;
  clockOffsetMs?: number;
  maximumHistoryPerSymbol?: number;
}

const finiteMinimum = (values: readonly number[]): number | undefined => {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.min(...finite) : undefined;
};

export function parseRfc3339ToMs(timestamp: string): number {
  const normalized = timestamp.replace(/\.(\d{3})\d*(Z|[+-]\d{2}:\d{2})$/, ".$1$2");
  const result = Date.parse(normalized);
  if (!Number.isFinite(result)) throw new Error(`Invalid RFC-3339 timestamp: ${timestamp}`);
  return result;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

export function medianAbsoluteDeviation(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

export function optionQuoteFingerprint(quote: OptionQuote): string {
  return [
    quote.symbol,
    quote.timestamp,
    quote.bidPrice,
    quote.askPrice,
    quote.bidSize,
    quote.askSize,
    quote.bidExchange ?? "",
    quote.askExchange ?? "",
    quote.conditions?.join(",") ?? "",
  ].join("|");
}

export interface RestQuoteAssessment {
  providerAgeMs: number;
  fresh: boolean;
  fingerprint: string;
}

export function assessRestQuote(
  quote: OptionQuote,
  observedAtMs = Date.now(),
  maximumAgeMs = 2_000,
  clockOffsetMs = 0,
): RestQuoteAssessment {
  const providerAgeMs = observedAtMs - quote.timestamp - clockOffsetMs;
  return {
    providerAgeMs,
    fresh: providerAgeMs >= 0 && providerAgeMs <= maximumAgeMs,
    fingerprint: optionQuoteFingerprint(quote),
  };
}

/** Tracks provider-event time independently from transport and exact-symbol activity. */
export class OpraQuoteHealthMonitor {
  readonly #history = new Map<string, StoredQuoteObservation[]>();
  readonly #executionMaxQuoteAgeMs: number;
  readonly #transportTimeoutMs: number;
  readonly #diagnosticWindowMs: number;
  readonly #minimumDelaySamples: number;
  readonly #minimumDelayedSymbols: number;
  readonly #delayedSymbolFraction: number;
  readonly #minimumProviderAdvanceRatio: number;
  readonly #clockOffsetMs: number;
  readonly #maximumHistoryPerSymbol: number;
  #lastAnyFrameMonotonicTimestamp = Number.NEGATIVE_INFINITY;

  constructor(options: OpraQuoteHealthMonitorOptions = {}) {
    this.#executionMaxQuoteAgeMs = options.executionMaxQuoteAgeMs ?? 2_000;
    this.#transportTimeoutMs = options.transportTimeoutMs ?? 10_000;
    this.#diagnosticWindowMs = options.diagnosticWindowMs ?? 5_000;
    this.#minimumDelaySamples = options.minimumDelaySamples ?? 4;
    this.#minimumDelayedSymbols = options.minimumDelayedSymbols ?? 5;
    this.#delayedSymbolFraction = options.delayedSymbolFraction ?? 0.60;
    this.#minimumProviderAdvanceRatio = options.minimumProviderAdvanceRatio ?? 0.70;
    this.#clockOffsetMs = options.clockOffsetMs ?? 0;
    this.#maximumHistoryPerSymbol = options.maximumHistoryPerSymbol ?? 256;
  }

  onAnyFrame(receiveMonotonicTimestamp = performance.now()): void {
    this.#lastAnyFrameMonotonicTimestamp = Math.max(
      this.#lastAnyFrameMonotonicTimestamp,
      receiveMonotonicTimestamp,
    );
  }

  onWebSocketQuote(observation: OpraQuoteObservation): void {
    const { quote, receiveWallTimestamp, receiveMonotonicTimestamp } = observation;
    this.onAnyFrame(receiveMonotonicTimestamp);
    const observations = this.#history.get(quote.symbol) ?? [];
    observations.push({
      providerTimestamp: quote.timestamp,
      receiveWallTimestamp,
      receiveMonotonicTimestamp,
      arrivalLagMs: receiveWallTimestamp - quote.timestamp - this.#clockOffsetMs,
      fingerprint: optionQuoteFingerprint(quote),
    });
    if (observations.length > this.#maximumHistoryPerSymbol) {
      observations.splice(0, observations.length - this.#maximumHistoryPerSymbol);
    }
    this.#history.set(quote.symbol, observations);
  }

  reset(receiveMonotonicTimestamp = performance.now()): void {
    this.#history.clear();
    this.#lastAnyFrameMonotonicTimestamp = receiveMonotonicTimestamp;
  }

  retainSymbols(symbols: ReadonlySet<string>): void {
    for (const symbol of this.#history.keys()) {
      if (!symbols.has(symbol)) this.#history.delete(symbol);
    }
  }

  diagnose(
    symbol: string,
    nowWallTimestamp = Date.now(),
    nowMonotonicTimestamp = performance.now(),
  ): OpraQuoteHealth {
    const transportAgeMs = Math.max(
      0,
      nowMonotonicTimestamp - this.#lastAnyFrameMonotonicTimestamp,
    );
    const observations = this.#history.get(symbol) ?? [];
    if (observations.length === 0) {
      return {
        diagnosis: transportAgeMs > this.#transportTimeoutMs ? "TRANSPORT_DISCONNECTED" : "NO_DATA",
        transportAgeMs,
        symbolReceiveAgeMs: Number.POSITIVE_INFINITY,
        latestProviderAgeMs: Number.POSITIVE_INFINITY,
        sampleCount: 0,
        entryEligible: false,
      };
    }

    const latest = observations.at(-1)!;
    const symbolReceiveAgeMs = Math.max(0, nowMonotonicTimestamp - latest.receiveMonotonicTimestamp);
    const latestProviderAgeMs = nowWallTimestamp - latest.providerTimestamp - this.#clockOffsetMs;
    if (transportAgeMs > this.#transportTimeoutMs) {
      return {
        diagnosis: "TRANSPORT_DISCONNECTED",
        transportAgeMs,
        symbolReceiveAgeMs,
        latestProviderAgeMs,
        sampleCount: observations.length,
        entryEligible: false,
      };
    }

    const recent = observations.filter((sample) =>
      nowMonotonicTimestamp - sample.receiveMonotonicTimestamp <= this.#diagnosticWindowMs);
    const lags = recent.map((sample) => sample.arrivalLagMs);
    const medianArrivalLagMs = median(lags);
    const mad = medianAbsoluteDeviation(lags);
    let advancingPairs = 0;
    for (let index = 1; index < recent.length; index += 1) {
      if (recent[index]!.providerTimestamp > recent[index - 1]!.providerTimestamp) advancingPairs += 1;
    }
    const comparablePairs = Math.max(0, recent.length - 1);
    const providerAdvanceRatio = comparablePairs === 0 ? 0 : advancingPairs / comparablePairs;
    const first = recent[0];
    const last = recent.at(-1);
    const receiveSpanMs = first && last ? last.receiveWallTimestamp - first.receiveWallTimestamp : 0;
    const providerTimeVelocity = receiveSpanMs > 0 && first && last
      ? (last.providerTimestamp - first.providerTimestamp) / receiveSpanMs
      : undefined;
    const lagSlope = receiveSpanMs > 0 ? leastSquaresSlope(recent) : undefined;
    const diagnostics = {
      medianArrivalLagMs,
      medianAbsoluteDeviationMs: mad,
      providerAdvanceRatio,
      ...(providerTimeVelocity !== undefined ? { providerTimeVelocity } : {}),
      ...(lagSlope !== undefined ? { lagSlope } : {}),
    };
    const providerDelayed = recent.length >= this.#minimumDelaySamples &&
      providerAdvanceRatio >= this.#minimumProviderAdvanceRatio &&
      medianArrivalLagMs > this.#executionMaxQuoteAgeMs &&
      symbolReceiveAgeMs <= this.#executionMaxQuoteAgeMs;

    if (providerDelayed) {
      return {
        diagnosis: "PROVIDER_DELAYED", transportAgeMs, symbolReceiveAgeMs, latestProviderAgeMs,
        sampleCount: recent.length, ...diagnostics, entryEligible: false,
      };
    }
    if (symbolReceiveAgeMs > this.#executionMaxQuoteAgeMs) {
      return {
        diagnosis: "CONTRACT_IDLE", transportAgeMs, symbolReceiveAgeMs, latestProviderAgeMs,
        sampleCount: recent.length, ...diagnostics, entryEligible: false,
      };
    }
    if (latestProviderAgeMs < 0 || latestProviderAgeMs > this.#executionMaxQuoteAgeMs) {
      return {
        diagnosis: "OLD_EVENT_ARRIVED", transportAgeMs, symbolReceiveAgeMs, latestProviderAgeMs,
        sampleCount: recent.length, ...diagnostics, entryEligible: false,
      };
    }
    return {
      diagnosis: "HEALTHY", transportAgeMs, symbolReceiveAgeMs, latestProviderAgeMs,
      sampleCount: recent.length, ...diagnostics, entryEligible: true,
    };
  }

  summarize(
    symbols: ReadonlySet<string>,
    nowWallTimestamp = Date.now(),
    nowMonotonicTimestamp = performance.now(),
  ): OpraChainHealth {
    const health = [...symbols].map((symbol) => this.diagnose(symbol, nowWallTimestamp, nowMonotonicTimestamp));
    const transportAgeMs = health[0]?.transportAgeMs ?? Math.max(
      0,
      nowMonotonicTimestamp - this.#lastAnyFrameMonotonicTimestamp,
    );
    const observed = health.filter((item) => item.sampleCount > 0);
    const active = observed.filter((item) => item.symbolReceiveAgeMs <= this.#executionMaxQuoteAgeMs);
    const fresh = health.filter((item) => item.diagnosis === "HEALTHY");
    const diagnosable = active.filter((item) => item.sampleCount >= this.#minimumDelaySamples);
    const delayed = diagnosable.filter((item) => item.diagnosis === "PROVIDER_DELAYED");
    const delayedSymbolFraction = diagnosable.length === 0 ? 0 : delayed.length / diagnosable.length;
    const providerDelayed = diagnosable.length >= this.#minimumDelayedSymbols &&
      delayedSymbolFraction >= this.#delayedSymbolFraction;
    const transportDisconnected = transportAgeMs > this.#transportTimeoutMs;
    const diagnosis: OpraQuoteDiagnosis = transportDisconnected
      ? "TRANSPORT_DISCONNECTED"
      : symbols.size === 0 || observed.length === 0
      ? "NO_DATA"
      : providerDelayed
      ? "PROVIDER_DELAYED"
      : fresh.length > 0
      ? "HEALTHY"
      : active.some((item) => item.diagnosis === "OLD_EVENT_ARRIVED" || item.diagnosis === "PROVIDER_DELAYED")
      ? "OLD_EVENT_ARRIVED"
      : "CONTRACT_IDLE";
    const medians = active.flatMap((item) => item.medianArrivalLagMs === undefined ? [] : [item.medianArrivalLagMs]);
    const mads = active.flatMap((item) =>
      item.medianAbsoluteDeviationMs === undefined ? [] : [item.medianAbsoluteDeviationMs]);
    const advanceRatios = diagnosable.flatMap((item) =>
      item.providerAdvanceRatio === undefined ? [] : [item.providerAdvanceRatio]);
    const velocities = diagnosable.flatMap((item) =>
      item.providerTimeVelocity === undefined ? [] : [item.providerTimeVelocity]);
    const exactSymbolReceiveAgeMs = finiteMinimum(observed.map((item) => item.symbolReceiveAgeMs));
    const latestProviderAgeMs = finiteMinimum(observed.map((item) => item.latestProviderAgeMs));
    return {
      diagnosis,
      transportAgeMs,
      ...(exactSymbolReceiveAgeMs !== undefined
        ? { exactSymbolReceiveAgeMs }
        : {}),
      ...(latestProviderAgeMs !== undefined
        ? { latestProviderAgeMs }
        : {}),
      symbolCount: symbols.size,
      observedSymbolCount: observed.length,
      activeSymbolCount: active.length,
      freshSymbolCount: fresh.length,
      diagnosableSymbolCount: diagnosable.length,
      delayedSymbolCount: delayed.length,
      delayedSymbolFraction,
      freshSymbolFraction: symbols.size === 0 ? 0 : fresh.length / symbols.size,
      ...(medians.length > 0 ? { medianArrivalLagMs: median(medians) } : {}),
      ...(mads.length > 0 ? { medianAbsoluteDeviationMs: median(mads) } : {}),
      ...(advanceRatios.length > 0 ? { providerAdvanceRatio: median(advanceRatios) } : {}),
      ...(velocities.length > 0 ? { providerTimeVelocity: median(velocities) } : {}),
      entryEligible: diagnosis === "HEALTHY" && fresh.length > 0,
    };
  }
}

function leastSquaresSlope(observations: readonly StoredQuoteObservation[]): number | undefined {
  if (observations.length < 2) return undefined;
  const origin = observations[0]!.receiveWallTimestamp;
  const times = observations.map((sample) => sample.receiveWallTimestamp - origin);
  const lags = observations.map((sample) => sample.arrivalLagMs);
  const meanTime = times.reduce((sum, value) => sum + value, 0) / times.length;
  const meanLag = lags.reduce((sum, value) => sum + value, 0) / lags.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < observations.length; index += 1) {
    const centeredTime = times[index]! - meanTime;
    numerator += centeredTime * (lags[index]! - meanLag);
    denominator += centeredTime * centeredTime;
  }
  return denominator > 0 ? numerator / denominator : undefined;
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface StaleQuoteCircuitBreakerOptions {
  failureThreshold?: number;
  initialCooldownMs?: number;
  maximumCooldownMs?: number;
}

export interface CircuitBreakerSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  cooldownMs: number;
  retryAfterMs: number;
}

/** Stops same-provider REST request storms while allowing bounded recovery probes. */
export class StaleQuoteCircuitBreaker {
  readonly #failureThreshold: number;
  readonly #initialCooldownMs: number;
  readonly #maximumCooldownMs: number;
  #state: CircuitState = "CLOSED";
  #consecutiveFailures = 0;
  #openedAtMonotonicTimestamp = Number.NEGATIVE_INFINITY;
  #cooldownMs: number;
  #openCount = 0;

  constructor(options: StaleQuoteCircuitBreakerOptions = {}) {
    this.#failureThreshold = options.failureThreshold ?? 3;
    this.#initialCooldownMs = options.initialCooldownMs ?? 15_000;
    this.#maximumCooldownMs = options.maximumCooldownMs ?? 30_000;
    this.#cooldownMs = this.#initialCooldownMs;
  }

  canRequest(nowMonotonicTimestamp = performance.now()): boolean {
    if (this.#state === "CLOSED") return true;
    if (this.#state === "OPEN" &&
        nowMonotonicTimestamp - this.#openedAtMonotonicTimestamp >= this.#cooldownMs) {
      this.#state = "HALF_OPEN";
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.#state = "CLOSED";
    this.#consecutiveFailures = 0;
    this.#openCount = 0;
    this.#cooldownMs = this.#initialCooldownMs;
  }

  recordStaleOrRepeated(nowMonotonicTimestamp = performance.now()): void {
    this.#consecutiveFailures += 1;
    if (this.#state === "HALF_OPEN" || this.#consecutiveFailures >= this.#failureThreshold) {
      this.#open(nowMonotonicTimestamp);
    }
  }

  trip(nowMonotonicTimestamp = performance.now()): void {
    this.#consecutiveFailures = Math.max(this.#consecutiveFailures, this.#failureThreshold);
    if (this.#state !== "OPEN") this.#open(nowMonotonicTimestamp);
  }

  snapshot(nowMonotonicTimestamp = performance.now()): CircuitBreakerSnapshot {
    return {
      state: this.#state,
      consecutiveFailures: this.#consecutiveFailures,
      cooldownMs: this.#cooldownMs,
      retryAfterMs: this.#state === "OPEN"
        ? Math.max(0, this.#cooldownMs - (nowMonotonicTimestamp - this.#openedAtMonotonicTimestamp))
        : 0,
    };
  }

  #open(nowMonotonicTimestamp: number): void {
    this.#openCount += 1;
    this.#cooldownMs = Math.min(
      this.#maximumCooldownMs,
      this.#initialCooldownMs * (2 ** Math.max(0, this.#openCount - 1)),
    );
    this.#state = "OPEN";
    this.#openedAtMonotonicTimestamp = nowMonotonicTimestamp;
  }
}
