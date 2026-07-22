import { EPSILON } from "../utils/statistics.js";

export type Matrix3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];
export type Vector3 = [number, number, number];

export function determinant3(m: Matrix3): number {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

export function inverse3(m: Matrix3): Matrix3 | undefined {
  const det = determinant3(m);
  const scale = Math.max(1, ...m.flat().map(Math.abs));
  if (!Number.isFinite(det) || Math.abs(det) <= EPSILON * scale ** 3) return undefined;
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const inv: Matrix3 = [
    [e * i - f * h, c * h - b * i, b * f - c * e],
    [f * g - d * i, a * i - c * g, c * d - a * f],
    [d * h - e * g, b * g - a * h, a * e - b * d],
  ];
  for (const row of inv) {
    row[0] /= det;
    row[1] /= det;
    row[2] /= det;
  }
  return inv;
}

export function multiplyMatrixVector(m: Matrix3, v: Vector3): Vector3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

export function solve3(m: Matrix3, v: Vector3): { solution: Vector3; inverse: Matrix3 } | undefined {
  const inverse = inverse3(m);
  return inverse ? { solution: multiplyMatrixVector(inverse, v), inverse } : undefined;
}

export function identity3(): Matrix3 {
  return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
}

export function multiply3(a: Matrix3, b: Matrix3): Matrix3 {
  const result: Matrix3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      const rr = r as 0 | 1 | 2;
      const cc = c as 0 | 1 | 2;
      result[rr][cc] = a[rr][0] * b[0][cc] + a[rr][1] * b[1][cc] + a[rr][2] * b[2][cc];
    }
  }
  return result;
}

export function transpose3(m: Matrix3): Matrix3 {
  return [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
}
