# SPY Options Intraday Trend Engine

A deterministic TypeScript implementation of the attached **SPY Options Intraday Trend System** baseline. SPY top-of-book and trades are read-only signal inputs; the engine never submits an order for SPY shares. Every executable instrument must be an OCC-formatted SPY call or put expiring on the current New York market date (0DTE).

The package includes quote sanitization, one-second median aggregation, robust endpoint quadratic regression, a constant-acceleration Kalman alternative, normalized 10/30/120-second features, OFI, VWAP/opening-range state, time-of-day calibration, regime and impulse/grind logic, Black–Scholes/IV fallback, delta-adjusted option costs, universe ranking, risk/exit mathematics, an order state machine, deterministic replay, statistics, and audit events.

## Safety

This is research software, not investment advice. It defaults to paper mode. Live submission must be supplied by a broker adapter and explicitly enabled; this repository does not silently place real orders.

The option-only/day-only constraints are enforced at the contract-universe, selector, order-state, filled-position, and broker REST boundaries. Every new entry order is hard-limited to exactly one option contract; the standard OCC 100-share contract multiplier remains unchanged for premium, risk, and P&L accounting. New entries stop at the configured 0DTE cutoff (14:30 ET by default). From 10:15 through 11:59:59 ET, the active paper path applies a static morning-entry guard: every entry must project at least 1.7 bps, retain at least 1.0 bps of modeled edge after option costs, and use an option spread no wider than 0.75%. Morning bullish grinds additionally require a `STRONG_UP` or `GRIND_UP` regime. Every morning setup also requires aligned SPY follow-through during a causal 5–20 second window. The aligned move must exceed both the configured minimum and 1.25 times the largest observed fast-window noise floor at arming and confirmation, so ordinary quote noise cannot masquerade as continuation while the longer ceiling preserves delayed larger winners. Beginning at 12:00 ET, the late-entry guard requires at least 2.0 projected bps, at least 1.25 bps of modeled post-cost edge, and an option spread no wider than 0.8%. Late unclassified bearish impulses must carry at least 40% as much normalized medium-window slope as fast-window slope, and late bullish grinds require at least 2.5 normalized medium-window slope, preventing isolated short bursts from becoming entries before trend persistence is established. A noisy bullish grind below a 1.25 medium/fast slope ratio joins the same second-stage option confirmation used by the low-noise profile. The experimental low-projection bullish-continuation profile is disabled in the production default, so it cannot bypass the static projected-move floor. Late setups, including qualifying bearish grinds, require directional follow-through during a causal 5–15 second window using the same noise-adjusted threshold; only sufficiently persistent unclassified bearish impulses before 13:00 ET and the narrowly qualified low-noise bullish-grind profile bypass that delay. A selected grind in the second-stage profile is not ordered immediately: for 2–10 seconds the runtime and replay engine monitor the same contract, require its bid to improve by at least $0.03, and revalidate bullish structure plus at least 0.5 projected bps. Every armed, pending, confirmed, and expired observation carries its monitoring timestamp in the audit/dashboard decision timeline. Late bearish `STRONG_DOWN` impulses retain a stricter minimum of 1.5 bps at the causal five-second check. After an actual fill, the existing 600-second same-direction cooldown remains active and a 60-second opposite-direction cooldown prevents immediate whipsaw reversals; rejected candidates do not start either cooldown. The active and late daily-entry ceilings remain at a high 1,000-entry emergency safety bound. The live audit evaluates bullish-impulse, all-impulse, and all-entry confirmation scopes side by side, and daily fill counts are restored across restarts for the active safety bound. All broker orders use `time_in_force=day`, and open positions receive a mandatory marketable-limit exit at 15:50 ET—before same-day expiration. A stock symbol, non-SPY option, or later-dated SPY option is rejected before submission.

Opposite-regime exits require persistence across at least three distinct feature observations for two seconds. This filters one-second classifier flicker without delaying hard-risk, stale-data, forced-session, or protected-profit exits.

After a profitable `PROFIT_FLOOR_EXIT` or confirmed `OPPOSITE_REGIME` exit, one same-direction re-entry may bypass the remaining 600-second cooldown. The exception waits 10 seconds, expires after 120 seconds, requires the matching `STRONG_UP` or `STRONG_DOWN` regime, and is consumed by the next fill.

Every replay result includes its strategy configuration version, fill model, calibration version, and explicit round-trip fee assumption so results from different code or execution assumptions are not compared as if they were equivalent.

## Run

```bash
npm install
npm test
npm run typecheck
npm run demo -- /tmp/spy-demo.jsonl
npm run backtest -- /tmp/spy-demo.jsonl
npm run test:historical -- 2026-07-21 iex
npm run verify:feature-regression -- 2026-07-22 2026-07-31
```

