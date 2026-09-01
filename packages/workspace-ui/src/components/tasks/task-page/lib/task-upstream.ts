// How a task stands with the system that owns its ticket. Shaping only: the
// chrome pill and the sidebar's Upstream group both render from one object, so
// they cannot describe the same exchange differently.
import type {
  Task,
  TaskComment,
  TaskExternalLink,
  TaskProviderId,
} from '@solus/contracts/task-types'
import { relativeTime } from '../../lib/tasks-api'
import { statusColor } from './task-page'

export const PROVIDER_NAMES = {
  github: 'GitHub',
  jira: 'Jira',
} satisfies Record<Exclude<TaskProviderId, 'local'>, string>

/** `ok` — this page and the ticket agree. `pending` — we are holding writes the
 *  ticket has not taken yet. `error` — the last exchange failed, so the page is
 *  behind by an unknown amount and must say so instead of reading as current. */
export type TaskSyncTone = 'ok' | 'pending' | 'error'

export interface TaskUpstreamState {
  /** The system that owns the ticket, named as the user knows it. */
  provider: string
  /** The same system as an id. Every surface draws it as its brand logo, so
   *  the pill and the rail cannot mark the same ticket two different ways. */
  providerId: Exclude<TaskProviderId, 'local'>
  /** Short provider-side reference, e.g. `#412`. */
  ref: string
  /** Chrome pill wording: Synced · 2 to push · Sync failed · Reconnect GitHub. */
  label: string
  tone: TaskSyncTone
  /** Hover sentence: which ticket, and when the exchange last worked. */
  title: string
  /** Sidebar Pending row: what is being held, or that nothing is. */
  pendingLabel: string
  /** Local writes the ticket has not taken: dirty fields plus queued comments. */
  pendingCount: number
  /** Comments deliberately kept local, which no sync will send until someone
   *  publishes them. Counted apart from `pendingCount`: one is a queue, the
   *  other is a decision. */
  heldBackCount: number
  /** False for a provider-owned ticket, which is read live and has no backlog
   *  to push — offering "Sync now" there would overstate what happens. */
  canSync: boolean
  /** Deep link to the ticket, when we know one. */
  url: string | null
}

const TONE_BY_SYNC_STATE = {
  ok: 'ok',
  dirty: 'pending',
  error: 'error',
  auth_error: 'error',
} satisfies Record<TaskExternalLink['syncState'], TaskSyncTone>

/**
 * Three shapes of task reach this page and only two of them have an upstream:
 * a native task linked to a ticket (`externalLink` — the sync engine's own
 * state), a provider-owned ticket rendered directly (`providerId !== 'local'`,
 * never behind because every read goes to the provider), and a purely local
 * task, which returns null and shows no upstream anywhere.
 */
export function taskUpstreamState(input: {
  task: Task
  externalLink?: TaskExternalLink | null
  comments: TaskComment[]
  now?: number
}): TaskUpstreamState | null {
  const { task, externalLink, comments } = input
  const now = input.now ?? Date.now()

  if (externalLink) {
    const queued = comments.filter((comment) => comment.syncPending).length
    const heldBackCount = heldBackCommentIds(comments, true).length
    const pendingCount = externalLink.dirtyFields.length + queued
    const provider = PROVIDER_NAMES[externalLink.provider]
    const tone = externalLink.syncState === 'ok' && pendingCount
      ? 'pending'
      : TONE_BY_SYNC_STATE[externalLink.syncState]
    const seen = externalLink.lastSyncedAt
      ? `last synced ${relativeTime(externalLink.lastSyncedAt, now)}`
      : 'never synced'
    const ref = ticketRef(externalLink.provider, externalLink.externalId)
    const ticket = externalLink.provider === 'github'
      ? `${externalLink.externalKey}#${externalLink.externalId}`
      // A Jira external key leads with a cloudId, which names the site to a
      // machine and nothing to a person. The issue key already says both the
      // project and the issue.
      : ref
    return {
      provider,
      providerId: externalLink.provider,
      ref,
      label: upstreamLabel(externalLink, pendingCount, provider),
      tone,
      title: externalLink.syncError
        ? `${ticket} · ${externalLink.syncError} · ${seen}`
        : `${ticket} · ${seen}`,
      pendingLabel: pendingLabelFor(pendingCount, heldBackCount),
      pendingCount,
      heldBackCount,
      canSync: true,
      url: externalLink.url,
    }
  }

  if (task.providerId === 'local') return null

  const provider = PROVIDER_NAMES[task.providerId]
  return {
    provider,
    providerId: task.providerId,
    ref: ticketRef(task.providerId, task.id),
    label: provider,
    tone: 'ok',
    title: `This task is a ${provider} issue, read live`,
    pendingLabel: 'Nothing to push',
    pendingCount: 0,
    heldBackCount: 0,
    canSync: false,
    url: task.url,
  }
}

