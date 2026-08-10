# Alpaca OPRA provider-timestamp latency — 2026-08-07

## Summary

Real-time OPRA entitlement succeeds with the exact API key pair used by the paper-trading application, but both the WebSocket stream and the explicit latest-options REST endpoint returned provider timestamps far older than the application's two-second execution limit during the open session on 2026-08-07. The application therefore correctly remained fail-closed.

The same account/application path was healthy on 2026-08-06, when observed OPRA provider-time latency was approximately 42 ms at p50 and 145 ms at p95. Re-running the application from committed revision `874db7a`, without the current uncommitted market-data changes, did not remove the latency on 2026-08-07. This isolates the symptom from those local code changes.

## Explicit OPRA entitlement and latency check

- Endpoint: `GET https://data.alpaca.markets/v1beta1/options/quotes/latest`
- Query: `symbols=SPY260807C00773000&feed=opra`
- Credentials: exact application credential pair; values omitted
- HTTP status: `200`
- Alpaca request ID: `fc1c8f79c227a537d600991334f7c86e`
- Server `Date`: `Fri, 07 Aug 2026 15:24:54 GMT`
- Client observation time: `2026-08-07T15:24:54.921Z`
- Quote provider timestamp: `2026-08-07T15:23:56.467476292Z`
- Provider age at observation: `58.455 s`
- Quote: bid `1.27`, ask `1.28`

The explicit `feed=opra` response confirms that the credential pair can access OPRA; the successful response cannot be explained by Alpaca automatically falling back to the indicative feed.

## Corroborating observations

- The committed baseline's last-minute OPRA sample measured approximately 14.2 s p50 and 39.9 s p95 provider-time age.
- SIP remained current at approximately 43–45 ms.
- Application CPU was approximately 14%, with no evidence of local CPU saturation.
- QQQ was disabled, leaving the same SPY-only trading scope that had worked the prior day.
- Alpaca's public status page showed Options REST and OPRA WebSocket as operational at the time of investigation.
- WebSocket arrival remained active while provider timestamps were stale, distinguishing provider-time lag from receive silence or a disconnected socket.

## Requested Alpaca investigation

Please inspect the request above and the account's OPRA WebSocket route for account- or route-specific buffering/provider-timestamp delay on 2026-08-07. In particular, please compare the REST request ID with the OPRA publisher timestamp and review why both REST and WebSocket data were tens of seconds behind while SIP was current.

No API keys or secrets are included in this report.
