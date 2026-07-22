import { readFileSync } from "node:fs";

/** Minimal dotenv reader; it never overrides variables already supplied by the host. */
export function loadDotEnv(path = ".env", env: NodeJS.ProcessEnv = process.env): void {
  let content: string;
  try { content = readFileSync(path, "utf8"); }
  catch { return; }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (env[key] === undefined) env[key] = value;
  }
}
