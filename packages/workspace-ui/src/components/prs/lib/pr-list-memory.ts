/**
 * What the pull request list remembers on this device, across reloads.
 *
 * Two records, both in local storage and both read defensively — storage is
 * writable by any past version of the app, and one malformed value must not
 * break the page on every reload until someone clears it:
 *
 *  - **Preferences.** The sort and the filters last chosen, restored the next
 *    time the list opens. Only list controls: the search text and the reading
 *    position are part of one visit.
 *  - **The last list.** The most recent unsearched answer per page scope (one
 *    project, or every project), so a reload paints yesterday's rows at once
 *    and the live read replaces them in place. Bounded in size and age, and
 *    only for the fetch scope it was read under.
 */
import type { PullRequest } from '@solus/contracts/providers'
import { z } from 'zod'
import type { PrListView } from './prs-list-view'

type ListStorage = Pick<Storage, 'getItem' | 'setItem'>

function deviceStorage(): ListStorage | undefined {
  return globalThis.localStorage
}

// ── Preferences ──────────────────────────────────────────────────────────

const PREFERENCES_KEY = 'solus.prs.preferences'

export type PrListPreferences = Pick<
  PrListView,
  'sortMode' | 'statusKeys' | 'involvement' | 'author' | 'label' | 'draft' | 'review' | 'checks' | 'guide' | 'lens'
>

const bounded = z.string().max(200)
const preferencesSchema = z.object({
  sortMode: z.enum(['ready', 'updated', 'created']),
  statusKeys: z.array(z.enum(['open', 'draft', 'merged', 'closed'])).max(4),
  involvement: z.enum(['all', 'created', 'assigned', 'review-requested']),
  author: bounded.nullable(),
  label: bounded.nullable(),
  draft: z.enum(['all', 'ready', 'draft']),
  review: z.enum(['all', 'approved', 'changes-requested', 'review-required', 'no-reviews']),
  checks: z.enum(['all', 'passing', 'pending', 'failing']),
  guide: z.enum(['all', 'has-guide']),
  // Added later: preferences saved before it keep their other choices.
  lens: z.enum(['all', 'has-lens']).default('all'),
})

/** The choices saved on this device, or null when none are (or they no longer
 *  parse — a value from an older build is dropped, not half-applied). */
