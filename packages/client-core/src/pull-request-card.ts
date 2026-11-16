import type { PullRequest } from '@solus/contracts/providers'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import { pullRequestChipState, type PullRequestChipState } from './session-artifact-chips'

/**
 * The card a turn shows for a pull request its session linked
 * (docs/plans/session-artifacts.md): the state, the pull request, its size,
 * and the session's watch on it (docs/plans/pr-watch.md). Desktop, web, and
 * the phone draw the same card from this model.
 */
export interface PullRequestCard {
  /** What PR sync last saw; null until it first answers. */
  state: PullRequestChipState | null
  stateLabel: string | null
  /** `owner/repo #123`. */
  reference: string
  title: string
  /** The author's login, once a full read of the pull request answered. */
  author: string | null
  /** When the pull request was opened, in ms; null until a full read answered. */
  openedAt: number | null
  /** `31 files`; null until the code host counted them. */
  filesLabel: string | null
  /** `+2,682` and `−1,509`; null until a full read answered. */
  additionsLabel: string | null
  deletionsLabel: string | null
  /** `watching` while the session watches it; `available` when a watch can
   *  start; `unavailable` when the pull request is merged, closed, or gone. */
  watch: 'watching' | 'available' | 'unavailable'
}

const STATE_LABEL = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
  missing: 'Missing',
} as const satisfies { [State in PullRequestChipState]: string }

/** What the footer says while a watch can start. */
export const WATCH_OFFER = 'The agent can fix failing checks and reply to review comments on this pull request.'
/** What the footer says while the session watches the pull request. */
export const WATCHING_NOTE = 'Watching. The agent wakes when checks fail or a reviewer comments.'

const counts = new Intl.NumberFormat('en-US')

/** `host/owner/repo` as a person reads it: `owner/repo`. */
function repositoryName(repository: string): string {
  return repository.split('/').slice(1).join('/') || repository
}

/** The full read when it is as new as the link's snapshot; a newer snapshot
 *  wins, so a stale read does not show an old state. */
function freshRead(link: SessionPullRequestLink, pullRequest: PullRequest | null): PullRequest | null {
  if (!pullRequest || link.missing) return null
  if (link.snapshot && Date.parse(link.snapshot.updatedAt) > Date.parse(pullRequest.updatedAt)) return null
  return pullRequest
}

/** The size and author only a full read carries; none of it without one. */
function readFacts(pullRequest: PullRequest | null): Pick<PullRequestCard, 'author' | 'openedAt' | 'filesLabel' | 'additionsLabel' | 'deletionsLabel'> {
  if (!pullRequest) return { author: null, openedAt: null, filesLabel: null, additionsLabel: null, deletionsLabel: null }
  const files = pullRequest.changedFiles
  return {
    author: pullRequest.author || null,
    openedAt: Date.parse(pullRequest.createdAt) || null,
    filesLabel: files === null ? null : `${counts.format(files)} ${files === 1 ? 'file' : 'files'}`,
    additionsLabel: `+${counts.format(pullRequest.additions)}`,
    deletionsLabel: `−${counts.format(pullRequest.deletions)}`,
  }
}

/** `pullRequest` is the full read of the pull request when a client has one;
 *  the card shows less without it. */
export function pullRequestCard(link: SessionPullRequestLink, pullRequest: PullRequest | null): PullRequestCard {
  const read = freshRead(link, pullRequest)
  const state = read
    ? (read.state === 'open' && read.draft ? 'draft' : read.state)
    : pullRequestChipState(link)
  const isWatchable = state !== 'merged' && state !== 'closed' && state !== 'missing'
  return {
    state,
    stateLabel: state ? STATE_LABEL[state] : null,
    reference: `${repositoryName(link.repository)} #${link.number}`,
    title: read?.title || link.title || `#${link.number}`,
    ...readFacts(pullRequest),
    watch: link.watch ? 'watching' : isWatchable ? 'available' : 'unavailable',
  }
}
