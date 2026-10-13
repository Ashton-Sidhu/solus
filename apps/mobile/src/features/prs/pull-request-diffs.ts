// Adapted from T3 Code apps/mobile/src/features/pull-requests/usePullRequestDiff.ts (MIT, see UPSTREAM.md).
import type { PrDiffChangeType, PrDiffFileContents, PullRequest } from '@solus/contracts/providers'
import { Listeners } from '../../lib/listeners'
import { projectContext } from '../conversation/lib/ipc-context'
import type { HostConnection } from '../hosts/host-connections'
import { nextDiffCursor, retainPullRequestDiffPage, type PullRequestDiffPage } from './lib/pull-request-diff-pages'
import { memoryPullRequestCacheDatabase, PullRequestCache } from './pull-request-cache'
import { detailKey, type PullRequestRef } from './pull-request-directory'
import { HostReads, IDLE, UNREACHABLE, type LoadState } from './pull-request-reads'

/**
 * The diff of one pull request, or of one of its commits, in pages. The
 * diff is read for the revision the person was shown (`baseSha`/`headSha`
 * from the overview): the host refuses a head that moved, so a diff never
 * mixes two revisions.
 */

export interface PullRequestDiffRef extends PullRequestRef {
  /** One commit of the pull request; absent for the whole pull request. */
  commitSha?: string
}

export type PullRequestRevision = Pick<PullRequest, 'baseSha' | 'headSha'>

export interface PullRequestDiff {
  revision: PullRequestRevision
  pages: readonly PullRequestDiffPage[]
}

export interface DiffFile {
  oldPath: string
  newPath: string
  changeType: PrDiffChangeType
}

function diffKey(ref: PullRequestDiffRef): string {
  return `${detailKey(ref)}\u0000${ref.commitSha ?? ''}`
}

function diffCacheKey(ref: PullRequestDiffRef): string {
  return `diff:${ref.projectPath}:${ref.number}:${ref.commitSha ?? ''}`
}

export class PullRequestDiffs {
  readonly changes = new Listeners()
  private readonly diffs = new Map<string, LoadState<PullRequestDiff>>()
  private readonly reads: HostReads

  constructor(
    private readonly connectionFor: (hostId: string) => HostConnection | null,
    private readonly organizationId: () => string | null,
    private readonly cache: PullRequestCache = new PullRequestCache(memoryPullRequestCacheDatabase()),
  ) {
    this.reads = new HostReads(this.changes, connectionFor, cache)
  }

  diffOf = (ref: PullRequestDiffRef): LoadState<PullRequestDiff> => this.diffs.get(diffKey(ref)) ?? IDLE

  /** The first page for this revision. Pages read before are dropped, as a
   *  pull to refresh does. */
  async load(ref: PullRequestDiffRef, revision: PullRequestRevision): Promise<void> {
    await this.reads.read(this.diffs, diffKey(ref), ref.hostId, diffCacheKey(ref), async (connection) => {
      const slice = await connection.api.prGetDiff(this.context(ref), { number: ref.number, ...revision, commitSha: ref.commitSha })
      return { revision, pages: retainPullRequestDiffPage([], null, slice) }
    })
  }

  /** True when the provider has another page after the pages read. */
  canLoadMore(ref: PullRequestDiffRef): boolean {
    const state = this.diffOf(ref)
    return state.kind === 'loaded' && nextDiffCursor(state.value.pages) !== null
  }

  /** The next page, added after the pages already read. */
  async loadMore(ref: PullRequestDiffRef): Promise<void> {
    await this.reads.read(this.diffs, diffKey(ref), ref.hostId, diffCacheKey(ref), async (connection, previous) => {
      const cursor = previous ? nextDiffCursor(previous.pages) : null
      if (!previous || cursor === null) throw new Error('There are no more changes to read.')
      const slice = await connection.api.prGetDiff(this.context(ref), { number: ref.number, ...previous.revision, commitSha: ref.commitSha, cursor })
      return { revision: previous.revision, pages: retainPullRequestDiffPage(previous.pages, cursor, slice) }
    })
  }

  /**
   * Both sides of one file at the diff's revision, to show more context
   * than the patch has. The device copy answers when the host cannot.
   */
  async fileContents(ref: PullRequestDiffRef, file: DiffFile): Promise<PrDiffFileContents> {
    const state = this.diffOf(ref)
    const diff = state.kind === 'loaded' ? state.value : state.kind === 'idle' ? null : state.previous
    if (!diff) throw new Error('Read the diff before its files.')
    const cacheKey = `contents:${ref.projectPath}:${ref.number}:${ref.commitSha ?? ''}:${diff.revision.headSha}:${file.oldPath}:${file.newPath}`
    const connection = this.connectionFor(ref.hostId)
    try {
      if (!connection) throw new Error(UNREACHABLE)
      const contents = await connection.api.prGetDiffFileContents(this.context(ref), { number: ref.number, ...diff.revision, commitSha: ref.commitSha, ...file })
      void this.cache.write(ref.hostId, cacheKey, contents)
      return contents
    } catch (error) {
      const kept = await this.cache.read<PrDiffFileContents>(ref.hostId, cacheKey)
      if (kept) return kept
      throw error
    }
  }

  forgetHost(hostId: string): void {
    this.reads.forgetHost(this.diffs, hostId)
    this.changes.notify()
  }

  private context(ref: PullRequestRef) {
    return projectContext(ref.projectPath, this.organizationId())
  }
}
