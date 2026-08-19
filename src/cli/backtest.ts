import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { configCatalog } from "../config.js";
import { isUnderlyingSymbol, type CalibrationProfile } from "../types.js";
import { ReplayEngine, type FillModel } from "../backtest/replay.js";
import { parseReplayLine } from "../backtest/replay.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const symbolFlags = args.filter((argument) => argument.startsWith("--symbol="));
  if (symbolFlags.length > 1) throw new Error("Specify --symbol only once");
  const symbolValue = symbolFlags[0]?.slice("--symbol=".length).toUpperCase() ?? "SPY";
  if (!isUnderlyingSymbol(symbolValue)) throw new Error(`Unknown replay symbol: ${symbolValue}`);
  const symbol = symbolValue;
  const positional = args.filter((argument) => !argument.startsWith("--symbol="));
  const path = positional[0];
  if (!path) {
    throw new Error("Usage: npm run backtest -- <events.jsonl> [conservative|midpoint-touch|queue] [calibration.json] [--symbol=<supported ticker>]");
  }
  const fillModel = (positional[1] ?? "conservative") as FillModel;
  if (!new Set(["conservative", "midpoint-touch", "queue"]).has(fillModel)) throw new Error(`Unknown fill model: ${fillModel}`);
  const calibrationPath = positional[2];
  const calibration = calibrationPath
    ? JSON.parse(readFileSync(calibrationPath, "utf8")) as CalibrationProfile : undefined;
  const config = configCatalog[symbol];
  const engine = new ReplayEngine({ config, fillModel, ...(calibration ? { calibration } : {}) });
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
