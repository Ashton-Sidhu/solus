import { z } from 'zod'
import { artifactLinkedAt, type SessionArtifact, type SessionArtifactKind } from '@solus/contracts/session-artifacts'
import { notificationAge } from './notifications/presentation'
import type { OwnedArtifact } from './session-overview'

/**
 * The row at the top of the Threads surface (docs/plans/session-artifacts.md
 * decision 17): the works, apps, files, and images of the session and the
 * sessions it started. The ones the person opened come first, the latest open
 * first; then the others, the latest made first (a session links an item when
 * it makes it). Desktop, web, and the phone order the row with this model.
 * When the person opened an item is kept on each device.
 */

/** What the item's time in the row stands for. */
export type RecentArtifactActivity = 'opened' | 'linked'

export interface RecentArtifact {
  owned: OwnedArtifact
  pinned: boolean
  activity: RecentArtifactActivity
  at: number
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
      pinned: artifact.kind === 'work' && artifact.pinned === true,
      activity: opened === null ? 'linked' : 'opened',
      at: opened ?? artifactLinkedAt(artifact),
    })
  }
  const isOpened = (item: RecentArtifact) => Number(item.activity === 'opened')
  return row.sort((a, b) => isOpened(b) - isOpened(a) || b.at - a.at).slice(0, limit)
}

/** One name per item for the row and the open log: the record it stands for. */
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
export function recentArtifactAge(item: RecentArtifact, now: number): string {
  return notificationAge(item.at, now)
}

/** The item's time in words, for a tooltip: "Opened 10m ago". */
export function recentArtifactTimeLabel(item: RecentArtifact, now: number): string {
  const age = recentArtifactAge(item, now)
  return `${ACTIVITY_WORD[item.activity]} ${age === 'now' ? 'now' : /^\d+[mhd]$/.test(age) ? `${age} ago` : `on ${age}`}`
}

/** What a screen reader hears for one item: its name, its time, and its pin. */
export function recentArtifactAccessibilityLabel(title: string, item: RecentArtifact, now: number): string {
  return `${title}, ${recentArtifactTimeLabel(item, now).toLowerCase()}${item.pinned ? ', pinned' : ''}`
}

// ─── The open log ───

/** Synchronous storage that survives a restart: `localStorage`, or the phone's key-value store. */
export interface ArtifactOpenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const STORAGE_KEY = 'solus.artifactOpens'
/** The log keeps the newest opens only: the row never shows more than a session holds. */
const LOG_LIMIT = 200

/**
 * When this device last opened each item, by `recentArtifactKey`. It is kept
 * as `[key, at]` pairs, newest first, and holds at most 200.
 */
export class ArtifactOpenLog {
  private opens: Map<string, number>

  constructor(private readonly storage: ArtifactOpenStorage | null) {
    this.opens = new Map(readPairs(storage))
  }

  openedAt(artifact: SessionArtifact): number | null {
    return this.opens.get(recentArtifactKey(artifact)) ?? null
  }

  /** Record an open on this device. */
  record(artifact: SessionArtifact, at = Date.now()): void {
    const key = recentArtifactKey(artifact)
    this.opens.delete(key)
    const pairs: [string, number][] = [[key, at], ...this.opens]
    this.opens = new Map(pairs.slice(0, LOG_LIMIT))
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify([...this.opens]))
    } catch {
      // A full or blocked store keeps the open for this run only.
    }
  }
}

const pairsSchema = z.array(z.tuple([z.string(), z.number()]))

function readPairs(storage: ArtifactOpenStorage | null): [string, number][] {
  try {
    const parsed = pairsSchema.safeParse(JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]'))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}
