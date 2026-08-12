# SPY + QQQ + GOOGL Options Intraday Trend Engine

A deterministic TypeScript implementation of the attached **SPY Options Intraday Trend System** baseline with isolated QQQ and GOOGL paper-trading runtimes. SPY, QQQ, and GOOGL top-of-book and trades are read-only signal inputs; the engine never submits orders for underlying shares. Every executable instrument must be an OCC-formatted option for its runtime's underlying and expire on the current New York market date (0DTE).

The package includes quote sanitization, one-second median aggregation, robust endpoint quadratic regression, a constant-acceleration Kalman alternative, normalized 10/30/120-second features, OFI, VWAP/opening-range state, time-of-day calibration, regime and impulse/grind logic, Black–Scholes/IV fallback, delta-adjusted option costs, raw Massive OPRA option quote/trade/per-second aggregate microstructure, universe ranking, risk/exit mathematics, an adaptive order state machine, deterministic replay, statistics, and audit events.

## Safety

This is research software, not investment advice. It defaults to paper mode. Live submission must be supplied by a broker adapter and explicitly enabled; this repository does not silently place real orders.

The option-only/day-only constraints are enforced at the contract-universe, selector, order-state, filled-position, and broker REST boundaries. Every new entry order is hard-limited to exactly one option contract; the standard OCC 100-share contract multiplier remains unchanged for premium, risk, and P&L accounting. Each underlying can hold up to three independently managed positions in distinct OCC contracts, for a nine-position SPY/QQQ/GOOGL portfolio maximum; duplicate entries in an already-held OCC contract are rejected because Alpaca aggregates them into one broker position. New entries stop at the configured 0DTE cutoff (14:30 ET by default). From 10:15 through 11:59:59 ET, the active paper path applies a static morning-entry guard: every entry must project at least 1.7 bps, retain at least 1.0 bps of modeled edge after option costs, and use an option spread no wider than 0.75%. Morning bullish grinds additionally require a `STRONG_UP` or `GRIND_UP` regime. Every morning setup also requires aligned underlying follow-through during a causal 5–20 second window. The aligned move must exceed both the configured minimum and 1.25 times the largest observed fast-window noise floor at arming and confirmation, so ordinary quote noise cannot masquerade as continuation while the longer ceiling preserves delayed larger winners. Beginning at 12:00 ET, the late-entry guard requires at least 2.0 projected bps, at least 1.25 bps of modeled post-cost edge, and an option spread no wider than 0.8%. SPY alone has one narrower exception for a clean late bearish impulse: a 1.75–2.0 bps projection is accepted only when fast efficiency, fast/medium/slow bearish persistence, medium/slow fit, opening-range location, and impulse votes all pass their versioned thresholds. Only that profile may use at most a one-tick spread up to 1.2% and 0.7 bps of post-cost margin; every ordinary late setup retains the stricter limits. Its option must be no more than 2 seconds old when selected; after that causal check, a bounded 3-second submission ceiling prevents ordinary broker clock/account round trips from invalidating the already-qualified quote. Every other entry retains the 750 ms final-submission ceiling. When the closest directionally correct contract fails only transient quote, spread, option-flow, or spread-dependent cost checks, the runtime retries selection from live OPRA updates for at most one second and revalidates the same signal structure before submission; structural liquidity, delta, midpoint, and static projected-move failures are never retried. Late unclassified bearish impulses must carry at least 40% as much normalized medium-window slope as fast-window slope, and late bullish grinds require at least 2.5 normalized medium-window slope, preventing isolated short bursts from becoming entries before trend persistence is established. A noisy bullish grind below a 1.25 medium/fast slope ratio joins the same second-stage option confirmation used by the low-noise profile. The experimental low-projection bullish-continuation profile is disabled in the production default, so it cannot bypass the static projected-move floor. Late setups, including qualifying bearish grinds, require directional follow-through during a causal 5–15 second window using the same noise-adjusted threshold; only sufficiently persistent unclassified bearish impulses before 13:00 ET and the narrowly qualified low-noise bullish-grind profile bypass that delay. A selected grind in the second-stage profile is not ordered immediately: for 2–10 seconds the runtime and replay engine monitor the same contract, require its bid to improve by at least $0.03, and revalidate bullish structure plus at least 0.5 projected bps. Every armed, pending, confirmed, and expired observation carries its monitoring timestamp in the audit/dashboard decision timeline. Late bearish `STRONG_DOWN` impulses retain a stricter minimum of 1.5 bps at the causal five-second check. After an actual fill, the existing 600-second same-direction cooldown remains active and a 60-second opposite-direction cooldown prevents immediate whipsaw reversals; rejected candidates do not start either cooldown. The active and late daily-entry ceilings remain at a high 1,000-entry emergency safety bound. The live audit evaluates bullish-impulse, all-impulse, and all-entry confirmation scopes side by side, and daily fill counts are restored across restarts for the active safety bound. All broker orders use `time_in_force=day`, and open positions receive a mandatory marketable-limit exit at 15:50 ET—before same-day expiration. An underlying share, cross-underlying option, or later-dated option is rejected before submission.

