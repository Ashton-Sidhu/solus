// What this client last heard from its host about pull requests.
//
// This is a mirror, not a cache of the code host. Since the server owns a
// `PrIndex`, a read that reaches it costs a local round trip and usually no code-host
// request at all — so this holds two much smaller jobs than the cache it replaces:
//
//   * **De-duplicate a frame.** These reads happen on render paths, where a
//     hundred callers can ask the same question before any of them is answered.
//   * **Re-ask eventually.** Comments, threads and reviewers have no push event,
//     so a surface that mounts, unmounts and mounts again has to go and look
//     rather than show what it showed the first time, forever.
//
// It holds no freshness *policy*: how long the host believes a code-host answer, and
// what a write invalidates, are the server's to decide. `deleteByPrefix` is how
// a refresh or a host event drops a project's entries here.

import type { ChangedFileStat, PrInterdiffResult } from '@solus/contracts/types'
import type {
  PrCommit,
  PrConversationItem,
  PrListPage,
  PrReviewer,
  PrReviewerCandidate,
  PullRequest,
  PullRequestOverview,
  ReviewThread,
} from '@solus/contracts/providers'

/** How long before a re-reading surface asks the host again. Deliberately not
 *  the host's own field lifetimes — this only paces local round trips. */
const REVALIDATE_MS = 30_000
export const PR_MIRROR_MAX_ENTRIES = 64
/** Interdiffs are large enough that holding sixty-four of them is the leak. */
export const PR_LARGE_MIRROR_MAX_ENTRIES = 8

interface MirrorEntry<T> {
  value?: T
  readAt: number
  inFlight?: Promise<T>
}

export class PrMirror<T> {
  private readonly entries = new Map<string, MirrorEntry<T>>()

  constructor(private readonly maxEntries: number = PR_MIRROR_MAX_ENTRIES) {}

  private isFresh(entry: MirrorEntry<T> | undefined): entry is MirrorEntry<T> & { value: T } {
    return entry?.value !== undefined && Date.now() - entry.readAt < REVALIDATE_MS
  }

  /** Reinsertion makes the map's iteration order an inexpensive LRU order. An
   *  in-flight entry is never evicted: a caller is already waiting on it. */
  private put(key: string, entry: MirrorEntry<T>): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.maxEntries) {
      const evictable = [...this.entries].find(([, candidate]) => !candidate.inFlight)
      if (!evictable) break
      this.entries.delete(evictable[0])
    }
  }

  async read(key: string, force: boolean, load: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key)
    if (!force) {
      if (this.isFresh(entry)) {
        this.put(key, entry)
        return entry.value
      }
      if (entry?.inFlight) return entry.inFlight
    }

    const inFlight = load().then((value) => {
      this.put(key, { value, readAt: Date.now() })
      return value
    })
    // Kept on the entry so a rejection clears the flight without erasing the
    // value beside it — a failed refresh must not blank what is already shown.
    void inFlight.catch(() => {
      const current = this.entries.get(key)
      if (current?.inFlight !== inFlight) return
      if (current.value === undefined) this.entries.delete(key)
      else this.put(key, { value: current.value, readAt: current.readAt })
    })
    this.put(key, { value: entry?.value, readAt: entry?.readAt ?? 0, inFlight })
    return inFlight
  }

  /** Record a value that arrived inside another response — an overview carries a
   *  detail, its commits and its reviewers. */
  seed(key: string, value: T): void {
    this.put(key, { value, readAt: Date.now() })
  }

  /** The value if it is still worth showing without asking again. Never loads,
   *  so it is safe from a render path. */
  fresh(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!this.isFresh(entry)) return undefined
    this.put(key, entry)
    return entry.value
  }

  values(prefix: string): T[] {
    const found: T[] = []
    for (const [key, entry] of this.entries) {
      if (key.startsWith(prefix) && entry.value !== undefined) found.push(entry.value)
    }
    return found
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  deleteByPrefix(prefix: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key)
  }
}

/**
 * Every kind of answer this client holds, in one place.
 *
 * One bag rather than eleven fields on `PrsStore`, so that a `PullRequest` can
 * be handed what it reads from without the store exposing its internals one
 * mirror at a time — and so "forget this project" is a single loop rather than
 * a list somebody has to remember to extend.
 */
export class PrMirrors {
  readonly list = new PrMirror<PrListPage>()
  readonly overview = new PrMirror<PullRequestOverview>()
  readonly detail = new PrMirror<PullRequest>()
  readonly commits = new PrMirror<PrCommit[]>()
  readonly reviewers = new PrMirror<PrReviewer[]>()
  readonly reviewerCandidates = new PrMirror<PrReviewerCandidate[]>()
  readonly threads = new PrMirror<ReviewThread[]>()
  readonly comments = new PrMirror<PrConversationItem[]>()
  readonly changedFiles = new PrMirror<ChangedFileStat[]>()
  readonly interdiff = new PrMirror<PrInterdiffResult>(PR_LARGE_MIRROR_MAX_ENTRIES)
  readonly viewer = new PrMirror<string>()

  /** Forget everything filed under one project. */
  forgetPrefix(prefix: string): void {
    for (const mirror of [
      this.list,
      this.overview,
      this.detail,
      this.commits,
      this.reviewers,
      this.reviewerCandidates,
      this.threads,
      this.comments,
      this.changedFiles,
      this.interdiff,
    ]) {
      mirror.deleteByPrefix(prefix)
    }
  }
}
