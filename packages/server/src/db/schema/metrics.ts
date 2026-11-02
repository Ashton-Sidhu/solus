// drizzle-kit's entry for `metrics.db`: every metrics table as a `sqlite-core` table.
import * as metricsSchema from '../../data/insights/metrics-schema'

export const spans = metricsSchema.spans.sqlite
export const log_events = metricsSchema.logEvents.sqlite
