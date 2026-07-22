# SPY Options Intraday Trend Engine

A deterministic TypeScript implementation of the attached **SPY Options Intraday Trend System** baseline. SPY top-of-book and trades are read-only signal inputs; the engine never submits an order for SPY shares. Every executable instrument must be an OCC-formatted SPY call or put expiring on the current New York market date (0DTE).

The package includes quote sanitization, one-second median aggregation, robust endpoint quadratic regression, a constant-acceleration Kalman alternative, normalized 10/30/120-second features, OFI, VWAP/opening-range state, time-of-day calibration, regime and impulse/grind logic, Black–Scholes/IV fallback, delta-adjusted option costs, universe ranking, risk/exit mathematics, an order state machine, deterministic replay, statistics, and audit events.

## Safety

This is research software, not investment advice. It defaults to paper mode. Live submission must be supplied by a broker adapter and explicitly enabled; this repository does not silently place real orders.

The option-only/day-only constraints are enforced at the contract-universe, selector, order-state, filled-position, and broker REST boundaries. New entries stop at the configured 0DTE cutoff (14:30 ET by default), bullish impulse entries stop after 13:00 ET, and bullish impulse candidates require causal directional follow-through observed 5–15 seconds later. The broader all-entry confirmation profile is evaluated only as nested shadow audit data and cannot reach option selection or order submission. The default daily entry cap is six and is restored from durable fills across restarts. Unproductive new positions can scratch during their first 30 seconds only when the option has not moved favorably and SPY has reversed. All broker orders use `time_in_force=day`, and open positions receive a mandatory marketable-limit exit at 15:50 ET—before same-day expiration. A stock symbol, non-SPY option, or later-dated SPY option is rejected before submission.

## Run

```bash
npm install
npm test
npm run typecheck
npm run demo -- /tmp/spy-demo.jsonl
npm run backtest -- /tmp/spy-demo.jsonl
npm run test:historical -- 2026-07-21 iex
```

Configuration lives in [`config/default.json`](config/default.json). Calibration profiles must contain only sessions strictly before the replayed session. The historical signal test reports a `guardComparison` block that evaluates immediate entry, bullish-impulse confirmation, all-impulse confirmation, and all-entry confirmation on the same downloaded tape; its forward returns are research labels and never enter the causal signal decision.

## Docker

Build and start the paper-safe runtime with Docker Compose:

```bash
docker-compose up --build -d
docker-compose ps
curl http://127.0.0.1:3001/live
curl http://127.0.0.1:3001/ready
docker-compose logs -f spy-options-engine
```

Compose reads broker credentials from the local `.env` file at runtime and never copies that file into the image. It forces `TRADING_MODE=paper`, enables broker-backed paper orders, consumes SPY quotes/trades from SIP, and consumes executable option quotes from OPRA. It also starts PostgreSQL on the private Compose network; the database port is not exposed publicly. `/live` reports process liveness. `/ready` returns 200 only after PostgreSQL, both WebSocket feeds, paper account/options approval, and broker reconciliation are healthy. The Alpaca account must have real-time SIP and OPRA entitlement. Set `ENABLE_LIVE_ORDERS=false` to receive SIP without submitting paper orders; set `MARKET_DATA_ENABLED=false` as well for paper-idle mode. Readiness remains degraded in either reduced mode.

The image is multi-stage, runs as the unprivileged Node user, has a read-only root filesystem in Compose, and does not copy `.env`, credentials, replay data, tests, or development dependencies into the runtime image.

Stop the service without removing application source or local data:

```bash
docker-compose down
```

Do not add `-v` unless you intentionally want to delete the PostgreSQL history volume.

## Trading dashboard and PostgreSQL history

Open the read-only dashboard at:

```text
http://127.0.0.1:3001/dashboard
```

The browser polls `/api/dashboard` once per second. It shows every signal entry fired, candidate-selection/order status, broker-confirmed fills, open and completed option trades, realized P&L, win rate, average trade, and profit factor. Dashboard state is reconstructed from PostgreSQL after a service restart.

