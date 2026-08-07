import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { loadDotEnv } from "../utils/loadDotEnv.js";
import { PostgresHistoryStore } from "../history/postgresHistory.js";
import type { UnderlyingSymbol } from "../types.js";

loadDotEnv();

const args = process.argv.slice(2);
const symbolFlags = args.filter((argument) => argument.startsWith("--symbol="));
if (symbolFlags.length > 1) throw new Error("Specify --symbol only once");
const symbolValue = (symbolFlags[0]?.slice("--symbol=".length) ?? "SPY").toUpperCase();
const positional = args.filter((argument) => !argument.startsWith("--symbol="));
const marketDate = positional[0];
const outputPath = positional[1];
if (!marketDate || !/^\d{4}-\d{2}-\d{2}$/.test(marketDate)) {
  throw new Error("Usage: npm run export:history -- YYYY-MM-DD [output.jsonl] [--symbol=SPY|QQQ]");
}
if (symbolValue !== "SPY" && symbolValue !== "QQQ") throw new Error(`Unknown export symbol: ${symbolValue}`);
const underlying = symbolValue as UnderlyingSymbol;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required to export PostgreSQL history");

const history = new PostgresHistoryStore({ connectionString });
await history.initialize();
try {
  const events = await history.loadReplayEvents(marketDate, underlying);
  const output = outputPath ? createWriteStream(outputPath, { encoding: "utf8" }) : process.stdout;
  for (const event of events) output.write(`${JSON.stringify(event)}\n`);
  if (outputPath) {
    output.end();
    await once(output, "finish");
  }
  process.stderr.write(`${JSON.stringify({ marketDate, underlying, events: events.length, output: outputPath ?? "stdout" })}\n`);
} finally {
  await history.close();
}