/** How each provider writes a ticket reference: GitHub numbers its issues and
 *  prefixes them with `#`; a Jira key (`ACME-12`) already reads as one. */
export function ticketRef(
  provider: Exclude<TaskProviderId, 'local'>,
  externalId: string,
): string {
  if (provider !== 'github') return externalId
  return /^\d+$/.test(externalId) ? `#${externalId}` : externalId
}

/** A queue and a decision are different facts, so the row names which it is. */
function pendingLabelFor(pending: number, heldBack: number): string {
  if (pending) return `${pending} change${pending === 1 ? '' : 's'} to push`
  if (heldBack) return `${heldBack} comment${heldBack === 1 ? '' : 's'} held back`
  return 'Nothing to push'
}

function upstreamLabel(link: TaskExternalLink, pending: number, provider: string): string {
  if (link.syncState === 'auth_error') return `Reconnect ${provider}`
  if (link.syncState === 'error') return 'Sync failed'
  if (pending) return `${pending} to push`
  return 'Synced'
}

// ── Comments ──

/** Where one comment stands with the ticket. `none` — this task has no ticket,
 *  so the question does not arise and the feed shows nothing. */
export type TaskCommentSyncState = 'published' | 'queued' | 'held' | 'none'

export function commentSyncState(
  comment: TaskComment,
  hasUpstream: boolean,
): TaskCommentSyncState {
  if (!hasUpstream) return 'none'
  // An external comment is upstream's own copy, and a local one that carries an
  // external id has already been posted under it.
  if (comment.source === 'external' || comment.externalId) return 'published'
  return comment.syncPending ? 'queued' : 'held'
}

/** Comments written while auto-posting was off, in the order they were made —
 *  what "Publish all" acts on. */
export function heldBackCommentIds(comments: TaskComment[], hasUpstream: boolean): string[] {
  return comments
    .filter((comment) => commentSyncState(comment, hasUpstream) === 'held')
    .map((comment) => comment.id)
}

// ── Publishing a task that has no ticket yet ──

/** The provider a task could be published to, when it has no ticket of its own
 *  and the project is configured for one. Null whenever publishing would fail:
 *  no provider, a provider that cannot be reached, or a ticket already linked. */
export interface TaskPublishTarget {
  provider: string
  /** The same system as an id, for surfaces that draw its brand logo. */
  providerId: Exclude<TaskProviderId, 'local'>
  /** Where it would land, as the user reads it — `owner/repo`, a Jira project
   *  key — when the status read resolved one. */
  scope: string | null
}

export function taskPublishTarget(input: {
  task: Task
  upstream: TaskUpstreamState | null
  status: { provider: TaskProviderId; ok: boolean; scopeLabel?: string } | null
}): TaskPublishTarget | null {
  const { task, upstream, status } = input
  // `mirroredTicket` rides every task read, so it answers before the detail
  // read has resolved — without it the page briefly offers to publish a task
  // that already has a ticket.
  if (upstream || task.mirroredTicket || task.providerId !== 'local') return null
  if (!status || status.provider === 'local' || !status.ok) return null
  return {
    provider: PROVIDER_NAMES[status.provider],
    providerId: status.provider,
    scope: status.scopeLabel ?? null,
  }
}

/** One recipe per tone, so the pill, its mark and the sidebar row cannot
 *  drift apart. */
export function syncToneColor(tone: TaskSyncTone): string {
  if (tone === 'error') return statusColor('--failure')
  if (tone === 'pending') return statusColor('--warning')
  return 'var(--muted-foreground)'
}
