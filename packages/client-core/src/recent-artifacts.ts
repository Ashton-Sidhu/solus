import { artifactLinkedAt, type SessionArtifact, type SessionArtifactKind } from '@solus/contracts/session-artifacts'
import { notificationAge } from './notifications/presentation'
import type { OwnedArtifact } from './session-overview'

/**
 * The row at the top of the Threads surface (docs/plans/session-artifacts.md
 * decision 17): the works, apps, files, and images of the session and the
 * sessions it started. The ones the person opened come first, the latest open
 * first; then the others, the latest made first (a session links an item when
 * it makes it). Desktop, web, and the phone order the row with this model.
 * When the person opened an item is their history (`person-history.ts`), keyed
 * by `recentArtifactKey`.
 */

/** What the item's time in the row stands for. */
export type RecentArtifactActivity = 'opened' | 'linked'

/** One item of a "Recently viewed" row: what the card draws. */
export interface RecentItem {
  artifact: SessionArtifact
  pinned: boolean
  activity: RecentArtifactActivity
  at: number
}

/** An item of the Threads row, with the session that linked it. */
export interface RecentArtifact extends RecentItem {
  owned: OwnedArtifact
}

/** Pull requests and automations have no picture to show; their cards list them. */
const SHOWN_KINDS: ReadonlySet<SessionArtifactKind> = new Set(['work', 'app', 'file', 'image'])

export const RECENT_ARTIFACT_LIMIT = 12

/**
 * The row, at most `limit` items. An item that two sessions linked shows once,
 * as the first of them lists it. `openedAt` answers when this device last
 * opened an item, or null.
 */
export function recentArtifacts(
  owned: readonly OwnedArtifact[],
  openedAt: (artifact: SessionArtifact) => number | null,
  limit = RECENT_ARTIFACT_LIMIT,
): RecentArtifact[] {
  const seen = new Set<string>()
  const row: RecentArtifact[] = []
  for (const entry of owned) {
    const { artifact } = entry
    if (!SHOWN_KINDS.has(artifact.kind)) continue
    const key = recentArtifactKey(artifact)
    if (seen.has(key)) continue
    seen.add(key)
    const opened = openedAt(artifact)
    row.push({
      owned: entry,
      artifact,
      pinned: artifact.kind === 'work' && artifact.pinned === true,
      activity: opened === null ? 'linked' : 'opened',
      at: opened ?? artifactLinkedAt(artifact),
    })
  }
  const isOpened = (item: RecentArtifact) => Number(item.activity === 'opened')
  return row.sort((a, b) => isOpened(b) - isOpened(a) || b.at - a.at).slice(0, limit)
}

/** One name per item for the row and the person's history: the record it stands for. */
export function recentArtifactKey(artifact: SessionArtifact): string {
  switch (artifact.kind) {
    case 'pull-request': return `pull-request:${artifact.link.url}`
    case 'work': return `work:${artifact.workId}`
    case 'file':
    case 'image': return `${artifact.kind}:${artifact.hostId}:${artifact.path}`
    case 'automation': return `automation:${artifact.hostId}:${artifact.automationId}`
    case 'app': return `app:${artifact.hostId}:${artifact.appId}`
  }
}

const ACTIVITY_WORD = { opened: 'Opened', linked: 'Added' } as const satisfies { [activity in RecentArtifactActivity]: string }

/** How long ago the item's time was, short: "now", "10m", "3h", "2d", else the date. */
export function recentArtifactAge(item: RecentItem, now: number): string {
  return notificationAge(item.at, now)
}

/** The item's time in words, for a tooltip: "Opened 10m ago". */
export function recentArtifactTimeLabel(item: RecentItem, now: number): string {
  const age = recentArtifactAge(item, now)
  return `${ACTIVITY_WORD[item.activity]} ${age === 'now' ? 'now' : /^\d+[mhd]$/.test(age) ? `${age} ago` : `on ${age}`}`
}

/** What a screen reader hears for one item: its name, its time, and its pin. */
export function recentArtifactAccessibilityLabel(title: string, item: RecentItem, now: number): string {
  return `${title}, ${recentArtifactTimeLabel(item, now).toLowerCase()}${item.pinned ? ', pinned' : ''}`
}