SPY, QQQ, and GOOGL use separate feature engines, opening ranges, VWAPs, signals, cooldowns, option books, positions, and restoration state. They share one Alpaca SIP connection, one Massive OPRA connection, and one Alpaca broker account boundary. A portfolio coordinator atomically reserves aggregate option risk, premium, and buying power before any runtime can submit. QQQ and GOOGL have independent override files at [`config/qqq.json`](config/qqq.json) and [`config/googl.json`](config/googl.json). Both currently inherit the unchanged SPY parameter baseline and remain paper-validation configurations rather than claims that SPY calibration transfers to them. GOOGL remains idle on sessions where Alpaca reports no active, tradable same-day GOOGL contract; that expected empty universe does not degrade the other runtimes or permit a later-dated option.

Immediately before an entry reaches Alpaca, the execution boundary checks the broker clock again and rejects the order with `ENTRY_QUOTE_TOO_OLD` when the selected OPRA quote's provider timestamp is more than 750 ms old. Any portfolio reservation is released, while open-position stale-data exits retain their separate 10-second emergency threshold.

Massive advanced option flow is active in the production decision and paper-execution path; it is not a shadow evaluator. Every subscribed OCC contract requests `Q`, `T`, and per-second `A` channels. Raw events enter a bounded causal five-second engine before execution-quote coalescing, producing option OFI, depth imbalance, microprice, bid/premium momentum, spread expansion, trade-sign imbalance, trade/aggregate VWAP displacement, nearby-chain confirmation, and IV skew. Provider sequence numbers suppress duplicate or regressive Q/T observations. Documented OPRA cancel and late-report conditions are excluded from current flow, while cross and complex/stock-option package prints remain visible as neutral volume instead of being misclassified as single-leg buying or selling. Contract and chain scores can reject selection and are re-evaluated after delayed confirmation. Theta decay and adverse-vega allowance are included in modeled entry cost. While an entry works, reversed flow or spread expansion cancels it; positive flow increases entry aggression and shortens replacement TTL. Adverse held-option flow raises exit urgency. Fill slippage and 1/5/15-second adverse selection are durably audited. These controls default to enabled under `options.microstructure` and `execution` in every symbol configuration.

Opposite-regime exits require persistence across at least three distinct feature observations for two seconds. This filters one-second classifier flicker without delaying hard-risk, stale-data, forced-session, or protected-profit exits.

After a profitable `PROFIT_FLOOR_EXIT` or confirmed `OPPOSITE_REGIME` exit, one same-direction re-entry may bypass the remaining 600-second cooldown. The exception waits 10 seconds, expires after 120 seconds, requires the matching `STRONG_UP` or `STRONG_DOWN` regime, and is consumed by the next fill.

Every replay result includes its underlying, strategy configuration version, fill model, calibration version, and explicit round-trip fee assumption so results from different code or execution assumptions are not compared as if they were equivalent.

## Run

```bash
npm install
npm test
npm run typecheck
npm run demo -- /tmp/spy-demo.jsonl
npm run backtest -- /tmp/spy-demo.jsonl
npm run test:historical -- 2026-07-21 iex
npm run verify:feature-regression -- 2026-07-22 2026-07-31
npm run parity:live -- 2026-08-05 1785941487472
```

GOOGL's independent paper-validation overrides live in [`config/googl.json`](config/googl.json).

