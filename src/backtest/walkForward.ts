export interface WalkForwardFold {
  train: string[];
  validation: string[];
  test: string[];
}

export function buildWalkForwardFolds(
  orderedSessionDates: readonly string[], trainSessions = 60, validationSessions = 10,
  testSessions = 10, advanceSessions = 10,
): WalkForwardFold[] {
  const unique = [...new Set(orderedSessionDates)].sort();
  const folds: WalkForwardFold[] = [];
  for (let start = 0; start + trainSessions + validationSessions + testSessions <= unique.length; start += advanceSessions) {
    folds.push({
      train: unique.slice(start, start + trainSessions),
      validation: unique.slice(start + trainSessions, start + trainSessions + validationSessions),
      test: unique.slice(start + trainSessions + validationSessions, start + trainSessions + validationSessions + testSessions),
    });
  }
  return folds;
}

export interface LabeledExample { featureTimestamp: number; labelEndTimestamp: number }

/** Remove training examples whose label horizon overlaps the split, then embargo adjacent observations. */
export function purgeAndEmbargo(
  training: readonly LabeledExample[], splitTimestamp: number, embargoMs: number,
): LabeledExample[] {
  return training.filter((example) =>
    example.labelEndTimestamp < splitTimestamp && example.featureTimestamp < splitTimestamp - embargoMs);
}
