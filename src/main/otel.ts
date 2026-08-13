import { type Attributes, type Histogram } from '@opentelemetry/api'
import { SeverityNumber, type Logger as OtelLogger } from '@opentelemetry/api-logs'
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { appVersion } from './platform/paths'
import { z } from 'zod'

// OTLP export is opt-in: it activates only when a standard OTEL_EXPORTER_OTLP_*
// endpoint env var is set (headers/protocol follow the same OTEL_* conventions,
// read by the exporters themselves). Unset → every function here is a no-op, so
// nothing ever leaves the machine without explicit operator configuration.
// This module must not import logger.ts (logger forwards into it).

const METRIC_EXPORT_INTERVAL_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 1_500
const MAX_ATTR_STRING = 2000

const logsEnabled = Boolean(
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
)
const metricsEnabled = Boolean(
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
)

const SEVERITY = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
} satisfies Record<'debug' | 'info' | 'warn' | 'error', SeverityNumber>

const stringAttributeSchema = z.string()
const scalarAttributeSchema = z.union([z.number(), z.boolean()])
const bigintAttributeSchema = z.bigint()

let loggerProvider: LoggerProvider | null = null
let meterProvider: MeterProvider | null = null
let otelLogger: OtelLogger | null = null
const histograms = new Map<string, Histogram>()

function resource() {
  return resourceFromAttributes({
    'service.name': 'solus',
    'service.version': appVersion(),
  })
}

function getLogger(): OtelLogger {
  if (!otelLogger) {
    loggerProvider = new LoggerProvider({
      resource: resource(),
      processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    })
    otelLogger = loggerProvider.getLogger('solus')
  }
  return otelLogger
}

function getHistogram(label: string): Histogram {
  let histogram = histograms.get(label)
  if (!histogram) {
    if (!meterProvider) {
      meterProvider = new MeterProvider({
        resource: resource(),
        readers: [new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
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

export function emitOtelLog<Data extends object>(
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  data: Data,
): void {
  if (!logsEnabled) return
  try {
    getLogger().emit({
      severityNumber: SEVERITY[level],
      severityText: level.toUpperCase(),
      body: msg,
      attributes: toAttributes(data),
    })
  } catch {}
}

export function recordOtelDuration<Data extends object>(label: string, durationMs: number, data: Data): void {
  if (!metricsEnabled) return
  try {
    getHistogram(label).record(durationMs, toAttributes(data))
  } catch {}
}

export async function shutdownOtel(): Promise<void> {
  if (!loggerProvider && !meterProvider) return
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      Promise.all([loggerProvider?.shutdown(), meterProvider?.shutdown()]),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)
      }),
    ])
  } catch {} finally {
    if (timeout) clearTimeout(timeout)
  }
}
