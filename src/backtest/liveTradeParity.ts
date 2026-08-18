import type { EngineConfig } from "../config.js";
import type {
  ExitReason, ExitTrigger, FeatureSnapshot, OptionQuote, OptionSnapshot, PositionState,
  RegimeDecision,
} from "../types.js";
import { validateOptionQuote } from "../features/quoteSanitizer.js";
import { OptionBook } from "../options/optionBook.js";
import { ExitManager } from "../risk/exitManager.js";
import { classifyRegime } from "../strategy/regimeClassifier.js";
import { OrderExecutor } from "../execution/orderExecutor.js";

export type LiveManagementEvent =
  | {
      sequence: number;
      type: "feature_snapshot";
      receivedTimestamp: number;
      providerTimestamp: number;
      data: FeatureSnapshot;
    }
  | {
      sequence: number;
      type: "option_quote";
      receivedTimestamp: number;
      providerTimestamp: number;
      data: OptionQuote;
    }
  | {
      sequence: number;
      type: "option_snapshot";
      receivedTimestamp: number;
      providerTimestamp: number;
      data: OptionSnapshot;
    };

export interface ObservedLiveExit {
  decisionTimestamp: number;
  fillTimestamp: number;
  fillPrice: number;
  realizedPnl: number;
  reason: string;
  submittedLimitPrice: number;
  decisionExecutablePnl?: number;
  fillLatencyMs: number;
}

export interface LiveTradeParityInput {
  config: EngineConfig;
  sourceConfigVersion?: string;
  position: PositionState;
  events: readonly LiveManagementEvent[];
  observedExit?: ObservedLiveExit;
  dailyRealizedPnlBeforeEntry?: number;
  timerIntervalMs?: number;
}

export interface ModeledExitTrigger {
  timestamp: number;
  source: "FEATURE" | "OPTION_QUOTE" | "TIMER";
  reason: ExitReason;
  triggers: ExitTrigger[];
  markPrice?: number;
  liquidationPrice?: number;
  executablePnl?: number;
  protectedFloorPnl?: number;
  highWaterPnl: number;
  lowWaterPnl: number;
  quote: OptionQuote;
}

export interface LiveTradeParityResult {
  symbol: string;
  direction: PositionState["direction"];
  entryTimestamp: number;
  entryPrice: number;
  sourceConfigVersion?: string;
  testedConfigVersion: string;
  configVersionMatches?: boolean;
  modeledExit?: ModeledExitTrigger;
  observedExit?: ObservedLiveExit;
  pnl: {
    observedBroker?: number;
    decisionExecutable?: number;
    submittedLimit?: number;
    quoteBidAtObservedFill?: number;
  };
  parity: {
    reasonMatches?: boolean;
    decisionTimestampDeltaMs?: number;
    decisionExecutablePnlDelta?: number;
    submittedLimitPriceDelta?: number;
  };
  counts: {
    sourceEvents: number;
    featureUpdates: number;
    optionQuoteRows: number;
    optionQuoteBatches: number;
    optionSnapshots: number;
    rejectedOptionQuotes: number;
    controllerEvaluations: number;
  };
  warnings: string[];
}

type ReplayStep =
  | { timestamp: number; sequence: number; type: "FEATURE"; feature: FeatureSnapshot }
  | { timestamp: number; sequence: number; type: "OPTION_QUOTE"; quote: OptionQuote }
  | { timestamp: number; sequence: number; type: "OPTION_SNAPSHOT"; snapshot: OptionSnapshot };

interface PreparedEvents {
  steps: ReplayStep[];
  quoteBatches: Array<{ timestamp: number; quote: OptionQuote }>;
  counts: LiveTradeParityResult["counts"];
}

/**
 * Replays only order management. Entry selection and entry execution stay
 * anchored to the broker-confirmed live position so exit tuning cannot change
 * the trade population or silently substitute a different option contract.
 */
