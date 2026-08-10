import test from "node:test";
import assert from "node:assert/strict";
import { adaptAlpacaStockQuote, adaptAlpacaStockTrade } from "../src/alpaca/stockStream.js";
import { adaptAlpacaOptionQuote, AlpacaOptionWebSocket } from "../src/alpaca/optionStream.js";
import { AlpacaTradingRestClient } from "../src/alpaca/restClient.js";
import { OptionBook } from "../src/options/optionBook.js";
import { decode, encode } from "@msgpack/msgpack";
import { WebSocketServer, type RawData } from "ws";
import type { AddressInfo } from "node:net";
import type { OptionQuote } from "../src/types.js";

test("Alpaca market-data boundary maps official compact schemas", () => {
  const time = "2026-07-22T14:30:00.123456789Z";
  const quote = adaptAlpacaStockQuote({ T: "q", S: "SPY", t: time, bp: 500, ap: 500.01, bs: 10, as: 12, bx: "P", ax: "Q", c: ["R"] });
  assert.equal(quote.symbol, "SPY");
  assert.equal(quote.bidExchange, "P");
  assert.deepEqual(quote.conditions, ["R"]);
  const trade = adaptAlpacaStockTrade({ T: "t", S: "SPY", t: time, p: 500.01, s: 25, x: "D", c: ["@"] });
  assert.equal(trade.exchange, "D");
  const option = adaptAlpacaOptionQuote({
    T: "q", S: "SPY260724C00500000", t: time, bp: 1, ap: 1.02, bs: 20, as: 30,
    bx: "C", ax: "H", c: "B",
  });
  assert.equal(option.askPrice, 1.02);
  assert.ok(Number.isFinite(option.timestamp));
  assert.equal(option.bidExchange, "C");
  assert.deepEqual(option.conditions, ["B"]);
  const msgpackOption = adaptAlpacaOptionQuote({
    T: "q", S: "SPY260724C00500000", t: new Date(time), bp: 1, ap: 1.02, bs: 20, as: 30,
  });
  assert.equal(msgpackOption.timestamp, Date.parse(time));
});

test("OPRA subscription updates wait for each full-state acknowledgement", async (context) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  context.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const subscriptions = new Set<string>();
  const actions: Array<{ action: string; quotes: string[] }> = [];
  let dynamicAcknowledgementPending = false;
  let overlappingUpdates = false;
  server.on("connection", (socket) => {
    socket.on("message", (raw: RawData) => {
      const message = decode(new Uint8Array(raw as Buffer)) as Record<string, unknown>;
      if (message.action === "auth") {
        socket.send(encode([{ T: "success", msg: "authenticated" }]));
        return;
      }
      const action = String(message.action);
      const quotes = Array.isArray(message.quotes)
        ? message.quotes.filter((symbol): symbol is string => typeof symbol === "string")
        : [];
      actions.push({ action, quotes });
      for (const symbol of quotes) {
        if (action === "subscribe") subscriptions.add(symbol);
        else if (action === "unsubscribe") subscriptions.delete(symbol);
      }
      const snapshot = [...subscriptions].sort();
      const acknowledge = (): void => {
        dynamicAcknowledgementPending = false;
        socket.send(encode([{ T: "subscription", quotes: snapshot }]));
      };
      if (actions.length === 1) acknowledge();
      else {
        if (dynamicAcknowledgementPending) overlappingUpdates = true;
        dynamicAcknowledgementPending = true;
        setTimeout(acknowledge, 20);
      }
    });
  });

  const port = (server.address() as AddressInfo).port;
  const stream = new AlpacaOptionWebSocket({
    apiKey: "key",
    apiSecret: "secret",
    feed: "opra",
    url: `ws://127.0.0.1:${port}`,
    connectTimeoutMs: 1_000,
  });
  const errors: unknown[] = [];
  const snapshots: string[][] = [];
  await stream.subscribe(["SPY260727C00640000", "SPY260727P00640000"]);
  await stream.connect({
    onQuote: () => undefined,
    onError: (error) => errors.push(error),
    onSubscriptions: (symbols) => snapshots.push([...symbols].sort()),
  });
  await Promise.all([
    stream.unsubscribe(["SPY260727C00640000"]),
    stream.subscribe(["SPY260727C00641000"]),
  ]);

  assert.equal(overlappingUpdates, false);
  assert.deepEqual(actions.map(({ action }) => action), ["subscribe", "unsubscribe", "subscribe"]);
  assert.deepEqual(actions[1]?.quotes, ["SPY260727C00640000"]);
  assert.deepEqual(actions[2]?.quotes, ["SPY260727C00641000"]);
  assert.deepEqual([...subscriptions].sort(), ["SPY260727C00641000", "SPY260727P00640000"]);
  assert.deepEqual(snapshots.at(-1), ["SPY260727C00641000", "SPY260727P00640000"]);
  assert.deepEqual(errors, []);
  await stream.close();
});

