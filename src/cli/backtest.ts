import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { CalibrationProfile } from "../types.js";
import { ReplayEngine, type FillModel } from "../backtest/replay.js";
import { parseReplayLine } from "../backtest/replay.js";

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: npm run backtest -- <events.jsonl> [conservative|midpoint-touch|queue] [calibration.json]");
  const fillModel = (process.argv[3] ?? "conservative") as FillModel;
  if (!new Set(["conservative", "midpoint-touch", "queue"]).has(fillModel)) throw new Error(`Unknown fill model: ${fillModel}`);
  const calibrationPath = process.argv[4];
  const calibration = calibrationPath
    ? JSON.parse(readFileSync(calibrationPath, "utf8")) as CalibrationProfile : undefined;
  const engine = new ReplayEngine({ fillModel, ...(calibration ? { calibration } : {}) });
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    await engine.ingest(parseReplayLine(line, lineNumber));
  }
  const result = await engine.finish();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
