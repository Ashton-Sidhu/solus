import type { MetricsSpan } from '@solus/contracts/observability-types'
import { formatCost, formatDuration, formatPercent } from './format'
import { estimatedKindCosts, waitingOn } from './turn-analysis'
import type { TraceView } from './waterfall'

export type CoverageReadingId = 'kind' | 'waiting' | 'cost'

/** One slice of the bar and its key entry. */
export interface CoverageEntry {
  key: string
  label: string
  color: string
  share: number
  /** The figure the key leads with. */
  value: string
  /** The quieter figure after it. */
  secondary: string | null
  title: string
}

/**
 * One answer about the turn's interval, drawn as one bar. The trace card
 * shows one reading at a time: three bars stacked over the waterfall read as
 * three plots of different things, when they are three cuts of one.
 */
export interface CoverageReading {
  id: CoverageReadingId
  /** Its name in the Trace header menu. */
  label: string
  /** What the bar pictures, for assistive technology. */
  description: string
  entries: CoverageEntry[]
  /** A line after the key, when the figures need a qualifier. */
  note: string | null
}

/**
 * The readings a turn can answer. Time by span kind is always there; who the
 * turn waited on and the estimated cost are there only when the record holds
 * them, so a turn without a reported cost offers no Cost choice that would draw an empty bar.
 */
export function coverageReadings(root: MetricsSpan, view: TraceView): CoverageReading[] {
  const readings: CoverageReading[] = [
    {
      id: 'kind',
      label: 'Span kind',
      description: 'Duration share by span kind',
      entries: view.legend.map((entry) => ({
        key: entry.kind,
        label: entry.label,
        color: entry.color,
        share: entry.share,
        value: formatPercent(entry.share),
        secondary: formatDuration(entry.ms),
        title: `${entry.label} — ${formatPercent(entry.share)} · ${formatDuration(entry.ms)}`,
      })),
      note: null,
    },
  ]

  const waits = waitingOn(view)
  if (waits.length > 0) {
    readings.push({
      id: 'waiting',
      label: 'Waiting on',
      description: 'Turn time by who was being waited on',
      entries: waits.map((wait) => ({
        key: wait.party,
        label: wait.label,
        color: wait.color,
        share: wait.share,
        value: formatPercent(wait.share),
        secondary: formatDuration(wait.ms),
        title: `${wait.label} — ${formatPercent(wait.share)} · ${formatDuration(wait.ms)} · ${wait.detail}`,
      })),
      note: null,
    })
  }

  const costs = estimatedKindCosts(root, view)
  const costTotal = costs.reduce((total, entry) => total + entry.usd, 0)
  if (costs.length > 0 && costTotal > 0) {
    readings.push({
      id: 'cost',
      label: 'Est. cost',
      description: 'Estimated cost by span kind',
      entries: costs.map((cost) => ({
        key: cost.kind,
        label: cost.label,
        color: cost.color,
        share: cost.share,
        value: `≈${formatCost(cost.usd)}`,
        secondary: formatPercent(cost.share),
        title: `${cost.label} — about ${formatCost(cost.usd)} · ${formatPercent(cost.share)}`,
      })),
      note: `of ${formatCost(costTotal)}, split by thinking and streaming time`,
    })
  }

  return readings
}
