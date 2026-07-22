export class RingBuffer<T> {
  readonly #capacity: number;
  readonly #items: T[] = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive integer");
    this.#capacity = capacity;
  }

  push(item: T): T | undefined {
    this.#items.push(item);
    return this.#items.length > this.#capacity ? this.#items.shift() : undefined;
  }

  get length(): number { return this.#items.length; }
  get last(): T | undefined { return this.#items.at(-1); }
  values(): readonly T[] { return this.#items; }
  clear(): void { this.#items.length = 0; }
}
