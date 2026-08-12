import assert from "node:assert/strict";
import test from "node:test";
import { AlpacaStockHistoryRestClient } from "../src/alpaca/stockHistory.js";

test("Alpaca historical SIP recovery paginates, samples quotes, and merges trades causally", async () => {
  const start = Date.parse("2026-08-12T13:30:00.000Z");
  const requested: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requested.push(url);
    const type = url.pathname.endsWith("/quotes") ? "quotes" : "trades";
    const page = url.searchParams.get("page_token");
    if (type === "quotes" && page === null) {
      return Response.json({
        quotes: [
          { t: new Date(start + 100).toISOString(), bp: 500, ap: 500.02, bs: 10, as: 12 },
          { t: new Date(start + 200).toISOString(), bp: 500.01, ap: 500.03, bs: 11, as: 13 },
        ],
        next_page_token: "quotes-2",
      });
    }
    if (type === "quotes") {
      return Response.json({
        quotes: [{ t: new Date(start + 400).toISOString(), bp: 500.02, ap: 500.04, bs: 14, as: 15 }],
      });
    }
    return Response.json({ trades: [
      { t: new Date(start + 150).toISOString(), p: 500.01, s: 2 },
      { t: new Date(start + 350).toISOString(), p: 500.02, s: 3 },
    ] });
  };
  const client = new AlpacaStockHistoryRestClient({
    apiKey: "key",
    apiSecret: "secret",
    timeZone: "America/New_York",
    baseUrl: "https://example.test",
    fetchImpl,
  });

  const events = [];
  for await (const batch of client.streamStockEvents("QQQ", start, start + 1_000, 250, 2)) {
    events.push(...batch);
  }

  assert.deepEqual(events.map((event) => [event.type, event.providerTimestamp - start]), [
    ["stock_quote", 100],
    ["stock_trade", 150],
    ["stock_trade", 350],
    ["stock_quote", 400],
  ]);
  assert.ok(events.every((event) => event.symbol === "QQQ" && event.marketDate === "2026-08-12"));
  assert.equal(requested.filter((url) => url.pathname.endsWith("/quotes")).length, 2);
  assert.equal(requested.filter((url) => url.pathname.endsWith("/trades")).length, 1);
  assert.ok(requested.every((url) => url.searchParams.get("feed") === "sip"));
  const quoteRequests = requested.filter((url) => url.pathname.endsWith("/quotes"));
  assert.equal(quoteRequests[1]?.searchParams.get("page_token"), "quotes-2");
});
