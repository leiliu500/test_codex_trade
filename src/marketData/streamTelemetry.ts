export interface MarketStreamTelemetry {
  pendingEvents: number;
  maximumPendingEvents: number;
  consumerLagMs: number;
  maximumConsumerLagMs: number;
  coalescedEvents: number;
  overloaded: boolean;
  reconnectAttempt: number;
}