The SPY configuration lives in [`config/default.json`](config/default.json); QQQ's independent overrides live in [`config/qqq.json`](config/qqq.json). Calibration profiles must contain only sessions strictly before the replayed session. The historical signal test reports a `guardComparison` block that evaluates immediate entry, bullish-impulse confirmation, all-impulse confirmation, all-entry confirmation, and the static-projection-only baseline on the same downloaded tape; its forward returns are research labels and never enter the causal signal decision. The feature-regression command reads preserved PostgreSQL feature/OPRA history without modifying it and A/B checks continuation-dependent signals through the real option selector. Active morning and late state is recorded under `morningEntryGuard` and `lateEntryGuard` in live evaluation, signal-selection, and paper-submission audit payloads; failures use explicit `MORNING_ENTRY_*` and `LATE_ENTRY_*` reasons. `live_entry_evaluation.data.morningEntryBaseline` and `.lateEntryBaseline` expose the same non-executable evaluator with both active time guards disabled, preserving baseline candidates needed to measure guard impact. Confirmation-scope research remains available in `live_entry_evaluation.data.shadowEvaluations`.

## Docker

Build and start the paper-safe runtime with Docker Compose:

```bash
docker-compose up --build -d
docker-compose ps
curl http://127.0.0.1:3001/live
curl http://127.0.0.1:3001/ready
docker-compose logs -f spy-options-engine
```

Compose reads credentials from the local `.env` file at runtime and never copies that file into the image. It forces `TRADING_MODE=paper` and enables Alpaca-backed paper orders. `TRADING_SYMBOLS` controls the enabled subset; Compose defaults to `SPY,QQQ,GOOGL`, while the application library retains its paper-safe `SPY` default when the variable is omitted outside Compose. It also starts PostgreSQL on the private Compose network; the database port is not exposed publicly. `/live` reports process liveness. `/ready` returns 200 only after PostgreSQL, the required WebSocket feeds, paper account/options approval, and every enabled runtime's scoped broker reconciliation are healthy. A successful empty same-day contract query places that runtime in a healthy, non-trading idle state. The Alpaca account must have real-time SIP entitlement and `MASSIVE_API_KEY` must have Massive Options Advanced real-time OPRA access. `OPTION_DATA_PROVIDER=massive` is the default; `alpaca` remains available as an explicit fallback. Set `ENABLE_LIVE_ORDERS=false` to receive SIP without submitting paper orders; set `MARKET_DATA_ENABLED=false` as well for paper-idle mode. Readiness remains degraded in either reduced mode.

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

The browser polls `/api/dashboard` once per second. Its dashboard-scope selector provides exact `All portfolio`, `SPY only`, `QQQ only`, and `GOOGL only` views. Each per-symbol view has independent signal funnels, orders, trades, realized/open P&L, tuning statistics, missed-entry denominators, market-event counts, and runtime health; the selection is retained in the browser. Dashboard state is reconstructed from PostgreSQL after a service restart. The SIP and OPRA cards use separate live receiver counters; the strategy card labels the SIP events restored once at startup. The live OPRA boundary records wall-clock and monotonic arrival times before asynchronous processing, then coalesces queued execution updates to the newest quote per contract so repeated high-rate updates cannot create a stale local backlog. Runtime health distinguishes `NO_DATA`, `HEALTHY`, `CONTRACT_IDLE`, `OLD_EVENT_ARRIVED`, `PROVIDER_DELAYED`, and `TRANSPORT_DISCONNECTED`. A single inactive contract does not cause global reconnect churn: selection can rescan other fresh eligible contracts. Chain-wide provider delay requires at least four advancing observations on at least five active contracts, with at least 60% of diagnosable contracts delayed. Ten seconds of transport silence triggers a reconnect; provider delay permits only one diagnostic reconnect per market session. Every unsafe state remains fail-closed for new entries. `MARKET_DATA_CLOCK_OFFSET_MS` supplies one signed local-minus-provider wall-clock correction to both OPRA health and dashboard latency; leave it at `0` when chrony has synchronized the host. The dashboard retains raw provider/receive timestamps and shows the raw delta beside corrected latency whenever the offset is non-zero.

