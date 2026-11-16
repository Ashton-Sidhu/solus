import type { AppSessionLink } from '@solus/contracts/apps'
import type { AgentId, Message, SessionRecordStatus } from '@solus/contracts/types'
import { agentLabel } from '../../../../lib/agentAvailability'
import { threadTime } from '../../../../lib/relative-time'
import { appTime } from '../../lib/app-view'

/**
 * The Sessions section (docs/plans/apps.md §9.2) in plain terms: the linked
 * sessions grouped by how they stand, the head of the selected one, and the
 * last turn its card shows. Pure, so the rules are tested without a host.
 */

/** How a linked session stands, as its group names it. A session the host keeps no record of is Stopped: it cannot run. */
export type AppSessionGroupId = 'working' | 'done' | 'stopped'

const GROUP_OF = {
  running: 'working',
  idle: 'done',
  interrupted: 'stopped',
} satisfies { [status in SessionRecordStatus]: AppSessionGroupId }

const GROUP_LABELS = {
  working: 'Working',
  done: 'Done',
  stopped: 'Stopped',
} satisfies { [group in AppSessionGroupId]: string }

/** One row of the list: what the row shows of a linked session. */
export interface AppSessionRow {
  sessionId: string
  title: string
  provider: AgentId | null
  group: AppSessionGroupId
  /** The line under the title. */
  detail: string
  /** When the session was last active, short: "now", "2h", "Nov 3". */
  time: string
}

export interface AppSessionGroup {
  id: AppSessionGroupId
  label: string
  rows: AppSessionRow[]
}

export function appSessionGroupOf(link: Pick<AppSessionLink, 'status'>): AppSessionGroupId {
  return link.status ? GROUP_OF[link.status] : 'stopped'
}

/** The title a session shows: its own, or a plain name when it has none yet. */
export function appSessionTitle(link: Pick<AppSessionLink, 'title'>): string {
  return link.title?.trim() || 'Untitled session'
}

/**
 * The linked sessions in three groups — Working, Done, Stopped — in that
 * order, each the most recently active first. A group with no session is
 * left out.
 */
export function appSessionGroups(links: readonly AppSessionLink[], now: number): AppSessionGroup[] {
  const groups: AppSessionGroup[] = (['working', 'done', 'stopped'] as const).map((id) => ({ id, label: GROUP_LABELS[id], rows: [] }))
  const ordered = [...links].sort((a, b) => lastActive(b) - lastActive(a) || a.sessionId.localeCompare(b.sessionId))
  for (const link of ordered) {
    const group = appSessionGroupOf(link)
    groups.find((entry) => entry.id === group)?.rows.push({
      sessionId: link.sessionId,
      title: appSessionTitle(link),
      provider: link.provider,
      group,
      detail: `Linked ${appTime(link.linkedAt, now)}`,
      time: threadTime(lastActive(link), now),
    })
  }
  return groups.filter((group) => group.rows.length > 0)
}

/** The session a list shows selected: the one the owner chose while it is still linked, else the first row. */
export function selectedAppSession(groups: readonly AppSessionGroup[], chosenSessionId: string | null): AppSessionRow | null {
  const rows = groups.flatMap((group) => group.rows)
  return rows.find((row) => row.sessionId === chosenSessionId) ?? rows[0] ?? null
}

/** The row after or before `sessionId` in list order, for the arrow keys. Stays at the ends. */
export function adjacentAppSession(groups: readonly AppSessionGroup[], sessionId: string | null, delta: 1 | -1): string | null {
  const rows = groups.flatMap((group) => group.rows)
  if (rows.length === 0) return null
  const index = rows.findIndex((row) => row.sessionId === sessionId)
  if (index === -1) return rows[0]!.sessionId
  return rows[Math.max(0, Math.min(rows.length - 1, index + delta))]!.sessionId
}

/** The line under the card's title: "Claude Code · working · active 20 min ago". */
export function appSessionByline(link: AppSessionLink, now: number): string {
  const parts: string[] = []
  if (link.provider) parts.push(agentLabel(link.provider))
  parts.push(GROUP_LABELS[appSessionGroupOf(link)].toLowerCase())
  parts.push(`active ${appTime(lastActive(link), now)}`)
  return parts.join(' · ')
}

/**
 * The last turn of a transcript: the newest prompt of a person and every
 * message after it. A transcript with no prompt shows what it has. The card
 * shows this much; the whole session opens in its own tab.
 */
export function lastTurnMessages(messages: readonly Message[]): Message[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === 'user') return messages.slice(index)
  }
  return [...messages]
}

function lastActive(link: Pick<AppSessionLink, 'lastActivityAt' | 'linkedAt'>): number {
  return link.lastActivityAt ?? link.linkedAt
}
