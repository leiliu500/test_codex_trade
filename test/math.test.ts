import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.js";
import { microprice, midprice, quoteImbalance, micropriceDisplacementBps } from "../src/features/quoteMath.js";
import { ordinaryEndpointQuadratic, robustEndpointQuadratic } from "../src/math/robustQuadratic.js";
import { efficiencyRatio, directionalSignChanges, realizedMovementBps } from "../src/math/rollingIndicators.js";
import { ConstantAccelerationKalman } from "../src/math/kalmanKinematic.js";

test("microprice identity and top-of-book bounds", () => {
  for (const [bidSize, askSize] of [[100, 100], [400, 100], [100, 400]]) {
    const bid = 499.99;
    const ask = 500.01;
    const mid = midprice(bid, ask);
    const imbalance = quoteImbalance(bidSize!, askSize!);
    const micro = microprice(bid, ask, bidSize!, askSize!);
    assert.ok(bid < micro && micro < ask);
    assert.ok(Math.abs((micro - mid) - (ask - bid) / 2 * imbalance) < 1e-12);
    assert.equal(Math.sign(micro - mid), Math.sign(imbalance));
    assert.ok(Number.isFinite(micropriceDisplacementBps(bid, ask, bidSize!, askSize!)));
  }
});

test("robust endpoint quadratic exactly recovers endpoint derivatives", () => {
  const now = 1_000_000;
  const windowSec = 10;
  const coefficients = [Math.log(500), 0.002, -0.0003] as const;
  const observations = Array.from({ length: 11 }, (_, index) => {
    const u = -1 + index / 10;
    return { timestamp: now + u * windowSec * 1000, value: coefficients[0] + coefficients[1] * u + coefficients[2] * u ** 2 };
  });
  const fit = robustEndpointQuadratic(observations, now, windowSec, defaultConfig.regression);
  assert.equal(fit.valid, true);
  assert.ok(Math.abs(fit.coefficients![0] - coefficients[0]) < 1e-10);
  assert.ok(Math.abs(fit.coefficients![1] - coefficients[1]) < 1e-10);
  assert.ok(Math.abs(fit.coefficients![2] - coefficients[2]) < 1e-10);
  assert.ok(Math.abs(fit.slopeBpsPerSec! - 10_000 * coefficients[1] / windowSec) < 1e-9);
  assert.ok(Math.abs(fit.accelerationBpsPerSec2! - 20_000 * coefficients[2] / windowSec ** 2) < 1e-9);
  assert.ok(Math.abs(fit.r2! - 1) < 1e-10);
});

test("constant/linear paths remain finite and scale invariant", () => {
  const now = 10_000;
  const make = (scale: number, slope: number) => Array.from({ length: 11 }, (_, index) => ({
    timestamp: now - (10 - index) * 1000,
    value: Math.log(scale) + slope * index,
  }));
  const constant = robustEndpointQuadratic(make(500, 0), now, 10, defaultConfig.regression);
  assert.equal(constant.valid, true);
  assert.ok(Math.abs(constant.slopeBpsPerSec!) < 1e-8);
  assert.ok(Math.abs(constant.accelerationBpsPerSec2!) < 1e-8);
  const one = robustEndpointQuadratic(make(500, 0.00001), now, 10, defaultConfig.regression);
  const scaled = robustEndpointQuadratic(make(5_000, 0.00001), now, 10, defaultConfig.regression);
  assert.ok(Math.abs(one.slopeBpsPerSec! - scaled.slopeBpsPerSec!) < 1e-8);
  assert.ok(Math.abs(one.accelerationBpsPerSec2! - scaled.accelerationBpsPerSec2!) < 1e-8);
});

test("IRLS resists a single outlier better than weighted least squares", () => {
  const now = 50_000;
  const clean = Array.from({ length: 11 }, (_, index) => ({
    timestamp: now - (10 - index) * 1000,
    value: 6 + 0.00001 * index,
  }));
  const outlier = clean.map((point, index) => ({ ...point, value: point.value + (index === 7 ? 0.02 : 0) }));
  const target = robustEndpointQuadratic(clean, now, 10, defaultConfig.regression).slopeBpsPerSec!;
  const robust = robustEndpointQuadratic(outlier, now, 10, defaultConfig.regression).slopeBpsPerSec!;
  const ordinary = ordinaryEndpointQuadratic(outlier, now, 10, defaultConfig.regression).slopeBpsPerSec!;
  assert.ok(Math.abs(robust - target) < Math.abs(ordinary - target));
});

test("endpoint fit is causal and enforces coverage", () => {
  const now = 20_000;
  const past = Array.from({ length: 11 }, (_, index) => ({ timestamp: now - (10 - index) * 1000, value: 6 + index * 1e-5 }));
  const atNow = robustEndpointQuadratic(past, now, 10, defaultConfig.regression);
  const withFuture = robustEndpointQuadratic([...past, { timestamp: now + 1000, value: 99 }], now, 10, defaultConfig.regression);
  assert.deepEqual(withFuture.coefficients, atNow.coefficients);
  const sparse = robustEndpointQuadratic(past.slice(-6), now, 10, defaultConfig.regression);
  assert.equal(sparse.valid, false);
  assert.equal(sparse.reason, "INSUFFICIENT_COVERAGE");
});

test("rolling path metrics implement RV, efficiency and sign changes", () => {
  const monotonic = [0, 1, 2, 3].map((x) => x * 0.001);
  assert.ok(Math.abs(efficiencyRatio(monotonic) - 1) < 1e-9);
  assert.equal(directionalSignChanges(monotonic), 0);
  assert.ok(Math.abs(realizedMovementBps(monotonic) - 10_000 * Math.sqrt(3e-6)) < 1e-9);
  assert.equal(directionalSignChanges([0, 1, 0, 1, 0]), 3);
});

test("constant-acceleration Kalman update remains causal and finite", () => {
  const filter = new ConstantAccelerationKalman({ measurementNoise: 1e-7 });
  for (let index = 0; index < 20; index += 1) filter.update(index * 1000, 6 + 1e-5 * index + 1e-7 * index ** 2);
  assert.ok(filter.state);
  assert.ok(filter.state!.state.every(Number.isFinite));
  assert.ok(filter.state!.innovationVariance > 0);
});
