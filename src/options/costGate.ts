export interface OptionCostResult {
  spread: number;
  perSideSlippage: number;
  roundTripCostPerShare: number;
  equivalentUnderlyingCostBps: number;
  requiredMoveBps: number;
  costMarginBps: number;
  passes: boolean;
}

export function evaluateOptionCost(
  bid: number,
  ask: number,
  absoluteDelta: number,
  spot: number,
  projectedMoveBps: number,
  slippagePerSideFraction = 0.20,
  requiredMultiple = 1.75,
): OptionCostResult {
  const spread = ask - bid;
  const perSideSlippage = slippagePerSideFraction * spread;
  const roundTripCostPerShare = spread + 2 * perSideSlippage;
  const equivalentUnderlyingCostBps = 10_000 * roundTripCostPerShare / (absoluteDelta * spot);
  const requiredMoveBps = requiredMultiple * equivalentUnderlyingCostBps;
  const costMarginBps = projectedMoveBps - requiredMoveBps;
  return {
    spread,
    perSideSlippage,
    roundTripCostPerShare,
    equivalentUnderlyingCostBps,
    requiredMoveBps,
    costMarginBps,
    passes: Number.isFinite(costMarginBps) && costMarginBps > 0,
  };
}

export function gammaAwareProjectedOptionMove(
  spot: number, projectedMoveBps: number, absoluteDelta: number, gamma: number,
): number {
  const underlyingChange = spot * projectedMoveBps / 10_000;
  return absoluteDelta * underlyingChange + 0.5 * gamma * underlyingChange ** 2;
}