export function replayLiveTradeManagement(input: LiveTradeParityInput): LiveTradeParityResult {
  validateInput(input);
  const prepared = prepareEvents(input.events, input.position.symbol, input.config);
  const exitManager = new ExitManager(input.config);
  const book = new OptionBook();
  let position = structuredClone(input.position);
  let lastFeature: FeatureSnapshot | undefined;
  let lastRegime: RegimeDecision | undefined;
  let modeledExit: ModeledExitTrigger | undefined;
  const timerIntervalMs = input.timerIntervalMs ?? 250;
  let nextTimer = timerIntervalMs > 0
    ? input.position.entryTimestamp + timerIntervalMs
    : Number.POSITIVE_INFINITY;

  const evaluate = (
    timestamp: number,
    source: ModeledExitTrigger["source"],
  ): boolean => {
    const entry = book.get(position.symbol);
    if (!entry?.quote) return false;
    prepared.counts.controllerEvaluations += 1;
    const decision = exitManager.evaluate({
      timestamp,
      position,
      optionQuote: entry.quote,
      ...(entry.snapshot ? { optionSnapshot: entry.snapshot } : {}),
      ...(lastFeature ? { feature: lastFeature } : {}),
      ...(lastRegime ? { regime: lastRegime } : {}),
      killSwitch: false,
      dailyRealizedPnl: input.dailyRealizedPnlBeforeEntry ?? 0,
    });
    position = decision.updatedPosition;
    if (!decision.exit || !decision.reason) return false;
    modeledExit = {
      timestamp,
      source,
      reason: decision.reason,
      triggers: [...(decision.triggers ?? [])],
      ...(decision.markPrice !== undefined ? { markPrice: decision.markPrice } : {}),
      ...(decision.liquidationPrice !== undefined
        ? { liquidationPrice: decision.liquidationPrice }
        : {}),
      ...(decision.executablePnl !== undefined
        ? { executablePnl: decision.executablePnl }
        : {}),
      ...(decision.protectedFloorPnl !== undefined
        ? { protectedFloorPnl: decision.protectedFloorPnl }
        : {}),
      highWaterPnl: decision.updatedPosition.highWaterPnl,
      lowWaterPnl: decision.updatedPosition.lowWaterPnl,
      quote: { ...entry.quote },
    };
    return true;
  };

  for (const step of prepared.steps) {
    if (step.timestamp <= position.entryTimestamp) {
      seedStep(step, book, (feature, regime) => {
        lastFeature = feature;
        lastRegime = regime;
      }, input.config);
      continue;
    }
    while (nextTimer < step.timestamp) {
      if (evaluate(nextTimer, "TIMER")) break;
      nextTimer += timerIntervalMs;
    }
    if (modeledExit) break;

    if (step.type === "FEATURE") {
      lastFeature = step.feature;
      lastRegime = classifyRegime(step.feature, input.config.regimes);
      if (evaluate(step.timestamp, "FEATURE")) break;
    } else if (step.type === "OPTION_QUOTE") {
      book.updateQuote(step.quote);
      if (evaluate(step.timestamp, "OPTION_QUOTE")) break;
    } else {
      book.updateSnapshot(step.snapshot);
    }
    while (nextTimer <= step.timestamp) nextTimer += timerIntervalMs;
  }

  const warnings: string[] = [];
  if (input.sourceConfigVersion && input.sourceConfigVersion !== input.config.version) {
    warnings.push(
      `source config ${input.sourceConfigVersion} differs from tested config ${input.config.version}`,
    );
  }
  if (!modeledExit) warnings.push("modeled controller did not exit inside the retained event window");
  if (prepared.counts.featureUpdates === 0) {
    warnings.push("no durable feature snapshots were available in the trade window");
  }

  const multiplier = 100 * position.quantity;
  const observedFillQuote = input.observedExit
    ? lastQuoteAtOrBefore(prepared.quoteBatches, input.observedExit.fillTimestamp)
    : undefined;
  const submittedLimit = modeledExit
    ? new OrderExecutor(input.config).propose({
        clientOrderId: `parity-exit-${position.entryTimestamp}`,
        symbol: position.symbol,
        side: "sell",
        quantity: position.quantity,
        timestamp: modeledExit.timestamp,
        quote: modeledExit.quote,
        marketable: true,
      }).limitPrice
    : undefined;
  const pnl = {
    ...(input.observedExit ? { observedBroker: input.observedExit.realizedPnl } : {}),
    ...(modeledExit?.executablePnl !== undefined
      ? { decisionExecutable: modeledExit.executablePnl }
      : {}),
    ...(submittedLimit !== undefined
      ? { submittedLimit: multiplier * (submittedLimit - position.averageEntryPrice) }
      : {}),
    ...(observedFillQuote
      ? {
          quoteBidAtObservedFill:
            multiplier * (observedFillQuote.bidPrice - position.averageEntryPrice),
        }
      : {}),
  };

  return {
    symbol: position.symbol,
    direction: position.direction,
    entryTimestamp: position.entryTimestamp,
    entryPrice: position.averageEntryPrice,
    ...(input.sourceConfigVersion ? { sourceConfigVersion: input.sourceConfigVersion } : {}),
    testedConfigVersion: input.config.version,
    ...(input.sourceConfigVersion
      ? { configVersionMatches: input.sourceConfigVersion === input.config.version }
      : {}),
    ...(modeledExit ? { modeledExit } : {}),
    ...(input.observedExit ? { observedExit: input.observedExit } : {}),
    pnl,
    parity: {
      ...(modeledExit && input.observedExit
        ? {
            reasonMatches: modeledExit.reason === input.observedExit.reason,
            decisionTimestampDeltaMs:
              modeledExit.timestamp - input.observedExit.decisionTimestamp,
            ...(modeledExit.executablePnl !== undefined &&
                input.observedExit.decisionExecutablePnl !== undefined
              ? {
                  decisionExecutablePnlDelta:
                    modeledExit.executablePnl - input.observedExit.decisionExecutablePnl,
                }
              : {}),
            ...(submittedLimit !== undefined
              ? {
                  submittedLimitPriceDelta:
                    submittedLimit - input.observedExit.submittedLimitPrice,
                }
              : {}),
          }
        : {}),
    },
    counts: prepared.counts,
    warnings,
  };
}

