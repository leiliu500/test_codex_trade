import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { loadDotEnv } from "../utils/loadDotEnv.js";
import { PostgresHistoryStore } from "../history/postgresHistory.js";

loadDotEnv();

const marketDate = process.argv[2];
const outputPath = process.argv[3];
if (!marketDate || !/^\d{4}-\d{2}-\d{2}$/.test(marketDate)) {
  throw new Error("Usage: npm run export:history -- YYYY-MM-DD [output.jsonl]");
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required to export PostgreSQL history");

const history = new PostgresHistoryStore({ connectionString });
await history.initialize();
try {
  const events = await history.loadReplayEvents(marketDate);
  const output = outputPath ? createWriteStream(outputPath, { encoding: "utf8" }) : process.stdout;
  for (const event of events) output.write(`${JSON.stringify(event)}\n`);
  if (outputPath) {
    output.end();
    await once(output, "finish");
  }
  process.stderr.write(`${JSON.stringify({ marketDate, events: events.length, output: outputPath ?? "stdout" })}\n`);
} finally {
  await history.close();
}