export function readPrListPreferences(storage: ListStorage | undefined = deviceStorage()): PrListPreferences | null {
  try {
    const raw = storage?.getItem(PREFERENCES_KEY)
    if (!raw) return null
    const parsed = preferencesSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function prListPreferencesOf(view: PrListView): PrListPreferences {
  return {
    sortMode: view.sortMode,
    statusKeys: [...view.statusKeys],
    involvement: view.involvement,
    author: view.author,
    label: view.label,
    draft: view.draft,
    review: view.review,
    checks: view.checks,
    guide: view.guide,
    lens: view.lens,
  }
}

export function writePrListPreferences(
  preferences: PrListPreferences,
  storage: ListStorage | undefined = deviceStorage(),
): void {
  try {
    storage?.setItem(PREFERENCES_KEY, JSON.stringify(preferences))
  } catch {
    // Storage can be full or denied; a preference is a convenience.
  }
}

// ── The last list ────────────────────────────────────────────────────────

const SNAPSHOT_PREFIX = 'solus.prs.list:'
/** One page is what the list starts with, and all a cold start needs. */
const SNAPSHOT_MAX_ROWS = 99
/** Older than this, the rows would mislead more than they help. */
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const SNAPSHOT_VERSION = 1

/** The page scope a snapshot belongs to: `all`, or one project's host key. */
export type PrListScopeKey = string

export interface PrListSnapshotProject {
  serverId: string
  projectRoot: string
  items: PullRequest[]
}

export interface PrListSnapshot {
  /** The fetch scope the rows were read under (`open`, `closed`, `all`). */
  state: 'open' | 'closed' | 'all'
  savedAt: number
  projects: PrListSnapshotProject[]
}

/**
 * The fields a row is drawn, filtered and sorted from. A stored row missing any
 * of them is from a build that drew rows differently, and is dropped. The rest
 * of the record (capabilities, permissions) is only read once a pull request is
 * opened, which reads it fresh from the host.
 */
const snapshotRowSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  headSha: z.string(),
  baseRepo: z.object({ host: z.string(), owner: z.string(), repo: z.string() }),
  author: z.string(),
  authorAvatarUrl: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  createdAt: z.string(),
  updatedAt: z.string(),
  draft: z.boolean(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  additions: z.number(),
  deletions: z.number(),
  headRef: z.string(),
})
const snapshotRow = z.custom<PullRequest>((value) => snapshotRowSchema.safeParse(value).success)

const snapshotSchema = z.object({
  version: z.literal(SNAPSHOT_VERSION),
  state: z.enum(['open', 'closed', 'all']),
  savedAt: z.number(),
  projects: z.array(z.object({
    serverId: z.string(),
    projectRoot: z.string(),
    items: z.array(snapshotRow),
  })),
})

/**
 * The last list read for this scope, or null when there is none worth showing:
 * nothing saved, saved under a different fetch scope (a merged row must not sit
 * under Open), too old, or no longer in a shape this build can draw.
 */
export function readPrListSnapshot(
  scope: PrListScopeKey,
  state: PrListSnapshot['state'],
  now = Date.now(),
  storage: ListStorage | undefined = deviceStorage(),
): PrListSnapshot | null {
  try {
    const raw = storage?.getItem(SNAPSHOT_PREFIX + scope)
    if (!raw) return null
    const parsed = snapshotSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return null
    const snapshot = parsed.data
    if (snapshot.state !== state || now - snapshot.savedAt > SNAPSHOT_MAX_AGE_MS) return null
    return { state: snapshot.state, savedAt: snapshot.savedAt, projects: snapshot.projects }
  } catch {
    return null
  }
}

/**
 * A list row as plain data. The store's rows are reactive entities whose fields
 * are accessors, which `JSON.stringify` cannot see, so each is copied out.
 */
function snapshotRowOf(pr: PullRequest): PullRequest {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    baseRepo: { ...pr.baseRepo },
    headRepo: { ...pr.headRepo },
    author: pr.author,
    authorAvatarUrl: pr.authorAvatarUrl,
    state: pr.state,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    draft: pr.draft,
    labels: pr.labels.map(({ name, color }) => ({ name, color })),
    additions: pr.additions,
    deletions: pr.deletions,
    // The body is the one unbounded field and no row draws it.
    body: '',
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    changedFiles: pr.changedFiles,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    // Plain records (a reactive proxy serialises as its target), written out
    // by `JSON.stringify` straight after this.
    capabilities: pr.capabilities,
    viewerPermissions: pr.viewerPermissions,
    requestedReviewers: pr.requestedReviewers?.map(({ login, avatarUrl }) => ({ login, avatarUrl })),
    assignees: pr.assignees ? [...pr.assignees] : undefined,
    reviewAttention: pr.reviewAttention,
    needsMyReview: pr.needsMyReview,
    reviewStatus: pr.reviewStatus,
  }
}

/** Save an unsearched answer, capped to the first rows across its projects. */
export function writePrListSnapshot(
  scope: PrListScopeKey,
  snapshot: PrListSnapshot,
  storage: ListStorage | undefined = deviceStorage(),
): void {
  let budget = SNAPSHOT_MAX_ROWS
  const projects = snapshot.projects.flatMap((project) => {
    const items = project.items.slice(0, budget).map(snapshotRowOf)
    budget -= items.length
    return items.length > 0 ? [{ ...project, items }] : []
  })
  try {
    storage?.setItem(
      SNAPSHOT_PREFIX + scope,
      JSON.stringify({ version: SNAPSHOT_VERSION, state: snapshot.state, savedAt: snapshot.savedAt, projects }),
    )
  } catch {
    // Storage can be full or denied; the snapshot is a convenience, not a record.
  }
}
