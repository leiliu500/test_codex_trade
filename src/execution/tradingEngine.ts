/**
 * One authoritative serialized queue. WebSocket callbacks enqueue work here so
 * feature, position, daily-risk, and order state cannot race one another.
 */
export class SerializedDecisionQueue {
  #tail: Promise<void> = Promise.resolve();
  #halted = false;
  #error?: unknown;

  enqueue(task: () => void | Promise<void>): Promise<void> {
    if (this.#halted) return Promise.reject(this.#error ?? new Error("decision queue halted"));
    const run = this.#tail.then(task);
    this.#tail = run.catch((error: unknown) => {
      this.#halted = true;
      this.#error = error;
    });
    return run;
  }

  async drained(): Promise<void> { await this.#tail; }
  get halted(): boolean { return this.#halted; }
  get error(): unknown { return this.#error; }
}
