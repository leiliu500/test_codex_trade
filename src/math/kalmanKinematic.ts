import { identity3, multiply3, transpose3, type Matrix3, type Vector3 } from "./linearAlgebra.js";
import { EPSILON } from "../utils/statistics.js";

export interface KalmanState {
  timestamp: number;
  state: Vector3;
  covariance: Matrix3;
  innovation: number;
  innovationVariance: number;
}

export interface KalmanConfig {
  processNoiseLevel: number;
  processNoiseVelocity: number;
  processNoiseAcceleration: number;
  measurementNoise: number;
}

const defaultKalmanConfig: KalmanConfig = {
  processNoiseLevel: 1e-10,
  processNoiseVelocity: 1e-10,
  processNoiseAcceleration: 1e-10,
  measurementNoise: 1e-8,
};

export class ConstantAccelerationKalman {
  #state?: KalmanState;
  readonly #config: KalmanConfig;

  constructor(config: Partial<KalmanConfig> = {}) {
    this.#config = { ...defaultKalmanConfig, ...config };
  }

  update(timestamp: number, measuredLogPrice: number): KalmanState {
    if (!this.#state) {
      this.#state = {
        timestamp,
        state: [measuredLogPrice, 0, 0],
        covariance: identity3(),
        innovation: 0,
        innovationVariance: this.#config.measurementNoise,
      };
      return this.#state;
    }
    const dt = Math.max(0, (timestamp - this.#state.timestamp) / 1000);
    const transition: Matrix3 = [[1, dt, 0.5 * dt ** 2], [0, 1, dt], [0, 0, 1]];
    const [level, velocity, acceleration] = this.#state.state;
    const predicted: Vector3 = [
      level + dt * velocity + 0.5 * dt ** 2 * acceleration,
      velocity + dt * acceleration,
      acceleration,
    ];
    const process: Matrix3 = [
      [this.#config.processNoiseLevel, 0, 0],
      [0, this.#config.processNoiseVelocity, 0],
      [0, 0, this.#config.processNoiseAcceleration],
    ];
    const propagated = multiply3(multiply3(transition, this.#state.covariance), transpose3(transition));
    const predictedCovariance = propagated.map((row, r) =>
      row.map((value, c) => value + process[r]![c]!) as [number, number, number]) as Matrix3;
    const innovation = measuredLogPrice - predicted[0];
    const innovationVariance = predictedCovariance[0][0] + this.#config.measurementNoise;
    const gain: Vector3 = [
      predictedCovariance[0][0] / (innovationVariance + EPSILON),
      predictedCovariance[1][0] / (innovationVariance + EPSILON),
      predictedCovariance[2][0] / (innovationVariance + EPSILON),
    ];
    const updated: Vector3 = predicted.map((value, i) => value + gain[i]! * innovation) as Vector3;
    // (I - K H)P, with H=[1,0,0].
    const correction: Matrix3 = [[1 - gain[0], 0, 0], [-gain[1], 1, 0], [-gain[2], 0, 1]];
    this.#state = {
      timestamp,
      state: updated,
      covariance: multiply3(correction, predictedCovariance),
      innovation,
      innovationVariance,
    };
    return this.#state;
  }

  get state(): KalmanState | undefined { return this.#state; }
}
