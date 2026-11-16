import type { RailAgentRow } from '../../../project-panel/lib/rail-agents'
import type { AgentLinkTone } from '../../../conversation/lib/agent-link'

/** A group of the Agents card: how its agents stand, or that their sessions are snoozed. */
export type AgentGroupKey = AgentLinkTone | 'snoozed'

/** One group of the Agents card: its rows, newest first. */
export interface AgentGroup {
  key: AgentGroupKey
  /** `Working`, `Done`, `Failed`, `Stopped`, `Snoozed`. */
  label: string
  rows: RailAgentRow[]
}

/** What still runs first, then the outcomes, then what waits until later. */
const AGENT_GROUPS: readonly { key: AgentGroupKey; label: string }[] = [
  { key: 'live', label: 'Working' },
  { key: 'done', label: 'Done' },
  { key: 'failed', label: 'Failed' },
  { key: 'idle', label: 'Stopped' },
  { key: 'snoozed', label: 'Snoozed' },
]

/**
 * The Agents card's rows by how they stand. A snoozed session waits in its own
 * group, whatever its agent did, as the sidebar's Snoozed shelf holds it. A
 * group with no rows is left out.
 */
export function agentGroups(rows: readonly RailAgentRow[], isSnoozed: (row: RailAgentRow) => boolean): AgentGroup[] {
  const keyOf = (row: RailAgentRow): AgentGroupKey => (isSnoozed(row) ? 'snoozed' : row.tone)
  return AGENT_GROUPS.map(({ key, label }) => ({ key, label, rows: rows.filter((row) => keyOf(row) === key) })).filter(
    (group) => group.rows.length > 0,
  )
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const CLOCK_WITH_SECONDS = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

/** The time of day a turn started. */
export function clockTime(timestamp: number): string {
  return CLOCK.format(timestamp)
}

/** When a snoozed session wakes: the time today, else its day too. `10:14 AM`, `Fri 9:00 AM`. */
export function wakeTimeLabel(wakesAt: number, now: number): string {
  return new Date(wakesAt).toDateString() === new Date(now).toDateString()
    ? CLOCK.format(wakesAt)
    : `${WEEKDAY.format(wakesAt)} ${CLOCK.format(wakesAt)}`
}

function clockPart(timestamp: number, type: Intl.DateTimeFormatPartTypes): string {
  return CLOCK.formatToParts(timestamp).find((part) => part.type === type)?.value ?? ''
}

/**
 * A turn's start, as the label under the line writes it: as short as it can
 * be and still be read in a row of them. The half of the day ("PM") shows on
 * the first label and where it changes, not on every one. A turn on a later
 * day than the one before it names its day: "10:02" after "3:18 PM" reads as
 * the same evening, and it may be two days on.
 */
export function turnClockLabel(startedAt: number, previousStartedAt: number | null): string {
  const time = `${clockPart(startedAt, 'hour')}:${clockPart(startedAt, 'minute')}`
  const period = clockPart(startedAt, 'dayPeriod')
  if (previousStartedAt === null) return `${time} ${period}`.trim()
  if (new Date(startedAt).toDateString() !== new Date(previousStartedAt).toDateString()) {
    return `${WEEKDAY.format(startedAt)} ${time} ${period}`.trim()
  }
  return period && clockPart(previousStartedAt, 'dayPeriod') !== period ? `${time} ${period}` : time
}

/** A bar's time in the readout: with seconds when a bar is shorter than a minute. */
export function barClockTime(timestamp: number, spanSeconds: number): string {
  return (spanSeconds < 60 ? CLOCK_WITH_SECONDS : CLOCK).format(timestamp)
}

/** Whether the search finds a row that is not an artifact: a path, an agent's name. */
export function textMatchesQuery(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return !needle || text.toLowerCase().includes(needle)
}
