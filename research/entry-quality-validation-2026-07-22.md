# Entry-quality guard validation — 2026-07-22

## Decision

Do not deploy or enable this profile yet. The implementation is ready for continued research and paper validation, but the evidence is mixed and covers only three sessions. Historical sessions use IEX underlying data and cannot validate option fills or the early-scratch rule end to end.

The runtime defaults to `signals.entryQualityMode=SHADOW`. Paper entries and exits retain the existing behavior while separate evaluators calculate the recommended bullish-impulse profile, all-impulse profile, and all-entry profile on the same features. Shadow signal, risk, cutoff, and scratch decisions are audit data only. A later deployment PR must explicitly change the mode to `ENFORCE`; this research PR must not do that.

## Changes evaluated

- Shadow-label bullish impulse candidates after 13:00 ET as cutoff failures.
- Evaluate whether a candidate remains structurally valid and moves in its direction during a causal 5–15 second confirmation window. Run bullish-impulse, all-impulse, and all-entry scopes simultaneously.
- Shadow-label signal candidates after 14:30 ET as research-only. The existing option-universe and order-boundary cutoff continues to prevent actual post-cutoff paper orders.
- Propose a shadow scratch during seconds 5–30 only when option high-water is below +1%, SPY has moved at least 0.1 bps against the entry, and fast slope has reversed.
- Restore durable, deduplicated fills across restarts and evaluate a six-entry cap in shadow risk without blocking the active paper risk path.

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

## Shadow evidence to collect

Collect 10 additional complete SIP/OPRA paper sessions before tuning a threshold. The set must include at least three directional-up sessions, three directional-down sessions, and three choppy/high-volatility sessions; one session may fall into any observed regime. Exclude a session from the decision set if SIP/OPRA readiness was incomplete, audit persistence has a gap, or broker reconciliation was unhealthy.

For every candidate, retain the active decision and all three entries under `live_entry_evaluation.data.shadowEvaluations`. For every eligible option order decision, retain `risk_decision.data.shadowRisk`. Measure scratch proposals from `shadow_exit_decision` against executable OPRA bid prices, configured slippage, fees, and the actual paper exit. Record cutoff failures as research-only rather than actionable signals.

## Restart-continuity drill

After exactly six unique entry fills in a paper session, restart the research build once it has been approved for shadow observation. The startup event must show `restoredEntries=6`, `activeEntryCapReached=false`, and `shadowEntryCapReached=true`. The next otherwise-eligible entry must still be submitted by the active paper path while `risk_decision.data.shadowRisk.risk.reasons` contains `MAX_DAILY_ENTRIES_REACHED`. Repeat this drill successfully on three sessions. The automated tests reproduce this state transition, but they do not replace the operational drill.

## Precommitted deployment thresholds

These thresholds are fixed before collecting the additional sessions:

- Coverage: 10 qualifying sessions and at least 30 baseline bullish-impulse candidates, with the regime mix above.
- Quality: the bullish-impulse profile improves both 5-second and 15-second candidate-weighted directional aligned rate by at least 8 percentage points versus immediate entry, and improves or is neutral in at least 7 of 10 sessions.
- Retention: retain at least 70% of all baseline actionable signals, at least 30% of baseline bullish-impulse candidates, and at least 95% of bearish candidates.
- Scratch economics: shadow scratches produce positive net counterfactual P&L after observed bid, configured slippage, and fees; reduce the median losing-trade loss by at least 15%; and falsely scratch no more than 10% of trades that subsequently reach their original target before the original exit.
- Regime safety: in every dominant regime with at least 10 candidates, neither 15-second average directional return nor aligned rate may degrade by more than 0.10 bps or 5 percentage points, respectively.
- Cutoff safety: no broker order request is generated from a post-14:30 candidate, and every such candidate is identifiable as research-only through its shadow cutoff reason.
- Restart safety: all three six-fill restart drills preserve `MAX_DAILY_ENTRIES_REACHED` in shadow risk with no duplicate-fill counting.

If more than one confirmation scope passes, choose bullish impulses only unless another scope improves quality by at least a further 5 percentage points without violating retention or regime safety. The all-entry profile's prior 14.9% retention and July 20 degradation make it ineligible without materially different new evidence.

## Release gate

Keep the running paper container on the prior deployed image. This branch is research-only and must remain a draft PR. Merge and deployment require a separate review after every threshold above passes; enabling `entryQualityMode=ENFORCE` must be an explicit, independently tested change.
