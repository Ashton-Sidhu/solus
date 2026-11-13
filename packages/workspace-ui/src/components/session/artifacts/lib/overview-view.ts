import type { SessionArtifact } from '@solus/contracts/session-artifacts'
import type { OverviewChange, OwnedArtifact } from '@solus/client-core/session-overview'
import { changeTotals } from '@solus/client-core/session-overview'
import type { RailAgentRow } from '../../../project-panel/lib/rail-agents'
import { pullRequestState } from './artifact-list'

/** The four kinds the surface counts and shows a card for. */
export type OverviewKind = 'changes' | 'agents' | 'pull-requests' | 'items'

export interface OverviewTile {
  kind: OverviewKind
  /** The kind's name on the tile. */
  label: string
  /** The name on a pane too narrow for the full one. */
  shortLabel: string
  count: number
  /** The line totals, on the changes tile, once git has answered. */
  lines: { additions: number; deletions: number } | null
  /** How the tile's rows stand, in words: "1 running · 2 done". Null when there is nothing to say. */
  detail: string | null
}

/** The parts with something to count, as words: "1 open · 1 merged". */
function detail(parts: [number, string][]): string | null {
  const shown = parts.filter(([count]) => count > 0).map(([count, word]) => `${count} ${word}`)
  return shown.length > 0 ? shown.join(' · ') : null
}

function count<Item>(items: readonly Item[], test: (item: Item) => boolean): number {
  return items.filter(test).length
}

/**
 * The scope's four numbers. A tile names its kind and says how many of it the
 * scope holds, and its detail says how those stand, so a reader sees
 * "4 agents, 1 running" without opening the card.
 */
export function overviewTiles(
  changes: readonly OverviewChange[],
  agents: readonly RailAgentRow[],
  pullRequests: readonly OwnedArtifact[],
  items: readonly OwnedArtifact[],
): OverviewTile[] {
  const states = pullRequests.map(({ artifact }) => (artifact.kind === 'pull-request' ? pullRequestState(artifact.link) : null))
  const kindCount = (...kinds: SessionArtifact['kind'][]) => count(items, ({ artifact }) => kinds.includes(artifact.kind))
  const works = kindCount('work')
  const files = kindCount('file', 'image')
  const automations = kindCount('automation')
  return [
    { kind: 'changes', label: 'Changes', shortLabel: 'Changes', count: changes.length, lines: changeTotals(changes), detail: null },
    {
      kind: 'agents',
      label: 'Agents',
      shortLabel: 'Agents',
      count: agents.length,
      lines: null,
      detail: detail([
        [count(agents, (row) => row.tone === 'live'), 'running'],
        [count(agents, (row) => row.tone === 'done'), 'done'],
        [count(agents, (row) => row.tone === 'failed'), 'failed'],
      ]),
    },
    {
      kind: 'pull-requests',
      label: 'Pull requests',
      shortLabel: 'PRs',
      count: pullRequests.length,
      lines: null,
      detail: detail([
        [count(states, (state) => state === 'open'), 'open'],
        [count(states, (state) => state === 'draft'), 'draft'],
        [count(states, (state) => state === 'merged'), 'merged'],
        [count(states, (state) => state === 'closed' || state === 'missing'), 'closed'],
      ]),
    },
    {
      kind: 'items',
      label: 'Works and files',
      shortLabel: 'Works',
      count: items.length,
      lines: null,
      detail: detail([
        [works, works === 1 ? 'work' : 'works'],
        [files, files === 1 ? 'file' : 'files'],
        [automations, automations === 1 ? 'automation' : 'automations'],
      ]),
    },
  ]
}

/** What a started session linked, as counts for the chips on its agent row. */
export interface AgentLinkCounts {
  pullRequests: number
  works: number
  files: number
}

export function agentLinkCounts(items: readonly SessionArtifact[]): AgentLinkCounts {
  return {
    pullRequests: count(items, (item) => item.kind === 'pull-request'),
    works: count(items, (item) => item.kind === 'work' || item.kind === 'automation'),
    files: count(items, (item) => item.kind === 'file' || item.kind === 'image'),
  }
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const CLOCK_WITH_SECONDS = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

/** The time of day a turn started. */
export function clockTime(timestamp: number): string {
  return CLOCK.format(timestamp)
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
