import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type RawData } from "ws";
import {
  adaptMassiveOptionQuote, fromMassiveOptionTicker, MassiveOptionWebSocket, toMassiveOptionTicker,
} from "../src/massive/optionStream.js";
import {
  MassiveOptionRestClient,
} from "../src/massive/restClient.js";
import type { OptionQuote } from "../src/types.js";

test("Massive OPRA adapters normalize provider tickers, timestamps, and exchanges", () => {
  const symbol = "SPY260811C00640000";
  assert.equal(toMassiveOptionTicker(symbol), `O:${symbol}`);
  assert.equal(fromMassiveOptionTicker(`O:${symbol}`), symbol);
  assert.deepEqual(adaptMassiveOptionQuote({
    ev: "Q", sym: `O:${symbol}`, t: 1_786_468_200_123,
    bp: 1, ap: 1.02, bs: 20, as: 30, bx: 302, ax: 303,
  }), {
    symbol,
    timestamp: 1_786_468_200_123,
    bidPrice: 1,
    askPrice: 1.02,
    bidSize: 20,
    askSize: 30,
    bidExchange: "302",
    askExchange: "303",
  });
  assert.throws(() => fromMassiveOptionTicker(symbol), /O: prefix/);
});

test("Massive OPRA WebSocket authenticates and serializes subscription updates", async (context) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  context.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const call = "SPY260811C00640000";
  const put = "SPY260811P00640000";
  const nextCall = "SPY260811C00641000";
  const actions: Array<{ action: string; params: string }> = [];
  let updatePending = false;
  let updatesOverlapped = false;
  server.on("connection", (socket) => {
    socket.send(JSON.stringify([{ ev: "status", status: "connected", message: "Connected Successfully" }]));
    socket.on("message", (data: RawData) => {
      const message = JSON.parse(data.toString()) as { action: string; params: string };
      actions.push(message);
      if (message.action === "auth") {
        socket.send(JSON.stringify([{ ev: "status", status: "auth_success", message: "authenticated" }]));
        return;
      }
      const acknowledge = (): void => {
        updatePending = false;
        const verb = message.action === "subscribe" ? "subscribed" : "unsubscribed";
        socket.send(JSON.stringify([{ ev: "status", status: "success", message: `${verb} to: ${message.params}` }]));
      };
      if (actions.length <= 2) acknowledge();
      else {
        if (updatePending) updatesOverlapped = true;
        updatePending = true;
        setTimeout(acknowledge, 20);
      }
    });
  });

  const port = (server.address() as AddressInfo).port;
  const stream = new MassiveOptionWebSocket({
    apiKey: "massive-key",
    url: `ws://127.0.0.1:${port}`,
    connectTimeoutMs: 1_000,
  });
  const subscriptionSnapshots: string[][] = [];
  const observations: OptionQuote[] = [];
  let receivedQuote!: () => void;
  const quoteReceived = new Promise<void>((resolve) => { receivedQuote = resolve; });
  await stream.subscribe([call, put]);
  await stream.connect({
    onQuote: () => undefined,
    onQuotes: (quotes) => {
      observations.push(...quotes);
      receivedQuote();
    },
    onQuoteObservations: (items) => {
      assert.equal(items[0]?.subscriptionSymbols?.length, 2);
      assert.ok(Number.isFinite(items[0]?.receiveWallTimestamp));
    },
    onSubscriptions: (symbols) => subscriptionSnapshots.push([...symbols].sort()),
  });
  await Promise.all([
    stream.unsubscribe([call]),
    stream.subscribe([nextCall]),
  ]);
  const socket = [...server.clients][0]!;
  socket.send(JSON.stringify([{
    ev: "Q", sym: `O:${nextCall}`, t: Date.now(), bp: 1, ap: 1.02, bs: 10, as: 12, bx: 302, ax: 303,
  }]));
  await Promise.race([
    quoteReceived,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("quote timeout")), 1_000)),
  ]);

  assert.equal(updatesOverlapped, false);
  assert.deepEqual(actions.slice(1).map(({ action }) => action), ["subscribe", "unsubscribe", "subscribe"]);
  assert.equal(actions[1]?.params, `Q.O:${call},Q.O:${put}`);
  assert.equal(actions[2]?.params, `Q.O:${call}`);
  assert.equal(actions[3]?.params, `Q.O:${nextCall}`);
  assert.deepEqual(subscriptionSnapshots.at(-1), [nextCall, put].sort());
  assert.equal(observations[0]?.symbol, nextCall);
  await stream.close();
});

