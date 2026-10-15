import type { ChangedFileStat } from '@solus/contracts/types'
import type { NumberedPrChecksSummary } from '@solus/contracts/checks-rpc-types'
import type * as Contracts from '@solus/contracts/providers'
import type {
  PrCommit,
  PrConversationItem,
  PrReviewer,
  PrStack,
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

/** A late answer must not undo a newer one: the host's `updatedAt` says which is newer. */
function newerPullRequest(previous: Contracts.PullRequest | undefined, next: Contracts.PullRequest): Contracts.PullRequest {
  return previous && Date.parse(previous.updatedAt) > Date.parse(next.updatedAt) ? previous : next
}

/**
 * `row` with the fields that the detail read takes from the base branch's
 * rules (pull-request-detail.ts): the merge methods they leave, the default
 * among them, and the approvals they require. A list or PR sync row is read
 * without those rules, so it takes them from `held` when that is a detail
 * read of the same base branch. Then a row pushed to a client never widens
 * the merge methods of the detail it shows. Only a detail read reports
 * `requiredApprovingReviewCount`, so that field tells one apart.
 */
export function withBranchRules(row: Contracts.PullRequest, held: Contracts.PullRequest | undefined): Contracts.PullRequest {
  if (row.requiredApprovingReviewCount !== undefined || held?.requiredApprovingReviewCount === undefined || held.baseRef !== row.baseRef) return row
  const capabilities = { ...row.capabilities, mergeMethods: held.capabilities.mergeMethods }
  delete capabilities.defaultMergeMethod
  if (held.capabilities.defaultMergeMethod) capabilities.defaultMergeMethod = held.capabilities.defaultMergeMethod
  return { ...row, capabilities, requiredApprovingReviewCount: held.requiredApprovingReviewCount }
}

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
  private readonly pullRequestField = new CachedField<Contracts.PullRequest>(DETAIL_TTL_MS, newerPullRequest)
  private readonly threadsField = new CachedField<ReviewThread[]>(ACTIVITY_TTL_MS)
  private readonly commentsField = new CachedField<PrConversationItem[]>(ACTIVITY_TTL_MS)
  private readonly commitsField = new CachedField<PrCommit[]>(ACTIVITY_TTL_MS)
  private readonly reviewersField = new CachedField<PrReviewer[]>(ACTIVITY_TTL_MS)
  private readonly stackField = new CachedField<PrStack | null>(ACTIVITY_TTL_MS)
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
    /** Hears every answer this entity reads from the host or is handed. */
    private readonly onRead: (pullRequest: Contracts.PullRequest) => void = () => {},
  ) {}

  /** The one detail read in flight. The pull request, its commits and its
   *  reviewers come in one answer, so a reader of any of them joins it. */
  private overviewFlight: Promise<PullRequestOverview> | null = null
  /** When the last detail read answered; 0 after `forget`. */
  private detailReadAt = 0

  /** Read the pull request with its commits and reviewers, and keep all three. */
  private loadOverview(): Promise<PullRequestOverview> {
    this.overviewFlight ??= this.provider.review.getPullRequestOverview(this.repo, this.number)
      .then((overview) => {
        this.pullRequestField.seed(overview.pullRequest)
        this.detailReadAt = Date.now()
        this.commitsField.seed(overview.commits)
        this.reviewersField.seed(overview.reviewers)
        this.onRead(overview.pullRequest)
        return overview
      })
      .finally(() => { this.overviewFlight = null })
    return this.overviewFlight
  }

  private async load(): Promise<Contracts.PullRequest> {
    return (await this.loadOverview()).pullRequest
  }

  /**
   * The pull request as a surface should render it. May be up to
   * `DETAIL_TTL_MS` old.
   *
   * Not for a guard. Anything comparing `headSha` against what a client saw, or
   * reading `viewerPermissions` to allow a write, must call `readFresh` —
   * a remembered answer is exactly what those checks exist to reject.
   */
  async read(): Promise<Contracts.PullRequest> {
    return this.pullRequestField.read(() => this.load())
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
    return this.pullRequestField.read(() => this.load(), { force: true })
  }

  /** The last answer read, however old, or undefined if nothing has read it. */
  lastRead(): Contracts.PullRequest | undefined {
    return this.pullRequestField.peek()
  }

  /**
   * The answer of a detail read that is in flight, or that answered less than
   * `maxAgeMs` ago; null when there is none. Costs no request. PR sync takes
   * it as its own read, so a pane that opens a pull request and asks to keep
   * it fresh costs one read, not two.
   */
  recentDetail(maxAgeMs: number): Promise<Contracts.PullRequest> | null {
    if (this.overviewFlight) return this.overviewFlight.then(({ pullRequest }) => pullRequest)
    const held = this.pullRequestField.peek()
    return held && Date.now() - this.detailReadAt < maxAgeMs ? Promise.resolve(held) : null
  }

  /** Take a pull request that arrived another way — a listing row, a write's
   *  response — so the next read does not pay for it again. A row that has no
   *  base branch rules, from this detail or its own, is only remembered: a
   *  surface that opens the pull request reads the detail, so it does not
   *  offer a merge method that the branch forbids. */
  seed(detail: Contracts.PullRequest): void {
    const held = this.pullRequestField.seed(withBranchRules(detail, this.pullRequestField.peek()))
    if (held.requiredApprovingReviewCount === undefined) this.pullRequestField.clear()
    this.onRead(detail)
  }

  /**
   * Composed from the fields it carries, so the pull request `prOpenReview`
   * just read fresh is reused with the commits and reviewers that came in the
   * same answer — and each part keeps its own lifetime for the callers that
   * ask for it alone. Parts that are not young share one detail read.
   */
  async overview(): Promise<PullRequestOverview> {
    const [pullRequest, commits, reviewers] = await Promise.all([
      this.read(),
      this.commits(),
      this.reviewers(),
    ])
    return { pullRequest, commits, reviewers }
  }

  /** `force` when the caller knows the remembered answer is stale, as a PR
   *  watch does when the fingerprint moved (docs/plans/pr-watch.md). */
  async threads(opts: { force?: boolean } = {}): Promise<ReviewThread[]> {
    return this.threadsField.read(() => this.provider.review.listReviewThreads(this.repo, this.number), opts)
  }

  async comments(opts: { force?: boolean } = {}): Promise<PrConversationItem[]> {
    return this.commentsField.read(() => this.provider.review.listComments(this.repo, this.number), opts)
  }

  async commits(): Promise<PrCommit[]> {
    return this.commitsField.read(async () => (await this.loadOverview()).commits)
  }

  async stack(): Promise<PrStack | null> {
    return this.stackField.read(() => this.provider.review.getPullRequestStack(this.repo, this.number))
  }

  async reviewers(): Promise<PrReviewer[]> {
    return this.reviewersField.read(async () => (await this.loadOverview()).reviewers)
  }

  /**
   * The per-file add/delete counts.
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
    this.detailReadAt = 0
    this.pullRequestField.clear()
    this.threadsField.clear()
    this.commentsField.clear()
    this.commitsField.clear()
    this.reviewersField.clear()
    this.changedFilesField.clear()
    this.changedFilesSha = null
  }
}
