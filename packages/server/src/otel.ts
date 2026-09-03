import { type Attributes, type Histogram } from '@opentelemetry/api'
import { replaceOtlpSpanProcessor } from './observability/tracer'
import type { OtelActiveSignals, OtelSettings } from '@solus/contracts/types'
import { z } from 'zod'

/**
 * The OTLP SDK, loaded the first time export is actually configured.
 *
 * Export is opt-in and off by default, but the SDK, both exporters and the
 * resource detector were imported at module scope — so every launch paid to
 * load them, on every host, to send nothing. They are reached only from
 * `configureOtel` and the histogram builder below it, both of which run long
 * after boot on a host that exports at all.
 */
type OtelSdk = {
  MeterProvider: typeof import('@opentelemetry/sdk-metrics').MeterProvider
  PeriodicExportingMetricReader: typeof import('@opentelemetry/sdk-metrics').PeriodicExportingMetricReader
  OTLPMetricExporter: typeof import('@opentelemetry/exporter-metrics-otlp-http').OTLPMetricExporter
  BatchSpanProcessor: typeof import('@opentelemetry/sdk-trace-node').BatchSpanProcessor
  OTLPTraceExporter: typeof import('@opentelemetry/exporter-trace-otlp-http').OTLPTraceExporter
  otelResource: typeof import('./otel-resource').otelResource
}

let sdk: OtelSdk | null = null

async function loadOtelSdk(): Promise<OtelSdk> {
  if (sdk) return sdk
  const [metrics, metricExporter, traceSdk, traceExporter, resource] = await Promise.all([
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('./otel-resource'),
  ])
  sdk = {
    MeterProvider: metrics.MeterProvider,
    PeriodicExportingMetricReader: metrics.PeriodicExportingMetricReader,
    OTLPMetricExporter: metricExporter.OTLPMetricExporter,
    BatchSpanProcessor: traceSdk.BatchSpanProcessor,
    OTLPTraceExporter: traceExporter.OTLPTraceExporter,
    otelResource: resource.otelResource,
  }
  return sdk
}

// OTLP export is opt-in, from one of two places.
//
// Standard `OTEL_EXPORTER_OTLP_*` env vars still work and still win: a host run
// by an operator who set them keeps behaving exactly as before, and the
// settings UI shows itself as overridden rather than pretending to control the
// export. Otherwise the host's own saved settings decide, pushed in through
// `configureOtel` — this module never reads them itself, because settings.ts
// imports the logger and the logger forwards into here.
//
// Either way the default is off: nothing leaves the machine until somebody
// names an endpoint.
//
// This module must not import logger.ts or settings.ts. The tracer is reached
// the same way and for the same reason: its record sink is `metrics.db`, which
// logs its own failures, so a static import here would put the logger back in a
// cycle with the module it forwards into. It is loaded when export is
// configured, which is long after boot has built either.

const METRIC_EXPORT_INTERVAL_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 1_500
const MAX_ATTR_STRING = 2000

/** OTLP header names to values, the shape every exporter takes them in. */
export type OtlpHeaders = Record<string, string>

interface SignalTarget {
  /** Empty when the environment is in charge and the exporter reads `OTEL_*`. */
  url: string
  headers: OtlpHeaders
}

interface SignalEndpoints {
  metrics: SignalTarget | null
  traces: SignalTarget | null
}

const NOTHING_EXPORTED: SignalEndpoints = { metrics: null, traces: null }

/** `key=value, key2=value2` — the form every OTLP tool accepts, and the one an
 *  operator pastes from their collector's docs. A malformed pair is dropped
 *  rather than failing the whole configuration. */
function parseHeaders(raw: string) {
  const headers: OtlpHeaders = {}
  for (const pair of raw.split(',')) {
    const index = pair.indexOf('=')
    if (index <= 0) continue
    const key = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (key && value) headers[key] = value
  }
  return headers
}

function environmentEndpoints(): SignalEndpoints | null {
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  const metrics = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
  const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  if (!base && !metrics && !traces) return null
  // Left undefined so each exporter reads OTEL_* itself, keeping every
  // convention an operator already relies on — protocol, headers, timeouts.
  return {
    metrics: base || metrics ? { url: '', headers: {} } : null,
    traces: base || traces ? { url: '', headers: {} } : null,
  }
}

/** True when the environment configures OTLP, so the host's saved settings are
 *  not in charge and the UI must say so. */
export function otelManagedByEnvironment(): boolean {
  return environmentEndpoints() !== null
}

let endpoints: SignalEndpoints = environmentEndpoints() ?? NOTHING_EXPORTED

export function otelActiveSignals(): OtelActiveSignals {
  return {
    metrics: endpoints.metrics !== null,
    traces: endpoints.traces !== null,
  }
}

