export type TrendPhase =
  | "UP_STRENGTHENING"
  | "UP_GRIND"
  | "UP_DECELERATING"
  | "BULLISH_ONSET"
  | "DOWN_STRENGTHENING"
  | "DOWN_GRIND"
  | "DOWN_DECELERATING"
  | "BEARISH_ONSET"
  | "FLAT";

export function classifyTrendPhase(slope: number, acceleration: number, nearZero = 0.05): TrendPhase {
  const s = Math.abs(slope) <= nearZero ? 0 : Math.sign(slope);
  const a = Math.abs(acceleration) <= nearZero ? 0 : Math.sign(acceleration);
  if (s > 0 && a > 0) return "UP_STRENGTHENING";
  if (s > 0 && a === 0) return "UP_GRIND";
  if (s > 0 && a < 0) return "UP_DECELERATING";
  if (s === 0 && a > 0) return "BULLISH_ONSET";
  if (s < 0 && a < 0) return "DOWN_STRENGTHENING";
  if (s < 0 && a === 0) return "DOWN_GRIND";
  if (s < 0 && a > 0) return "DOWN_DECELERATING";
  if (s === 0 && a < 0) return "BEARISH_ONSET";
  return "FLAT";
}
