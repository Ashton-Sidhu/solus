/**
 * How long telemetry may delay process exit.
 *
 * Analytics and OpenTelemetry each flush on shutdown, and both are awaited
 * together (`Promise.all([shutdownAnalytics(), shutdownOtel()])`), so this is
 * one wall-clock budget rather than two independent waits. Both raced their
 * flush against their own copy of the number; whoever tuned one would have
 * silently left the other behind.
 *
 * An exporter that cannot reach its collector must not hold the process open,
 * so the race resolves rather than rejects: losing a last batch of telemetry is
 * cheaper than an app that will not quit.
 */
export const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 1_500