function prepareEvents(
  source: readonly LiveManagementEvent[],
  symbol: string,
  config: EngineConfig,
): PreparedEvents {
  // Batched PostgreSQL inserts can assign ids in flush order across independent
  // feature and OPRA writers. Receiver wall time is the causal boundary; ids
  // only break ties within the same receive timestamp.
  const events = [...source].sort((left, right) =>
    left.receivedTimestamp - right.receivedTimestamp || left.sequence - right.sequence);
  const steps: ReplayStep[] = [];
  const quoteBatches: Array<{ timestamp: number; quote: OptionQuote }> = [];
  const acceptedQuotes = new OptionBook();
  const counts: LiveTradeParityResult["counts"] = {
    sourceEvents: events.length,
    featureUpdates: 0,
    optionQuoteRows: 0,
    optionQuoteBatches: 0,
    optionSnapshots: 0,
    rejectedOptionQuotes: 0,
    controllerEvaluations: 0,
  };
  let previousTimestamp = -Infinity;
  for (let index = 0; index < events.length;) {
    const event = events[index]!;
    if (event.receivedTimestamp < previousTimestamp) {
      throw new Error(
        `Live management event time decreased at sequence ${event.sequence}: ` +
        `${event.receivedTimestamp} < ${previousTimestamp}`,
      );
    }
    previousTimestamp = event.receivedTimestamp;
    if (event.type === "option_quote") {
      const batchTimestamp = event.receivedTimestamp;
      const batchSequence = event.sequence;
      let latestActiveQuote: OptionQuote | undefined;
      while (index < events.length) {
        const quoteEvent = events[index]!;
        if (quoteEvent.type !== "option_quote" ||
            quoteEvent.receivedTimestamp !== batchTimestamp) break;
        counts.optionQuoteRows += 1;
        if (quoteEvent.data.symbol === symbol) {
          const validation = validateOptionQuote(
            quoteEvent.data,
            batchTimestamp,
            config.dataQuality,
          );
          if (validation.usable && acceptedQuotes.updateQuote(validation.value!)) {
            latestActiveQuote = validation.value!;
          } else {
            counts.rejectedOptionQuotes += 1;
          }
        }
        index += 1;
      }
      if (latestActiveQuote) {
        counts.optionQuoteBatches += 1;
        steps.push({
          timestamp: batchTimestamp,
          sequence: batchSequence,
          type: "OPTION_QUOTE",
          quote: latestActiveQuote,
        });
        quoteBatches.push({ timestamp: batchTimestamp, quote: latestActiveQuote });
      }
      continue;
    }
    if (event.type === "feature_snapshot") {
      counts.featureUpdates += 1;
      steps.push({
        timestamp: event.receivedTimestamp,
        sequence: event.sequence,
        type: "FEATURE",
        feature: event.data,
      });
    } else if (event.data.symbol === symbol) {
      counts.optionSnapshots += 1;
      steps.push({
        timestamp: event.receivedTimestamp,
        sequence: event.sequence,
        type: "OPTION_SNAPSHOT",
        snapshot: event.data,
      });
    }
    index += 1;
  }
  return { steps, quoteBatches, counts };
}

function seedStep(
  step: ReplayStep,
  book: OptionBook,
  updateFeature: (feature: FeatureSnapshot, regime: RegimeDecision) => void,
  config: EngineConfig,
): void {
  if (step.type === "FEATURE") {
    updateFeature(step.feature, classifyRegime(step.feature, config.regimes));
  } else if (step.type === "OPTION_QUOTE") {
    book.updateQuote(step.quote);
  } else {
    book.updateSnapshot(step.snapshot);
  }
}

function lastQuoteAtOrBefore(
  batches: ReadonlyArray<{ timestamp: number; quote: OptionQuote }>,
  timestamp: number,
): OptionQuote | undefined {
  for (let index = batches.length - 1; index >= 0; index -= 1) {
    const batch = batches[index]!;
    if (batch.timestamp <= timestamp) return batch.quote;
  }
  return undefined;
}

function validateInput(input: LiveTradeParityInput): void {
  const position = input.position;
  if (!position.symbol || !Number.isFinite(position.entryTimestamp) ||
      !(position.averageEntryPrice > 0) ||
      !(Number.isInteger(position.quantity) && position.quantity > 0)) {
    throw new Error("Live trade parity requires a complete broker-confirmed entry position");
  }
  if (input.timerIntervalMs !== undefined &&
      !(Number.isInteger(input.timerIntervalMs) && input.timerIntervalMs >= 0)) {
    throw new Error("Live trade parity timerIntervalMs must be a non-negative integer");
  }
  for (const event of input.events) {
    if (!Number.isFinite(event.sequence) || !Number.isFinite(event.receivedTimestamp) ||
        !Number.isFinite(event.providerTimestamp)) {
      throw new Error("Live trade parity received an invalid market event");
    }
  }
}