/**
 * Points this host's export at `settings`, tearing down whatever was running.
 * Called at boot and again whenever the settings change, so an operator who
 * turns export on does not have to restart the server to see data arrive.
 *
 * Ignored while the environment is in charge: env vars are the deployment's
 * decision and a UI toggle must not silently override the deployment.
 */
export async function configureOtel(settings: OtelSettings): Promise<void> {
  if (!otelManagedByEnvironment()) {
    await shutdownOtel()
    const base = settings.endpoint.trim().replace(/\/+$/, '')
    const headers = parseHeaders(settings.headers)
    endpoints = !settings.enabled || !base
      ? NOTHING_EXPORTED
      : {
        metrics: settings.exportMetrics ? { url: `${base}/v1/metrics`, headers } : null,
        traces: settings.exportTraces ? { url: `${base}/v1/traces`, headers } : null,
      }
  }
  // Nothing to export means nothing to load: a host that never turns export on
  // never pays for the SDK. Loaded before the endpoints are live so the
  // synchronous `recordOtelDuration` path can never see a metrics target with
  // no SDK behind it.
  if (!endpoints.metrics && !endpoints.traces) {
    await replaceOtlpSpanProcessor(null)
    return
  }
  const otel = await loadOtelSdk()
  // Metrics build their provider on first use. A trace copy cannot because the
  // spans come from a tracer that is already running, so its processor is
  // attached here and detached when the operator turns traces and logs off.
  await replaceOtlpSpanProcessor(
    endpoints.traces
      ? new otel.BatchSpanProcessor(new otel.OTLPTraceExporter(exporterConfig(endpoints.traces)))
      : null,
  )
}

const stringAttributeSchema = z.string()
const scalarAttributeSchema = z.union([z.number(), z.boolean()])
const bigintAttributeSchema = z.bigint()

let meterProvider: InstanceType<OtelSdk['MeterProvider']> | null = null
const histograms = new Map<string, Histogram>()

/** An empty url means the environment is in charge, so the exporter is built
 *  with no config and reads every `OTEL_*` convention itself. */
function exporterConfig(signal: SignalTarget) {
  return signal.url ? { url: signal.url, headers: signal.headers } : undefined
}

function getHistogram(
  label: string,
  signal: SignalTarget,
  otel: OtelSdk,
): Histogram {
  let histogram = histograms.get(label)
  if (!histogram) {
    if (!meterProvider) {
      meterProvider = new otel.MeterProvider({
        resource: otel.otelResource(),
        readers: [new otel.PeriodicExportingMetricReader({
          exporter: new otel.OTLPMetricExporter(exporterConfig(signal)),
          exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
        })],
      })
    }
    histogram = meterProvider.getMeter('solus').createHistogram(label, { unit: 'ms' })
    histograms.set(label, histogram)
  }
  return histogram
}

function toAttributes<Data extends object>(data: Data): Attributes {
  const attributes: Attributes = {}
  for (const [key, value] of Object.entries(data)) {
    if (value == null) continue
    const stringValue = stringAttributeSchema.safeParse(value)
    const scalarValue = scalarAttributeSchema.safeParse(value)
    const bigintValue = bigintAttributeSchema.safeParse(value)
    if (stringValue.success) {
      attributes[key] = stringValue.data.length > MAX_ATTR_STRING
        ? stringValue.data.slice(0, MAX_ATTR_STRING)
        : stringValue.data
    } else if (scalarValue.success) {
      attributes[key] = scalarValue.data
    } else if (bigintValue.success) {
      attributes[key] = String(bigintValue.data)
    } else {
      try {
        attributes[key] = JSON.stringify(value).slice(0, MAX_ATTR_STRING)
      } catch {}
    }
  }
  return attributes
}

export function recordOtelDuration<Data extends object>(label: string, durationMs: number, data: Data): void {
  const signal = endpoints.metrics
  // `sdk` is non-null whenever a metrics target is, because `configureOtel`
  // loads it before it publishes the endpoints. The check keeps this
  // synchronous path honest rather than assuming that ordering holds forever.
  if (!signal || !sdk) return
  try {
    getHistogram(label, signal, sdk).record(durationMs, toAttributes(data))
  } catch {}
}

export async function shutdownOtel(): Promise<void> {
  const closing = [
    meterProvider?.shutdown(),
    // Only the copy stops: the record's sink is synchronous and has nothing in
    // flight, and a span ended during shutdown still belongs in `metrics.db`.
    replaceOtlpSpanProcessor(null),
  ]
  // Cleared before awaiting, so a reconfiguration builds its providers fresh
  // rather than reusing ones that are on their way out.
  meterProvider = null
  histograms.clear()
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      Promise.all(closing),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)
      }),
    ])
  } catch {} finally {
    if (timeout) clearTimeout(timeout)
  }
}
