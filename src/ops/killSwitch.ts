export type KillSwitchReason =
  | "DAILY_LOSS_LIMIT" | "BROKER_REJECTIONS" | "RECONCILIATION_MISMATCH" | "STALE_MARKET_DATA"
  | "CLOCK_DRIFT" | "ENGINE_EXCEPTION" | "DUPLICATE_POSITIONS" | "RECORDER_FAILURE" | "MANUAL";

export class KillSwitch {
  #active = false;
  #reason: KillSwitchReason | undefined;
  trigger(reason: KillSwitchReason): void { this.#active = true; this.#reason = reason; }
  resetByOperator(): void { this.#active = false; this.#reason = undefined; }
  get active(): boolean { return this.#active; }
  get reason(): KillSwitchReason | undefined { return this.#reason; }
}