The dashboard's executable option-rejection review separates genuine tuning evidence from feed mirages. For every final `NO_ELIGIBLE_OPTION` result, the runtime durably records the closest candidate's decision-time bid/ask, corrected provider age, and freshness limit. A fresh candidate is evaluated at a causal 30-second horizon from the hypothetical ask entry to the first fresh executable bid; the dashboard labels it `PROFITABLE_MISS` or `CORRECT_REJECTION` and reports gross one-contract P&L before fees. Missing, stale, invalid, or horizon-missing quotes are labeled `NON_EXECUTABLE` and never inflate the profitable-miss rate.

Massive REST and Massive WebSocket are treated as the same OPRA provider path; Alpaca remains the execution broker and SIP source. When WebSocket health is inconclusive or an exact contract is idle, the runtime may issue one filtered Massive option-chain snapshot request for latest quotes as a diagnostic, but REST quotes never enter the executable option book, cannot restore readiness, and cannot manage an open position. Three consecutive stale, repeated, or failed diagnostics open a circuit breaker for 15 seconds; failed half-open probes back off to 30 seconds. A fresh diagnostic may trigger one bounded WebSocket probe, but only a newly received, provider-timestamped WebSocket quote can restore executable pricing. The dashboard exposes exact-symbol activity, chain delayed/fresh counts, arrival-lag statistics, repeated REST results, and circuit state separately from transport connectivity.

PostgreSQL persists two indexed histories in the named `spy-options-postgres` volume:

- `market_events`: raw SPY/QQQ/GOOGL SIP quotes/trades, subscribed OPRA option quotes/trades/per-second aggregates, option contracts/snapshots, and generated feature snapshots. High-rate records are inserted in batches so option-flow handling is not blocked by one SQL round trip per event.
- `audit_events`: signals, selection results, risk decisions, order requests/states/replacements, fills, exits, reconciliation, and execution halts. Critical execution events are inserted durably before processing continues.

Audit broker-backed order management without reselecting the entry or assuming an immediate fill:

```bash
npm run parity:live -- YYYY-MM-DD [ENTRY_TIMESTAMP_MS] [CONFIG_JSON]
```

The parity report starts from the broker-confirmed contract and entry fill, evaluates the exit controller on the retained live feature stream, the last accepted active quote in each OPRA callback batch, and 250 ms timer ticks, then compares the modeled trigger with the live exit request. It reports decision executable P&L, submitted-limit P&L, the last quote bid before the broker fill, and realized broker-fill P&L separately. Runtime startup persists the full effective configuration, so future reports automatically use the version that actually traded; older supported versions use immutable files in `config/history`, and the command refuses an unavailable version unless its exact JSON is provided.

Set a strong `POSTGRES_PASSWORD` in `.env` before non-local deployment. Raw OPRA history can be large; monitor the Docker volume and back it up according to your retention requirements.

Export one market date into the engine's replay JSONL format, then backtest it:

```bash
docker-compose exec -T spy-options-engine \
  node dist/src/cli/exportPostgresReplay.js 2026-07-22 --symbol=SPY > spy-2026-07-22.jsonl
npm run backtest -- spy-2026-07-22.jsonl conservative

docker-compose exec -T spy-options-engine \
  node dist/src/cli/exportPostgresReplay.js 2026-07-22 --symbol=QQQ > qqq-2026-07-22.jsonl
npm run backtest -- qqq-2026-07-22.jsonl conservative --symbol=QQQ
```

