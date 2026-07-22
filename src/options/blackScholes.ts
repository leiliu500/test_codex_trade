import { EPSILON } from "../utils/statistics.js";
import type { OptionType } from "../types.js";

export interface BlackScholesInput {
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
  type: OptionType;
}

export interface BlackScholesResult {
  value: number;
  delta: number;
  gamma: number;
  vegaPerVolPoint: number;
  thetaPerCalendarDay: number;
  rhoPerRatePoint: number;
  d1: number;
  d2: number;
}

export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Abramowitz-Stegun approximation; maximum error is adequate for deterministic fallback Greeks. */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

export function blackScholes(input: BlackScholesInput): BlackScholesResult {
  const { spot: s, strike: k, timeToExpiryYears: tau, riskFreeRate: r, dividendYield: q, volatility: sigma, type } = input;
  if (!(s > 0 && k > 0 && tau > 0 && sigma > 0) || ![r, q].every(Number.isFinite)) {
    throw new Error("Black-Scholes requires positive spot, strike, time, volatility and finite rates");
  }
  const rootTau = Math.sqrt(tau);
  const d1 = (Math.log(s / k) + (r - q + 0.5 * sigma ** 2) * tau) / (sigma * rootTau);
  const d2 = d1 - sigma * rootTau;
  const discountedSpot = s * Math.exp(-q * tau);
  const discountedStrike = k * Math.exp(-r * tau);
  const diffusionTheta = -discountedSpot * normalPdf(d1) * sigma / (2 * rootTau);
  if (type === "call") {
    return {
      value: discountedSpot * normalCdf(d1) - discountedStrike * normalCdf(d2),
      delta: Math.exp(-q * tau) * normalCdf(d1),
      gamma: Math.exp(-q * tau) * normalPdf(d1) / (s * sigma * rootTau),
      vegaPerVolPoint: discountedSpot * normalPdf(d1) * rootTau / 100,
      thetaPerCalendarDay: (diffusionTheta - r * discountedStrike * normalCdf(d2) + q * discountedSpot * normalCdf(d1)) / 365,
      rhoPerRatePoint: k * tau * Math.exp(-r * tau) * normalCdf(d2) / 100,
      d1, d2,
    };
  }
  return {
    value: discountedStrike * normalCdf(-d2) - discountedSpot * normalCdf(-d1),
    delta: -Math.exp(-q * tau) * normalCdf(-d1),
    gamma: Math.exp(-q * tau) * normalPdf(d1) / (s * sigma * rootTau),
    vegaPerVolPoint: discountedSpot * normalPdf(d1) * rootTau / 100,
    thetaPerCalendarDay: (diffusionTheta + r * discountedStrike * normalCdf(-d2) - q * discountedSpot * normalCdf(-d1)) / 365,
    rhoPerRatePoint: -k * tau * Math.exp(-r * tau) * normalCdf(-d2) / 100,
    d1, d2,
  };
}

export function noArbitrageBounds(input: Omit<BlackScholesInput, "volatility">): { lower: number; upper: number } {
  const discountedSpot = input.spot * Math.exp(-input.dividendYield * input.timeToExpiryYears);
  const discountedStrike = input.strike * Math.exp(-input.riskFreeRate * input.timeToExpiryYears);
  return input.type === "call"
    ? { lower: Math.max(0, discountedSpot - discountedStrike), upper: discountedSpot }
    : { lower: Math.max(0, discountedStrike - discountedSpot), upper: discountedStrike };
}

export interface ImpliedVolatilityInput extends Omit<BlackScholesInput, "volatility"> {
  marketPrice: number;
  maximumVolatility?: number;
  tolerance?: number;
  maximumIterations?: number;
}

export function impliedVolatility(input: ImpliedVolatilityInput): number | undefined {
  const { marketPrice, maximumVolatility = 5, tolerance = 1e-6, maximumIterations = 100, ...base } = input;
  if (!(marketPrice > 0)) return undefined;
  const bounds = noArbitrageBounds(base);
  if (marketPrice < bounds.lower - tolerance || marketPrice > bounds.upper + tolerance) return undefined;
  let low = 1e-6;
  let high = maximumVolatility;
  const highValue = blackScholes({ ...base, volatility: high }).value;
  if (highValue + tolerance < marketPrice) return undefined;
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    const middle = (low + high) / 2;
    const price = blackScholes({ ...base, volatility: middle }).value;
    if (Math.abs(price - marketPrice) <= tolerance || high - low <= EPSILON) return middle;
    if (price < marketPrice) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