Configuration lives in [`config/default.json`](config/default.json). Calibration profiles must contain only sessions strictly before the replayed session. The historical signal test reports a `guardComparison` block that evaluates immediate entry, bullish-impulse confirmation, all-impulse confirmation, all-entry confirmation, and the static-projection-only baseline on the same downloaded tape; its forward returns are research labels and never enter the causal signal decision. The feature-regression command reads preserved PostgreSQL feature/OPRA history without modifying it and A/B checks continuation-dependent signals through the real option selector. Active morning and late state is recorded under `morningEntryGuard` and `lateEntryGuard` in live evaluation, signal-selection, and paper-submission audit payloads; failures use explicit `MORNING_ENTRY_*` and `LATE_ENTRY_*` reasons. `live_entry_evaluation.data.morningEntryBaseline` and `.lateEntryBaseline` expose the same non-executable evaluator with both active time guards disabled, preserving baseline candidates needed to measure guard impact. Confirmation-scope research remains available in `live_entry_evaluation.data.shadowEvaluations`.

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

When the broker clock reports the market closed, the trading runtime enters `market-closed-idle`: SIP and OPRA sockets are disconnected, option subscriptions are cleared, and market history, feature, signal, selection, risk, and order processing stop. The process, dashboard, PostgreSQL connection, and broker reconciliation remain available. A lightweight broker-clock check runs every 30 seconds so market data resumes automatically at the next open; `/ready` remains healthy while this intentional idle state is active.

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

The browser polls `/api/dashboard` once per second. It shows every signal entry fired, candidate-selection/order status, broker-confirmed fills, open and completed option trades, realized P&L, win rate, average trade, and profit factor. Dashboard state is reconstructed from PostgreSQL after a service restart. The SIP and OPRA cards use separate live receiver counters; the strategy card labels the SIP events restored once at startup. During an open session, 10 seconds without an OPRA quote across active subscriptions marks the option feed stalled, degrades readiness, blocks new entries, and triggers a reconnect.

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
- Ordered regime classification plus symmetric impulse/grind decisions, capped physical projection, simultaneous shadow A/B profiles for scoped causal 5–15 second follow-through, shadow 13:00 bullish-impulse/14:30 signal cutoffs, entry cooldown gates, and complete signal vote audit data.
- Independent option quote/snapshot storage, strict same-day SPY OCC validation, bounded 0DTE subscription universe, Black–Scholes Greeks and IV bisection, liquidity filters, delta-adjusted cost gate, gamma diagnostic, and the specified candidate score.
- Account/risk/premium/buying-power sizing caps, restart-continuous daily ET limits, conservative bid-based executable P&L, resettable soft-profit activation and breach confirmation, strengthened capped nondecreasing soft floors with an immediate break-even emergency boundary for confirmed protection, direct/recovered winner states, adverse-path-gated first-passage recovery probability, adaptive full-winner protected-profit floors, reversal evidence, recovery deadlines, and priority exits.
- Live and replay option-continuation LCBs using delta, gamma, vega, theta, IV change, physical SPY slope, executable spread cost, and observed P&L uncertainty; stale snapshots are excluded, negative estimates require persistence, and full winners use a shorter confirmation window to reduce late profit giveback.
- Tick-aware entry price ceilings and signal TTLs, urgency-dependent exit TTLs, marketable-limit ladders with collars, deterministic logical intent IDs, and replay fill models.
- Broker-backed serialized order management with deterministic submission recovery, cumulative partial-fill reconciliation, explicit `ENTRY_PENDING`/`OPEN_*`/`EXIT_PENDING`/`SAFE_MODE` lifecycle state, and exit intents that survive rejection, cancellation, and repricing until broker-confirmed flat.
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

`src/alpaca/` includes authenticated Alpaca stock JSON streaming, option MsgPack streaming, paper/live REST selection, contract/snapshot pagination, whole-contract option orders, and broker reconciliation without embedding credentials or silently enabling real-money orders. The Docker runtime wires SPY SIP quotes/trades through the feature and signal engine, selects only same-day SPY options using OPRA quotes, and routes eligible entries and protective exits to Alpaca paper trading. A narrowly defined late bullish reentry profile admits exceptionally clean, low-noise grinds after eight minutes without removing ordinary causal confirmation or the ten-minute cooldown from other setups. Unknown broker state halts execution. `src/main.ts` still refuses real-money `TRADING_MODE=live`; enabling that mode requires a separate, explicit promotion.

`LiveOrderManager` is the broker-backed execution boundary. Call `initialize()` before accepting signals, `submitEntry()` only with an eligible selector result and fresh option quote, and `tick()` on each option quote/timer to poll fills and enforce exits. Snapshots expose `FLAT`, `ENTRY_PENDING`, `OPEN_UNPROTECTED`, `PROTECTED_WINNER`, `PROTECTED_RECOVERED`, `EXIT_PENDING`, `CLOSED`, and `SAFE_MODE`. Soft protection requires sustained executable profit; trades recovering from a meaningful adverse excursion arm at $2, while clean developing trades retain the $3 threshold to avoid premature exits on ordinary quote noise. Clean direct winners promote to full winner protection at $10 of executable profit and retain a minimum $5 protected floor. Paper mode remains the default. The manager cannot guarantee profit; its purpose is deterministic execution, bounded risk, profit protection, and safe failure behavior.

Feed entitlements, provider schemas, broker permissions, fees, latency, and fill behavior must be validated in paper trading before any live promotion.