`MassiveOptionRestClient` also exposes `getHistoricalOptionQuotes`, `getHistoricalOptionTrades`, and `getHistoricalOptionAggregates` for contract-level backfills. The adapters request ascending nanosecond Q/T history and one-second OHLCV bars, normalize them into the same `option_quote`, `option_trade`, and `option_aggregate` payloads used by live persistence, and preserve causal provider timestamps for replay assembly.

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
- Independent option quote/trade/aggregate/snapshot storage, strict same-day OCC validation, bounded 0DTE subscription universe, raw option OFI/trade-sign/VWAP/depth/spread/chain confirmation, Black–Scholes Greeks and IV bisection, theta/vega-adjusted cost gates, gamma diagnostics, and production candidate scoring.
- Account/risk/premium/buying-power sizing caps, restart-continuous daily ET limits, conservative bid-based executable P&L, resettable soft-profit activation and breach confirmation, strengthened capped nondecreasing soft floors with an immediate break-even emergency boundary for confirmed protection, direct/recovered winner states, adverse-path-gated first-passage recovery probability, adaptive full-winner protected-profit floors, reversal evidence, recovery deadlines, and priority exits.
- Live and replay option-continuation LCBs using delta, gamma, vega, theta, IV change, physical SPY slope, executable spread cost, and observed P&L uncertainty; stale snapshots are excluded, negative estimates require persistence, and full winners use a shorter confirmation window to reduce late profit giveback.
- Tick-aware entry price ceilings and signal TTLs, option-flow-adjusted entry aggression/replacement/cancellation, adverse-flow exit urgency, execution-quality probes, marketable-limit ladders with collars, deterministic logical intent IDs, and replay fill models.
- Broker-backed serialized order management with deterministic submission recovery, cumulative partial-fill reconciliation, explicit `ENTRY_PENDING`/`OPEN_*`/`EXIT_PENDING`/`SAFE_MODE` lifecycle state, and exit intents that survive rejection, cancellation, and repricing until broker-confirmed flat.
- Arrival-order JSONL replay through the live modules, full audit events, signal funnel/rejections, trade/execution/prediction statistics, walk-forward folds, purge/embargo, and session bootstrap helpers.

## Replay data

Events are JSON Lines in arrival order. The outer `timestamp` controls replay order; embedded provider timestamps remain available for quote-age checks.

```json
{"type":"stock_quote","timestamp":1710000000000,"data":{"symbol":"SPY"}}
{"type":"stock_trade","timestamp":1710000000100,"data":{"symbol":"SPY"}}
{"type":"option_contract","timestamp":1710000000200,"data":{}}
{"type":"option_quote","timestamp":1710000000300,"data":{}}
{"type":"option_trade","timestamp":1710000000350,"data":{}}
{"type":"option_aggregate","timestamp":1710000000399,"data":{}}
{"type":"option_snapshot","timestamp":1710000000400,"data":{}}
{"type":"prior_close","timestamp":1710000000500,"data":{"symbol":"SPY","close":500}}
```

Replay fails immediately if timestamps decrease and never substitutes a future option quote. Supported fill models are `conservative`, `midpoint-touch`, and `queue`:

```bash
npm run backtest -- events.jsonl conservative calibration.json
npm run backtest -- qqq-events.jsonl conservative --symbol=QQQ
```

Calibration consumes either raw feature snapshots or `decision_snapshot` audit lines:

```bash
npm run calibrate -- features.jsonl 2026-01-02 2026-03-31 data-v1 > calibration.json
```

## Live integration boundary

`src/alpaca/` includes authenticated Alpaca stock JSON streaming, option MsgPack streaming, paper/live REST selection, contract/snapshot pagination, whole-contract option orders, and symbol-scoped broker reconciliation without embedding credentials or silently enabling real-money orders. The Docker runtime routes SPY, QQQ, and GOOGL SIP events through isolated feature/signal engines, selects only each runtime's same-day options using routed OPRA quotes, and sends eligible entries and protective exits to Alpaca paper trading. A narrowly defined late bullish reentry profile admits exceptionally clean, low-noise grinds after eight minutes without removing ordinary causal confirmation or the ten-minute cooldown from other setups. Unknown broker state halts the affected execution runtime. `src/main.ts` still refuses real-money `TRADING_MODE=live`; enabling that mode requires a separate, explicit promotion.

`LiveOrderManager` is the broker-backed execution boundary. Call `initialize()` before accepting signals, `submitEntry()` only with an eligible selector result and fresh option quote, and `tick()` on each option quote/timer to poll fills and enforce exits. Snapshots expose `FLAT`, `ENTRY_PENDING`, `OPEN_UNPROTECTED`, `PROTECTED_WINNER`, `PROTECTED_RECOVERED`, `EXIT_PENDING`, `CLOSED`, and `SAFE_MODE`. Soft protection requires sustained executable profit; trades recovering from a meaningful adverse excursion arm at $2, while clean developing trades retain the $3 threshold to avoid premature exits on ordinary quote noise. Clean direct winners promote to full winner protection at $10 of executable profit and retain a minimum $5 protected floor. Paper mode remains the default. The manager cannot guarantee profit; its purpose is deterministic execution, bounded risk, profit protection, and safe failure behavior.

Feed entitlements, provider schemas, broker permissions, fees, latency, and fill behavior must be validated in paper trading before any live promotion.
