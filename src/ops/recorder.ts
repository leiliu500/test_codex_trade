export interface AuditEvent {
  timestamp: number;
  marketDate?: string;
  type: string;
  configVersion: string;
  calibrationVersion?: string;
  data: Record<string, unknown>;
}

export interface AuditRecorder {
  record(event: AuditEvent): void | Promise<void>;
  healthy(): boolean;
}

export class MemoryRecorder implements AuditRecorder {
  readonly events: AuditEvent[] = [];
  record(event: AuditEvent): void { this.events.push(event); }
  healthy(): boolean { return true; }
}

export class JsonLineRecorder implements AuditRecorder {
  readonly #write: (line: string) => void;
  #healthy = true;
  constructor(write: (line: string) => void) { this.#write = write; }
  record(event: AuditEvent): void {
    try { this.#write(`${JSON.stringify(event)}\n`); }
    catch (error) { this.#healthy = false; throw error; }
  }
  healthy(): boolean { return this.#healthy; }
}