PostgreSQL persists two indexed histories in the named `spy-options-postgres` volume:

- `market_events`: raw SPY SIP quotes/trades, subscribed OPRA option quotes, option contracts/snapshots, and generated feature snapshots. High-rate records are inserted in batches so quote handling is not blocked by one SQL round trip per event.
- `audit_events`: signals, selection results, risk decisions, order requests/states/replacements, fills, exits, reconciliation, and execution halts. Critical execution events are inserted durably before processing continues.

Set a strong `POSTGRES_PASSWORD` in `.env` before non-local deployment. Raw OPRA history can be large; monitor the Docker volume and back it up according to your retention requirements.

Export one market date into the engine's replay JSONL format, then backtest it:

```bash
docker-compose exec -T spy-options-engine \
  node dist/src/cli/exportPostgresReplay.js 2026-07-22 > spy-2026-07-22.jsonl
npm run backtest -- spy-2026-07-22.jsonl conservative
```

Create a database backup without stopping the engine:

```bash
docker-compose exec -T postgres pg_dump -U spy_options spy_options > spy-options-history.sql
```

To replay a mounted event file using the same production image:

```bash
docker build -t spy-options-engine:local .
docker run --rm --read-only -v "$PWD/replay-output:/data:ro" \
  spy-options-engine:local node dist/src/cli/backtest.js /data/events.jsonl conservative
```

## What is implemented

- Strict quote validation, rolling 99th-percentile/fixed size winsorization, duplicate and sequence checks.
- Completed-second median quote aggregation, raw Level-I OFI, trade VWAP/volume, qualified empty-second forward fills, and stale ages.
- Causal endpoint quadratic regression on log microprice with exponential half-life weights, Huber IRLS, weighted R², MAD, slope uncertainty, and 10/30/120-second normalized state. The separately versioned constant-acceleration Kalman filter is included for A/B research.
- Realized movement, efficiency, sign changes, EWMA pressure, session/rolling/anchored VWAP, opening range, gap, breakout/retest memory, five-minute historical calibration, and strict anti-leakage fallback behavior.
- Ordered regime classification plus symmetric impulse/grind decisions, capped physical projection, scoped causal 5–15 second follow-through with an all-entry shadow profile, the 13:00 bullish-impulse/14:30 global cutoffs, entry cooldown gates, and complete signal vote audit data.
- Independent option quote/snapshot storage, strict same-day SPY OCC validation, bounded 0DTE subscription universe, Black–Scholes Greeks and IV bisection, liquidity filters, delta-adjusted cost gate, gamma diagnostic, and the specified candidate score.
- Account/risk/premium/buying-power sizing caps, restart-continuous daily ET limits, fill-price stop/target reset, partial-fill exposure reconciliation, early scratch protection, priority exits, trailing/high-water logic, and trend grace periods.
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

`src/alpaca/` includes authenticated Alpaca stock JSON streaming, option MsgPack streaming, paper/live REST selection, contract/snapshot pagination, whole-contract option orders, and broker reconciliation without embedding credentials or silently enabling real-money orders. The Docker runtime wires SPY SIP quotes/trades through the feature and signal engine, selects only same-day SPY options using OPRA quotes, and routes eligible entries and protective exits to Alpaca paper trading. Unknown broker state halts execution. `src/main.ts` still refuses real-money `TRADING_MODE=live`; enabling that mode requires a separate, explicit promotion.

`LiveOrderManager` is the broker-backed execution boundary. Call `initialize()` before accepting signals, `submitEntry()` only with an eligible selector result and fresh option quote, and `tick()` on each option quote/timer to poll fills and enforce exits. Paper mode remains the default. The manager cannot guarantee profit; its purpose is deterministic execution, bounded risk, profit protection, and safe failure behavior.

Feed entitlements, provider schemas, broker permissions, fees, latency, and fill behavior must be validated in paper trading before any live promotion.