test("Massive option REST maps filtered real-time chain snapshots and diagnostic quotes", async () => {
  const call = "SPY260811C00640000";
  const put = "SPY260811P00640000";
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  const items = [
    massiveSnapshot(call, "call", 640, 1.00, 1.02, 0.52),
    massiveSnapshot(put, "put", 640, 0.98, 1.00, -0.48),
  ];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("authorization") });
    if (url.searchParams.has("cursor")) return json({ status: "OK", results: [items[1]] });
    return json({
      status: "OK",
      results: [items[0]],
      next_url: `${url.origin}${url.pathname}?cursor=next-page`,
    });
  }) as typeof fetch;
  const client = new MassiveOptionRestClient({
    apiKey: "massive-key",
    baseUrl: "https://api.massive.test",
    fetch: mockFetch,
    underlyings: ["SPY"],
  });

  const snapshots = await client.getOptionSnapshots([call, put]);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0], {
    symbol: call,
    timestamp: 1_786_468_200_123,
    impliedVolatility: 0.2,
    greeks: { delta: 0.52, gamma: 0.03, theta: -0.1, vega: 0.02 },
    dailyVolume: 500,
    openInterest: 1_000,
  });
  const quotes = await client.getLatestOptionQuotes([call, put]);
  assert.deepEqual(quotes[1], {
    symbol: put,
    timestamp: 1_786_468_200_123,
    bidPrice: 0.98,
    askPrice: 1,
    bidSize: 10,
    askSize: 12,
    bidExchange: "302",
    askExchange: "303",
  });
  assert.equal(requests[0]?.url.pathname, "/v3/snapshot/options/SPY");
  assert.equal(requests[0]?.url.searchParams.get("expiration_date"), "2026-08-11");
  assert.equal(requests[0]?.url.searchParams.get("strike_price.gte"), "640");
  assert.equal(requests[0]?.url.searchParams.get("strike_price.lte"), "640");
  assert.ok(requests.every((request) => request.authorization === "Bearer massive-key"));

  const delayedFetch = (async (): Promise<Response> => json({
    status: "OK",
    results: [{ ...items[0], last_quote: { ...(items[0]!.last_quote as object), timeframe: "DELAYED" } }],
  })) as typeof fetch;
  const delayed = new MassiveOptionRestClient({ apiKey: "key", fetch: delayedFetch, underlyings: ["SPY"] });
  await assert.rejects(() => delayed.getLatestOptionQuotes([call]), /non-real-time/);
});

function massiveSnapshot(
  symbol: string, contractType: "call" | "put", strike: number,
  bid: number, ask: number, delta: number,
): Record<string, unknown> {
  return {
    details: {
      ticker: `O:${symbol}`,
      contract_type: contractType,
      expiration_date: "2026-08-11",
      strike_price: strike,
    },
    implied_volatility: 0.2,
    greeks: { delta, gamma: 0.03, theta: -0.1, vega: 0.02 },
    day: { volume: 500 },
    open_interest: 1_000,
    last_quote: {
      bid,
      ask,
      bid_size: 10,
      ask_size: 12,
      bid_exchange: 302,
      ask_exchange: 303,
      last_updated: 1_786_468_200_123_456_789,
      timeframe: "REAL-TIME",
    },
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