test("OPRA backpressure keeps only the newest pending quote per contract", async (context) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  context.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const symbols = ["SPY260727C00640000", "SPY260727P00640000"];
  server.on("connection", (socket) => {
    socket.on("message", (raw: RawData) => {
      const message = decode(new Uint8Array(raw as Buffer)) as Record<string, unknown>;
      if (message.action === "auth") {
        socket.send(encode([{ T: "success", msg: "authenticated" }]));
      } else if (message.action === "subscribe") {
        socket.send(encode([{ T: "subscription", quotes: symbols }]));
      }
    });
  });

  const batches: OptionQuote[][] = [];
  const rawObservationProviderTimes: number[] = [];
  const rawObservationReceiveTimes: number[] = [];
  const rawObservationConnectionIds: number[] = [];
  const rawObservationSubscriptionSizes: number[] = [];
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  let markSecondFinished!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const secondFinished = new Promise<void>((resolve) => { markSecondFinished = resolve; });
  const port = (server.address() as AddressInfo).port;
  const stream = new AlpacaOptionWebSocket({
    apiKey: "key", apiSecret: "secret", feed: "opra",
    url: `ws://127.0.0.1:${port}`, connectTimeoutMs: 1_000,
  });
  await stream.subscribe(symbols);
  await stream.connect({
    onQuote: () => undefined,
    onQuoteObservations: (observations) => {
      rawObservationProviderTimes.push(...observations.map((observation) => observation.quote.timestamp));
      rawObservationReceiveTimes.push(...observations.map((observation) => observation.receiveWallTimestamp));
      rawObservationConnectionIds.push(...observations.flatMap((observation) =>
        observation.websocketConnectionId === undefined ? [] : [observation.websocketConnectionId]));
      rawObservationSubscriptionSizes.push(...observations.map((observation) =>
        observation.subscriptionSymbols?.length ?? 0));
    },
    onQuotes: async (quotes) => {
      batches.push(quotes.map((quote) => ({ ...quote })));
      if (batches.length === 1) {
        markFirstStarted();
        await firstGate;
      } else {
        markSecondFinished();
      }
    },
  });
  const socket = [...server.clients][0]!;
  const send = (symbol: string, timestamp: string, bidPrice: number): void => {
    socket.send(encode([{
      T: "q", S: symbol, t: timestamp,
      bp: bidPrice, ap: bidPrice + 0.02, bs: 10, as: 12,
    }]));
  };
  socket.send(encode([
    { T: "q", S: symbols[0], t: "2026-07-22T14:29:59.900Z", bp: 0.99, ap: 1.01, bs: 10, as: 12 },
    { T: "q", S: symbols[0], t: "2026-07-22T14:30:00.000Z", bp: 1, ap: 1.02, bs: 10, as: 12 },
  ]));
  await firstStarted;
  send(symbols[0]!, "2026-07-22T14:30:00.100Z", 1.01);
  send(symbols[1]!, "2026-07-22T14:30:00.150Z", 2);
  send(symbols[0]!, "2026-07-22T14:30:00.200Z", 1.02);
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseFirst();
  await Promise.race([
    secondFinished,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("coalesced batch timeout")), 1_000)),
  ]);

  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0]?.map((quote) => [quote.symbol, quote.bidPrice]), [[symbols[0], 1]]);
  assert.deepEqual(batches[1]?.map((quote) => [quote.symbol, quote.bidPrice]), [
    [symbols[1], 2],
    [symbols[0], 1.02],
  ]);
  assert.equal(rawObservationProviderTimes.length, 5);
  assert.ok(rawObservationProviderTimes.every(Number.isFinite));
  assert.ok(rawObservationReceiveTimes.every(Number.isFinite));
  assert.deepEqual(new Set(rawObservationConnectionIds), new Set([1]));
  assert.ok(rawObservationSubscriptionSizes.every((size) => size === 2));
  await stream.close();
});

