# SPY Options Intraday Trend Engine

A deterministic TypeScript implementation of the attached **SPY Options Intraday Trend System** baseline. SPY top-of-book and trades are read-only signal inputs; the engine never submits an order for SPY shares. Every executable instrument must be an OCC-formatted SPY call or put expiring on the current New York market date (0DTE).

The package includes quote sanitization, one-second median aggregation, robust endpoint quadratic regression, a constant-acceleration Kalman alternative, normalized 10/30/120-second features, OFI, VWAP/opening-range state, time-of-day calibration, regime and impulse/grind logic, Black–Scholes/IV fallback, delta-adjusted option costs, universe ranking, risk/exit mathematics, an order state machine, deterministic replay, statistics, and audit events.

## Safety

This is research software, not investment advice. It defaults to paper mode. Live submission must be supplied by a broker adapter and explicitly enabled; this repository does not silently place real orders.

The option-only/day-only constraints are enforced at the contract-universe, selector, order-state, filled-position, and broker REST boundaries. New entries stop at the configured 0DTE cutoff (14:30 ET by default), all broker orders use `time_in_force=day`, and open positions receive a mandatory marketable-limit exit at 15:50 ET—before same-day expiration. A stock symbol, non-SPY option, or later-dated SPY option is rejected before submission.

## Run

```bash
npm install
npm test
npm run typecheck
npm run demo -- /tmp/spy-demo.jsonl
npm run backtest -- /tmp/spy-demo.jsonl
```

Configuration lives in [`config/default.json`](config/default.json). Calibration profiles must contain only sessions strictly before the replayed session.

## What is implemented

- Strict quote validation, rolling 99th-percentile/fixed size winsorization, duplicate and sequence checks.
- Completed-second median quote aggregation, raw Level-I OFI, trade VWAP/volume, qualified empty-second forward fills, and stale ages.
- Causal endpoint quadratic regression on log microprice with exponential half-life weights, Huber IRLS, weighted R², MAD, slope uncertainty, and 10/30/120-second normalized state. The separately versioned constant-acceleration Kalman filter is included for A/B research.
- Realized movement, efficiency, sign changes, EWMA pressure, session/rolling/anchored VWAP, opening range, gap, breakout/retest memory, five-minute historical calibration, and strict anti-leakage fallback behavior.
- Ordered regime classification plus symmetric impulse/grind decisions, capped physical projection, entry-time/cooldown gates, and complete signal vote audit data.
- Independent option quote/snapshot storage, strict same-day SPY OCC validation, bounded 0DTE subscription universe, Black–Scholes Greeks and IV bisection, liquidity filters, delta-adjusted cost gate, gamma diagnostic, and the specified candidate score.
- Account/risk/premium/buying-power sizing caps, fill-price stop/target reset, daily ET limits, partial-fill exposure reconciliation, priority exits, trailing/high-water logic, and trend grace periods.
- Tick-aware limit pricing, replacement/cancel timers, deterministic IDs/state, optimistic midpoint-touch, conservative, and queue replay models, plus restart reconciliation interfaces.
- Broker-backed serialized order management with deterministic submission recovery, cumulative partial-fill reconciliation, actual-fill stop/target resets, passive-to-aggressive entry replacement, hard-stop/trailing/kill-switch exits, and persistent marketable 15:50 liquidation.
- Arrival-order JSONL replay through the live modules, full audit events, signal funnel/rejections, trade/execution/prediction statistics, walk-forward folds, purge/embargo, and session bootstrap helpers.

## Replay data

Events are JSON Lines in arrival order. The outer `timestamp` controls replay order; embedded provider timestamps remain available for quote-age checks.

```json
{"type":"stock_quote","timestamp":1710000000000,"data":{"symbol":"SPY"}}
{"type":"stock_trade","timestamp":1710000000100,"data":{"symbol":"SPY"}}
{"type":"option_contract","timestamp":1710000000200,"data":{}}
{"type":"option_quote","timestamp":1710000000300,"data":{}}
{"type":"option_snapshot","timestamp":1710000000400,"data":{}}
{"type":"prior_close","timestamp":1710000000500,"data":{"symbol":"SPY","close":500}}
```

Replay fails immediately if timestamps decrease and never substitutes a future option quote. Supported fill models are `conservative`, `midpoint-touch`, and `queue`:

```bash
npm run backtest -- events.jsonl conservative calibration.json
```

Calibration consumes either raw feature snapshots or `decision_snapshot` audit lines:

```bash
npm run calibrate -- features.jsonl 2026-01-02 2026-03-31 data-v1 > calibration.json
```

## Live integration boundary

`src/alpaca/` includes authenticated Alpaca stock JSON streaming, option MsgPack streaming, paper/live REST selection, contract/snapshot pagination, whole-contract option orders, and broker reconciliation without embedding credentials or silently enabling real orders. A deployment wires these adapters through `SerializedDecisionQueue`, records every decision, and exposes `/live` and `/ready`. Unknown broker state must halt and reconcile. `src/main.ts` deliberately refuses implicit live startup even if environment flags are set.

`LiveOrderManager` is the broker-backed execution boundary. Call `initialize()` before accepting signals, `submitEntry()` only with an eligible selector result and fresh option quote, and `tick()` on each option quote/timer to poll fills and enforce exits. Paper mode remains the default. The manager cannot guarantee profit; its purpose is deterministic execution, bounded risk, profit protection, and safe failure behavior.

Feed entitlements, provider schemas, broker permissions, fees, latency, and fill behavior must be validated in paper trading before any live promotion.
