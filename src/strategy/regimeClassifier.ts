import type { EngineConfig } from "../config.js";
import type { FeatureSnapshot, RegimeDecision } from "../types.js";
import { clip } from "../utils/statistics.js";

export function classifyRegime(feature: FeatureSnapshot, config: EngineConfig["regimes"]): RegimeDecision {
  const medium = feature.medium.normalizedSlope;
  const slow = feature.slow.normalizedSlope;
  const efficiency = feature.efficiency60;
  const acceleration = feature.fast.normalizedAcceleration;
  const highRv = (feature.rvPercentile ?? -Infinity) >= config.highRvPercentile;
  const wideOpeningRange = (feature.openingRange.percentile ?? -Infinity) >= config.wideOpeningRangePercentile;

  if (feature.signChanges60 >= config.whipsawSignChanges60 &&
      (highRv || wideOpeningRange || efficiency <= config.chopEfficiency)) {
    return {
      regime: "HIGH_VOL_WHIPSAW",
      confidence: clip(0.55 + 0.05 * feature.signChanges60, 0, 1),
      reasons: [
        `sign changes ${feature.signChanges60} >= ${config.whipsawSignChanges60}`,
        highRv ? "high realized-volatility percentile" : wideOpeningRange ? "wide opening range" : "low efficiency",
      ],
    };
  }

  const trendConfidence = clip(0.25 + 0.30 * Math.abs(medium) + 0.25 * Math.abs(slow) + 0.40 * efficiency, 0, 1);
  const gap = feature.openingGapBps;
  if (gap !== undefined && gap >= config.gapAndGoMinBps && medium > 0 && slow > 0 && efficiency >= config.minimumTrendEfficiency) {
    return { regime: "GAP_AND_GO_UP", confidence: trendConfidence, reasons: ["positive opening gap with aligned trend"] };
  }
  if (gap !== undefined && gap <= -config.gapAndGoMinBps && medium < 0 && slow < 0 && efficiency >= config.minimumTrendEfficiency) {
    return { regime: "GAP_AND_GO_DOWN", confidence: trendConfidence, reasons: ["negative opening gap with aligned trend"] };
  }
  if (slow < -config.grindSlope120 && medium > config.grindSlope30 && acceleration > 0) {
    return { regime: "REVERSAL_UP", confidence: trendConfidence, reasons: ["medium slope reversed above negative slow state with positive acceleration"] };
  }
  if (slow > config.grindSlope120 && medium < -config.grindSlope30 && acceleration < 0) {
    return { regime: "REVERSAL_DOWN", confidence: trendConfidence, reasons: ["medium slope reversed below positive slow state with negative acceleration"] };
  }
  if (medium >= config.strongSlope30 && slow >= config.strongSlope120 && efficiency >= config.minimumTrendEfficiency) {
    return { regime: "STRONG_UP", confidence: trendConfidence, reasons: ["strong aligned positive medium/slow slopes"] };
  }
  if (medium <= -config.strongSlope30 && slow <= -config.strongSlope120 && efficiency >= config.minimumTrendEfficiency) {
    return { regime: "STRONG_DOWN", confidence: trendConfidence, reasons: ["strong aligned negative medium/slow slopes"] };
  }
  if (medium >= config.grindSlope30 && slow >= config.grindSlope120 && efficiency >= config.minimumTrendEfficiency) {
    return { regime: "GRIND_UP", confidence: trendConfidence, reasons: ["persistent aligned positive slopes"] };
  }
  if (medium <= -config.grindSlope30 && slow <= -config.grindSlope120 && efficiency >= config.minimumTrendEfficiency) {
    return { regime: "GRIND_DOWN", confidence: trendConfidence, reasons: ["persistent aligned negative slopes"] };
  }
  if (efficiency <= config.chopEfficiency ||
      (Math.abs(medium) < config.grindSlope30 && Math.abs(slow) < config.grindSlope120)) {
    return { regime: "CHOP_DOJI", confidence: clip(1 - efficiency, 0, 1), reasons: ["low efficiency or weak medium/slow slopes"] };
  }
  return { regime: "UNCLASSIFIED", confidence: 0, reasons: ["mixed state did not meet a versioned regime rule"] };
}
