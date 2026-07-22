import { redactSecrets } from "./env.js";

export class JsonLogger {
  readonly #secrets: readonly string[];
  readonly #write: (line: string) => void;
  constructor(secrets: readonly string[] = [], write: (line: string) => void = console.log) {
    this.#secrets = secrets;
    this.#write = write;
  }
  log(level: "debug" | "info" | "warn" | "error", message: string, data: Record<string, unknown> = {}): void {
    this.#write(JSON.stringify(redactSecrets({ timestamp: Date.now(), level, message, ...data }, this.#secrets)));
  }
}