test("concrete Alpaca REST adapter uses paper-safe v2 option/order/account mappings", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith("/v2/account")) return json({
      equity: "100000", options_buying_power: "25000", status: "ACTIVE", options_approved_level: 2,
      trading_blocked: false, account_blocked: false,
    });
    if (url.endsWith("/v2/clock")) return json({ timestamp: "2026-07-22T14:30:00Z", is_open: true });
    if (url.includes("/v2/stocks/SPY/quotes/latest?feed=sip")) return json({ symbol: "SPY", quote: {
      t: "2026-07-22T14:30:00Z", bp: 500, ap: 500.01, bs: 100, as: 120, bx: "P", ax: "Q",
    } });
    if (url.includes("/v2/options/contracts?")) return json({ option_contracts: [{
      symbol: "SPY260722C00500000", underlying_symbol: "SPY", expiration_date: "2026-07-22",
      strike_price: "500", type: "call", tradable: true, status: "active", open_interest: "1000",
    }] });
    if (url.includes("/v1beta1/options/snapshots?")) return json({ snapshots: {
      SPY260722C00500000: { latestQuote: { t: "2026-07-22T14:30:00Z" }, impliedVolatility: 0.2,
        greeks: { delta: 0.52, gamma: 0.03, theta: -0.1, vega: 0.02 }, dailyBar: { v: 500 } },
    } });
    if (url.includes("/v1beta1/options/quotes/latest?")) return json({ quotes: {
      SPY260722C00500000: {
        t: "2026-07-22T14:30:00Z", bp: 1, ap: 1.02, bs: 10, as: 12,
      },
    } });
    if (url.endsWith("/v2/orders") && init?.method === "POST") return json({
      id: "broker-id", client_order_id: "client-id", symbol: "SPY260722C00500000",
      status: "new", filled_qty: "0", filled_avg_price: null,
    });
    if (url.includes("/v2/orders:by_client_order_id?")) return json({
      id: "broker-id", client_order_id: "client-id", symbol: "SPY260722C00500000",
      status: "new", filled_qty: "0", filled_avg_price: null,
    });
    if (url.endsWith("/v2/orders/broker-id") && !init?.method) return json({
      id: "broker-id", client_order_id: "client-id", symbol: "SPY260722C00500000",
      status: "partially_filled", filled_qty: "1", filled_avg_price: "1.02",
    });
    if (url.includes("/v2/orders/broker-id") && init?.method === "PATCH") return json({
      id: "broker-id-2", client_order_id: "client-id", symbol: "SPY260722C00500000",
      status: "new", filled_qty: "1", filled_avg_price: "1.02",
    });
    if (url.includes("/v2/orders/broker-id") && init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url.includes("/v2/orders?status=open")) return json([]);
    if (url.endsWith("/v2/positions")) return json([{ symbol: "SPY260722C00500000", qty: "1", avg_entry_price: "1.02" }]);
    return new Response("missing mock", { status: 404, headers: { "x-request-id": "request-id" } });
  }) as typeof fetch;
  const client = new AlpacaTradingRestClient({
    apiKey: "key", apiSecret: "secret", fetch: mockFetch,
    optionFeed: "opra",
    now: () => Date.parse("2026-07-22T14:30:00Z"),
  });
  assert.deepEqual(await client.getAccount(), {
    equity: 100000, optionBuyingPower: 25000, active: true, optionsApproved: true, killSwitch: false,
  });
  assert.equal((await client.getMarketClock()).isOpen, true);
  assert.equal((await client.getLatestSpySipQuote()).symbol, "SPY");
  const contracts = await client.listOptionContracts();
  assert.equal(contracts[0]!.openInterest, 1000);
  const snapshots = await client.getOptionSnapshots([contracts[0]!.symbol]);
  assert.equal(snapshots[0]!.greeks?.delta, 0.52);
  assert.deepEqual(await client.getLatestOptionQuotes([contracts[0]!.symbol]), [{
    symbol: contracts[0]!.symbol,
    timestamp: Date.parse("2026-07-22T14:30:00Z"),
    bidPrice: 1,
    askPrice: 1.02,
    bidSize: 10,
    askSize: 12,
  }]);
  const book = new OptionBook();
  book.upsertContract(contracts[0]!);
  book.updateSnapshot(snapshots[0]!);
  assert.equal(book.get(contracts[0]!.symbol)!.snapshot!.openInterest, 1000);
  const order = await client.submitOrder({
    clientOrderId: "client-id", symbol: contracts[0]!.symbol, side: "buy", quantity: 1, limitPrice: 1.02, timeInForce: "day",
  });
  assert.equal(order.status, "new");
  assert.equal((await client.getOrder("broker-id")).filledQuantity, 1);
  assert.equal((await client.getOrderByClientOrderId("client-id")).id, "broker-id");
  assert.equal((await client.replaceOrder("broker-id", 1.03)).averageFillPrice, 1.02);
  await client.cancelOrder("broker-id");
  assert.deepEqual(await client.listOpenOrders(), []);
  assert.equal((await client.listPositions())[0]!.direction, "BULLISH");
  assert.ok(requests.every((request) => request.init?.headers !== undefined));
  const body = JSON.parse(String(requests.find((request) => request.init?.method === "POST")!.init!.body)) as Record<string, unknown>;
  assert.deepEqual(body, { symbol: contracts[0]!.symbol, side: "buy", qty: "1", type: "limit", time_in_force: "day",
    limit_price: "1.02", client_order_id: "client-id", extended_hours: false });
  const contractRequest = new URL(requests.find((request) => request.url.includes("/v2/options/contracts?"))!.url);
  assert.equal(contractRequest.searchParams.get("expiration_date_gte"), "2026-07-22");
  assert.equal(contractRequest.searchParams.get("expiration_date_lte"), "2026-07-22");
  const latestOptionQuoteRequest = new URL(
    requests.find((request) => request.url.includes("/v1beta1/options/quotes/latest?"))!.url,
  );
  assert.equal(latestOptionQuoteRequest.searchParams.get("feed"), "opra");
  assert.equal(latestOptionQuoteRequest.searchParams.get("symbols"), contracts[0]!.symbol);
  await assert.rejects(() => client.submitOrder({
    clientOrderId: "stock-order", symbol: "SPY", side: "buy", quantity: 1, limitPrice: 500, timeInForce: "day",
  }), /NOT_OCC_OPTION_SYMBOL/);
  await assert.rejects(() => client.submitOrder({
    clientOrderId: "future-option", symbol: "SPY260724C00500000", side: "buy", quantity: 1, limitPrice: 1, timeInForce: "day",
  }), /NOT_SAME_DAY_EXPIRATION/);
  await assert.rejects(() => client.cancelOrder("unvalidated-stock-order-id"), /not validated as a same-day SPY option/);
  assert.equal(requests.some((request) => request.url.endsWith("/v2/orders/unvalidated-stock-order-id")), false);
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
