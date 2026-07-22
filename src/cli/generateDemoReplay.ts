import { createWriteStream } from "node:fs";
import { formatOccSymbol } from "../options/occSymbol.js";
import { zonedDateTimeToEpoch } from "../utils/time.js";
import type { OptionContract, ReplayEvent } from "../types.js";

function emit(write: (line: string) => void, event: ReplayEvent): void { write(`${JSON.stringify(event)}\n`); }

async function main(): Promise<void> {
  const output = process.argv[2];
  const date = process.argv[3] ?? "2026-07-22";
  if (!output) throw new Error("Usage: npm run demo -- <output.jsonl> [YYYY-MM-DD]");
  const stream = createWriteStream(output);
  const write = (line: string): void => { stream.write(line); };
  const open = zonedDateTimeToEpoch(date, "09:30:00");
  const end = zonedDateTimeToEpoch(date, "10:18:30");
  const strike = 600;
  const contract: OptionContract = {
    symbol: formatOccSymbol({ underlying: "SPY", expirationDate: date, type: "call", strike }),
    underlying: "SPY", expirationDate: date, type: "call", strike, tradable: true, active: true,
  };
  emit(write, { type: "prior_close", timestamp: open - 1, data: { symbol: "SPY", close: 598.5 } });
  emit(write, { type: "option_contract", timestamp: open, data: contract });
  for (let timestamp = open; timestamp <= end; timestamp += 1000) {
    const elapsed = (timestamp - open) / 1000;
    const afterEntry = Math.max(0, elapsed - 2700);
    const price = 599 + 0.00012 * elapsed + 0.020 * afterEntry + 0.00002 * afterEntry ** 2;
    const quote = { symbol: "SPY" as const, timestamp: timestamp + 100, bidPrice: price - 0.005, askPrice: price + 0.005, bidSize: 1400, askSize: afterEntry > 0 ? 500 : 1200 };
    emit(write, { type: "stock_quote", timestamp: timestamp + 100, data: quote });
    emit(write, { type: "stock_trade", timestamp: timestamp + 200, data: { symbol: "SPY", timestamp: timestamp + 200, price, size: 500 + Math.floor(afterEntry) } });
    if (elapsed >= 2640) {
      const optionMid = 1.6 + Math.max(0, price - 599.3) * 0.55;
      emit(write, { type: "option_quote", timestamp: timestamp + 300, data: {
        symbol: contract.symbol, timestamp: timestamp + 300, bidPrice: optionMid - 0.005, askPrice: optionMid + 0.005, bidSize: 100, askSize: 100,
      } });
      emit(write, { type: "option_snapshot", timestamp: timestamp + 350, data: {
        symbol: contract.symbol, timestamp: timestamp + 350, impliedVolatility: 0.22,
        greeks: { delta: 0.52, gamma: 0.03, theta: -0.12, vega: 0.03 }, dailyVolume: 1000, openInterest: 5000,
      } });
    }
  }
  await new Promise<void>((resolve, reject) => { stream.end(resolve); stream.on("error", reject); });
  process.stdout.write(`${output}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
