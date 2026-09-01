import type { ChangedFileStat } from '@solus/contracts/types'
import type { NumberedPrChecksSummary } from '@solus/contracts/checks-rpc-types'
import type * as Contracts from '@solus/contracts/providers'
import type {
  PrCommit,
  PrConversationItem,
  PrReviewer,
  PullRequestOverview,
  RepoRef,
  ReviewThread,
} from '@solus/contracts/providers'
import type { Provider } from '../providers/types'
import { CachedField } from './cached-field'

/**
 * Field lifetimes, sized near the clients' own refresh rhythm: long enough that
 * two surfaces opening the same pull request cost one host request, short
 * enough that "cached" and "fresh" never need telling apart on screen.
 */
const DETAIL_TTL_MS = 15_000
const ACTIVITY_TTL_MS = 15_000
/** A pull request's size only moves when somebody pushes to it. */
const FILE_STATS_TTL_MS = 60_000

/**
 * One pull request, as the server knows it. Identity is `(repo, number)`.
 *
 * **Everything about a pull request is the same for everyone here.** Its title,
 * state, branches, revisions, mergeability, commits, conversation, changed files
 * and check runs are facts about the repository rather than about who is
 * looking, so they are held once and shared by every client on this server —
 * which is what makes two worktrees of one repository cost one code-host request
 * rather than two.
 *
 * `viewerPermissions` is the one field that reads as an exception, since it
 * says whether *you* may merge or review this. It is shared anyway, and safely,
 * because **a Solus server has one code-host identity**: auth is per-host and
 * global (`provider-handlers.ts`, `providerForContext`) and `registry.ts` builds
 * the provider once at module level. There is no second account to confuse it
 * with. Give a client its own credential and that stops being true — this field
 * is the one to key per account, and the guards that read it are in
 * `provider-handlers.ts`.
 *
 * The entity owns its own reads and the lifetime of each field it has read. It
 * owns nothing spanning pull requests: listings, eviction and the checks poll
 * cadence belong above it.
 */
export class PullRequest {
  private readonly pullRequestField = new CachedField<Contracts.PullRequest>(DETAIL_TTL_MS)
  private readonly overviewField = new CachedField<PullRequestOverview>(DETAIL_TTL_MS)
  private readonly threadsField = new CachedField<ReviewThread[]>(ACTIVITY_TTL_MS)
  private readonly commentsField = new CachedField<PrConversationItem[]>(ACTIVITY_TTL_MS)
  private readonly commitsField = new CachedField<PrCommit[]>(ACTIVITY_TTL_MS)
  private readonly reviewersField = new CachedField<PrReviewer[]>(ACTIVITY_TTL_MS)
  private readonly changedFilesField = new CachedField<ChangedFileStat[]>(FILE_STATS_TTL_MS)
  /** The revision `changedFilesField` was last read at, where a caller named one. */
  private changedFilesSha: string | null = null
  /**
   * The latest check runs, written by the poller rather than read on demand.
   *
   * No lifetime of its own: the poller decides how often to look, from what the
   * clients say they are watching. A pull request nobody is watching keeps
   * whatever it last heard, which is what the surface would have shown anyway.
   */
  private checksSummary: NumberedPrChecksSummary | null = null

  constructor(
    readonly repo: RepoRef,
    readonly number: number,
    private readonly provider: Provider,
  ) {}

  /**
   * The pull request as a surface should render it. May be up to
   * `DETAIL_TTL_MS` old.
   *
   * Not for a guard. Anything comparing `headSha` against what a client saw, or
   * reading `viewerPermissions` to allow a write, must call `readFresh` —
   * a remembered answer is exactly what those checks exist to reject.
   */
  async read(): Promise<Contracts.PullRequest> {
    return this.pullRequestField.read(() => this.provider.review.getPullRequest(this.repo, this.number))
  }

  /**
   * The pull request as the host has it right now, bypassing the remembered
   * answer and replacing it.
   *
   * This is what optimistic concurrency and permission checks read. Access
   * granted or taken away since a page loaded is the case they guard, so the
   * question has to reach the host.
   */
  async readFresh(): Promise<Contracts.PullRequest> {
    return this.pullRequestField.read(
      () => this.provider.review.getPullRequest(this.repo, this.number),
      { force: true },
    )
  }

  async overview(): Promise<PullRequestOverview> {
    const overview = await this.overviewField.read(() =>
      this.provider.review.getPullRequestOverview(this.repo, this.number),
    )
    // An overview carries three fields a caller may ask for separately. Seed
    // them here, or reading a pull request's commits straight after opening it
    // pays for a request whose answer already arrived.
    this.pullRequestField.seed(overview.pullRequest)
    this.commitsField.seed(overview.commits)
    this.reviewersField.seed(overview.reviewers)
    return overview
  }

  async threads(): Promise<ReviewThread[]> {
    return this.threadsField.read(() => this.provider.review.listReviewThreads(this.repo, this.number))
  }

  async comments(): Promise<PrConversationItem[]> {
    return this.commentsField.read(() => this.provider.review.listComments(this.repo, this.number))
  }

  async commits(): Promise<PrCommit[]> {
    return this.commitsField.read(() => this.provider.review.listCommits(this.repo, this.number))
  }

  async reviewers(): Promise<PrReviewer[]> {
    return this.reviewersField.read(() => this.provider.review.listReviewers(this.repo, this.number))
  }

  /**
   * The per-file add/delete counts, and so the review effort derived from them.
   *
   * `atHeadSha` is the revision the caller believes it is asking about. Naming
   * one that differs from the revision the remembered counts were read at forces
   * a re-read: a push replaces the whole diff, and a size read a moment before
   * it describes a pull request that no longer exists. A caller that does not
   * know the revision — the changed-files panel, which is showing whatever is
   * current — leaves it out and takes the ordinary lifetime.
   */
  async changedFiles(atHeadSha?: string): Promise<ChangedFileStat[]> {
    const staleRevision = atHeadSha !== undefined
      && this.changedFilesSha !== null
      && this.changedFilesSha !== atHeadSha
    const stats = await this.changedFilesField.read(
      () => this.provider.review.listPullRequestFileStats(this.repo, this.number),
      { force: staleRevision },
    )
    if (atHeadSha !== undefined) this.changedFilesSha = atHeadSha
    return stats
  }

  /** The latest check runs the poller saw, or null if it has not looked yet. */
  checks(): NumberedPrChecksSummary | null {
    return this.checksSummary
  }

  /** Take what the checks poll just returned for this pull request. */
  absorbChecks(summary: NumberedPrChecksSummary): void {
    this.checksSummary = summary
  }

  /**
   * Drop every remembered field. The entity stays, because its identity is
   * still valid — only what it had read is now in doubt.
   *
   * The checks are kept: a write to a pull request does not re-run its CI, and
   * blanking them would clear the surface's check marks until the poller's next
   * turn came round.
   */
  forget(): void {
    this.pullRequestField.clear()
    this.overviewField.clear()
    this.threadsField.clear()
    this.commentsField.clear()
    this.commitsField.clear()
    this.reviewersField.clear()
    this.changedFilesField.clear()
    this.changedFilesSha = null
  }
}
