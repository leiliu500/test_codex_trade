# Entry-quality guard validation — 2026-07-22

## Decision

Do not deploy this profile yet. The implementation is ready for continued research and paper validation, but the evidence is mixed and covers only three sessions. Historical sessions use IEX underlying data and cannot validate option fills or the early-scratch rule end to end.

The active research configuration now applies confirmation only to bullish impulses. The all-entry profile summarized below remains available as shadow-only audit output and cannot submit orders. The historical CLI also compares bullish-impulse, all-impulse, and all-entry scopes on future downloads.

## Changes evaluated

- Disable bullish impulse entries after 13:00 ET.
- Require a bullish impulse candidate to remain structurally valid and move in its direction during a causal 5–15 second confirmation window; audit the all-entry variant in shadow mode.
- Suppress all executable signals after 14:30 ET.
- Scratch during seconds 5–30 only when option high-water is below +1%, SPY has moved at least 0.1 bps against the entry, and fast slope has reversed.
- Restore a six-entry daily cap from durable, deduplicated fills across restarts.

## Historical underlying-signal screen

The same one-second tape was evaluated twice: the pre-guard immediate-entry profile and the original all-entry confirmation profile. Forward returns are evaluation labels only; they are not visible to the signal engine. These completed runs motivated narrowing active confirmation to bullish impulses; the narrowed scope still requires additional sessions.

| Session/feed | Signals, baseline → guarded | 5s avg bps | 5s aligned | 15s avg bps | 15s aligned | Post-14:30 signals |
|---|---:|---:|---:|---:|---:|---:|
| 2026-07-20 IEX | 239 → 27 | -0.230 → -0.258 | 43.1% → 37.0% | -0.292 → -0.244 | 39.3% → 44.4% | 81 → 0 |
| 2026-07-21 IEX | 110 → 25 | -0.302 → +0.029 | 44.5% → 64.0% | -0.162 → +0.303 | 47.3% → 60.0% | 3 → 0 |
| Combined | 349 → 52 | -0.253 → -0.120 | 43.6% → 50.0% | -0.251 → +0.019 | 41.8% → 51.9% | 84 → 0 |

The guarded profile retained only 14.9% of baseline candidates. Combined short-horizon quality improved, but July 20 worsened at 5 seconds and at 60 seconds. Neither historical session contained a baseline bullish impulse after 13:00, so those days do not validate that cutoff.

## July 22 live SIP/OPRA audit

- The 11 broker-confirmed trades lost about $132 in total.
- Six entries had already filled before the 13:42 restart. Restoring the six-entry cap would have blocked the five post-restart trades, which lost $71 net.
- Three bullish impulse trades after 13:00 lost $89 combined. The explicit cutoff would suppress them regardless of regime classification.
- Ten entries had a mapped signal price. At five seconds, all three mapped winners were directionally aligned versus two of seven losers. The same 3/3 versus 2/7 separation remained at 15 seconds, although the identities of the two aligned losers changed.
- A quote-level scratch counterfactual triggered on seven mapped trades and changed their combined result by approximately +$39. One trade would have worsened by $7, so this is not sufficient threshold evidence.

## Required before deployment

- Run the guarded/control comparison on additional sessions spanning up, down, high-volatility, and choppy regimes.
- Collect multi-session OPRA paper outcomes for early-scratch timing, fill slippage, and false exits.
- Review retained signal count as well as directional quality; the current 14.9% retention rate may be too restrictive.
- Keep the running paper container on the prior deployed image until the above evidence is consistent.
