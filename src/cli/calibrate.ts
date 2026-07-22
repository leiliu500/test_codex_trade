import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import type { FeatureSnapshot } from "../types.js";
import { buildCalibrationProfile, calibrationObservationFromFeature } from "../features/calibration.js";

async function main(): Promise<void> {
  const [path, start, end, sourceVersion = "unspecified"] = process.argv.slice(2);
  if (!path || !start || !end) throw new Error("Usage: npm run calibrate -- <feature-snapshots.jsonl> <start-date> <end-date> [source-version]");
  const observations = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as Partial<FeatureSnapshot> & { data?: { feature?: FeatureSnapshot } };
    const feature = parsed.symbol === "SPY" ? parsed as FeatureSnapshot : parsed.data?.feature;
    if (feature) observations.push(calibrationObservationFromFeature(feature));
  }
  const parameterHash = createHash("sha256").update(readFileSync(new URL("../../config/default.json", import.meta.url))).digest("hex");
  const profile = buildCalibrationProfile(observations, {
    version: `cal-${start}-${end}`,
    trainingStartDate: start,
    trainingEndDate: end,
    sourceDataVersion: sourceVersion,
    parameterHash,
  });
  process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
