import type { CalibrationBucket, CalibrationProfile, FeatureSnapshot, ThresholdProfile } from "../types.js";
import type { EngineConfig } from "../config.js";
import { fiveMinuteBucket } from "../utils/time.js";
import { quantileNearestRank } from "../utils/statistics.js";

export interface CalibrationObservation {
  timestamp: number;
  marketDate: string;
  fastSlopeMagnitude: number;
  fastAccelerationMagnitude: number;
  ofi5Magnitude: number;
  efficiency60: number;
  rv30: number;
  volume60: number;
}

export function buildCalibrationProfile(
  observations: readonly CalibrationObservation[],
  metadata: Omit<CalibrationProfile, "buckets">,
  timeZone = "America/New_York",
): CalibrationProfile {
  const grouped = new Map<string, CalibrationObservation[]>();
  for (const observation of observations) {
    if (observation.marketDate < metadata.trainingStartDate || observation.marketDate > metadata.trainingEndDate) continue;
    const key = fiveMinuteBucket(observation.timestamp, timeZone);
    const values = grouped.get(key) ?? [];
    values.push(observation);
    grouped.set(key, values);
  }
  const buckets: Record<string, CalibrationBucket> = {};
  for (const [key, values] of grouped) {
    const rv = values.map((value) => value.rv30);
    buckets[key] = {
      sampleCount: values.length,
      fastSlopeQ70: quantileNearestRank(values.map((value) => value.fastSlopeMagnitude), 0.70),
      fastAccelerationQ65: quantileNearestRank(values.map((value) => value.fastAccelerationMagnitude), 0.65),
      absoluteOfi5Q65: quantileNearestRank(values.map((value) => value.ofi5Magnitude), 0.65),
      efficiency60Q60: quantileNearestRank(values.map((value) => value.efficiency60), 0.60),
      rv30Quantiles: [0.2, 0.4, 0.6, 0.8, 0.9, 0.95].map((percentile) => ({
        percentile, value: quantileNearestRank(rv, percentile),
      })),
      volume60Q60: quantileNearestRank(values.map((value) => value.volume60), 0.60),
      volume60Median: quantileNearestRank(values.map((value) => value.volume60), 0.50),
    };
  }
  return { ...metadata, buckets };
}

export class CalibrationResolver {
  readonly #config: EngineConfig;
  readonly #profile: CalibrationProfile | undefined;
  constructor(config: EngineConfig, profile?: CalibrationProfile) {
    this.#config = config;
    this.#profile = profile;
  }

  thresholds(timestamp: number, currentMarketDate: string): ThresholdProfile {
    const key = fiveMinuteBucket(timestamp, this.#config.timeZone);
    const bucket = this.#profile?.buckets[key];
    // Strictly historical only, with the required minimum of 30 observations.
    if (this.#profile && this.#profile.trainingEndDate < currentMarketDate && bucket && bucket.sampleCount >= 30) {
      const highRv30 = rvValueAtPercentile(bucket, 0.8);
      return {
        source: "calibrated", bucket: key, sampleCount: bucket.sampleCount,
        fastSlope: bucket.fastSlopeQ70,
        fastAcceleration: bucket.fastAccelerationQ65,
        absoluteOfi5: bucket.absoluteOfi5Q65,
        efficiency60: bucket.efficiency60Q60,
        ...(highRv30 !== undefined ? { highRv30 } : {}),
        volume60: bucket.volume60Q60,
        volume60Median: bucket.volume60Median ?? bucket.volume60Q60,
      };
    }
    return {
      source: "static", bucket: key, sampleCount: bucket?.sampleCount ?? 0,
      fastSlope: this.#config.signals.impulseFastSlopeScore,
      fastAcceleration: this.#config.signals.impulseAccelerationScore,
      absoluteOfi5: this.#config.signals.impulseOfi5,
      efficiency60: this.#config.signals.minEfficiency60,
    };
  }

  rvPercentile(timestamp: number, currentMarketDate: string, rv30: number): number | undefined {
    if (!this.#profile || this.#profile.trainingEndDate >= currentMarketDate) return undefined;
    const bucket = this.#profile.buckets[fiveMinuteBucket(timestamp, this.#config.timeZone)];
    if (!bucket || bucket.sampleCount < 30 || bucket.rv30Quantiles.length === 0) return undefined;
    const points = [...bucket.rv30Quantiles].sort((a, b) => a.value - b.value);
    if (rv30 <= points[0]!.value) return points[0]!.percentile * Math.max(0, rv30 / Math.max(points[0]!.value, 1e-12));
    if (rv30 >= points.at(-1)!.value) return points.at(-1)!.percentile;
    for (let i = 1; i < points.length; i += 1) {
      const low = points[i - 1]!;
      const high = points[i]!;
      if (rv30 <= high.value) {
        return low.percentile + (rv30 - low.value) / (high.value - low.value + 1e-12) * (high.percentile - low.percentile);
      }
    }
    return undefined;
  }
}

function rvValueAtPercentile(bucket: CalibrationBucket, percentile: number): number | undefined {
  return bucket.rv30Quantiles.find((item) => item.percentile === percentile)?.value;
}

export function calibrationObservationFromFeature(feature: FeatureSnapshot): CalibrationObservation {
  return {
    timestamp: feature.timestamp,
    marketDate: feature.marketDate,
    fastSlopeMagnitude: Math.abs(feature.fast.normalizedSlope),
    fastAccelerationMagnitude: Math.abs(feature.fast.normalizedAcceleration),
    ofi5Magnitude: Math.abs(feature.ofi5),
    efficiency60: feature.efficiency60,
    rv30: feature.medium.realizedVolatilityBps,
    volume60: feature.volume60,
  };
}
