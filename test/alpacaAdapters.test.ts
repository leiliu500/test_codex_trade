import test from "node:test";
import assert from "node:assert/strict";
import { adaptAlpacaStockQuote, adaptAlpacaStockTrade } from "../src/alpaca/stockStream.js";
import { adaptAlpacaOptionQuote } from "../src/alpaca/optionStream.js";
import { AlpacaTradingRestClient } from "../src/alpaca/restClient.js";
import { OptionBook } from "../src/options/optionBook.js";

test("Alpaca market-data boundary maps official compact schemas", () => {
  const time = "2026-07-22T14:30:00.123456789Z";
  const quote = adaptAlpacaStockQuote({ T: "q", S: "SPY", t: time, bp: 500, ap: 500.01, bs: 10, as: 12, bx: "P", ax: "Q", c: ["R"] });
  assert.equal(quote.symbol, "SPY");
  assert.equal(quote.bidExchange, "P");
  assert.deepEqual(quote.conditions, ["R"]);
  const trade = adaptAlpacaStockTrade({ T: "t", S: "SPY", t: time, p: 500.01, s: 25, x: "D", c: ["@"] });
  assert.equal(trade.exchange, "D");
  const option = adaptAlpacaOptionQuote({ T: "q", S: "SPY260724C00500000", t: time, bp: 1, ap: 1.02, bs: 20, as: 30 });
  assert.equal(option.askPrice, 1.02);
  assert.ok(Number.isFinite(option.timestamp));
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
    if (url.includes("/v2/options/contracts?")) return json({ option_contracts: [{
      symbol: "SPY260722C00500000", underlying_symbol: "SPY", expiration_date: "2026-07-22",
      strike_price: "500", type: "call", tradable: true, status: "active", open_interest: "1000",
    }] });
    if (url.includes("/v1beta1/options/snapshots?")) return json({ snapshots: {
      SPY260722C00500000: { latestQuote: { t: "2026-07-22T14:30:00Z" }, impliedVolatility: 0.2,
        greeks: { delta: 0.52, gamma: 0.03, theta: -0.1, vega: 0.02 }, dailyBar: { v: 500 } },
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
    now: () => Date.parse("2026-07-22T14:30:00Z"),
  });
  assert.deepEqual(await client.getAccount(), {
    equity: 100000, optionBuyingPower: 25000, active: true, optionsApproved: true, killSwitch: false,
  });
  assert.equal((await client.getMarketClock()).isOpen, true);
  const contracts = await client.listOptionContracts();
  assert.equal(contracts[0]!.openInterest, 1000);
  const snapshots = await client.getOptionSnapshots([contracts[0]!.symbol]);
  assert.equal(snapshots[0]!.greeks?.delta, 0.52);
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
