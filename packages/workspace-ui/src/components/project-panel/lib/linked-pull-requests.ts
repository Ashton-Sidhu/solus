// Shaping for the rail's Linked card: the pull requests a session links
// (docs/plans/session-pull-requests.md). The .svelte holds markup and thin
// handlers; the row grammar lives here.
import type { SessionPullRequestLink, SessionPullRequestSource, SessionPullRequestWatchOutcome } from '@solus/contracts/session-pull-requests'
import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import { attributionLabel } from '@solus/contracts/user'
import type { LinkedPr } from '../../../contexts/prs/linked-pr'
import type { PullRequestOpenTarget } from '../../../contexts/workspace/workspace.context.svelte'

export interface LinkedPullRequestRow {
  key: string
  link: SessionPullRequestLink
  number: number
  title: string
  /** The state as one word: open, draft, merged, closed, or missing. Empty
   *  until PR sync first answers. */
  state: string
  /** Merged, closed, or missing: the work is over, so the row sits back. */
  isSettled: boolean
  /** The session watches it, and its agent wakes on news (docs/plans/pr-watch.md). */
  isWatched: boolean
  /** Full row meaning for hover, focus, and assistive technology. */
  detailLabel: string
}

function sourceLabel(link: SessionPullRequestLink): string {
  const by = link.createdBy ? attributionLabel(link.createdBy) : null
  const labels = {
    branch: "Found on the session's branch",
    created: 'Opened from this session',
    agent: by ? `Linked by ${by}` : 'Linked by the agent',
    manual: by ? `Linked by ${by}` : 'Linked by hand',
  } satisfies Record<SessionPullRequestSource, string>
  return labels[link.source]
}

function stateOf(link: SessionPullRequestLink, pr: LinkedPr | null): string {
  if (pr?.missing ?? link.missing) return 'missing'
  const observed = pr?.pullRequest ?? link.snapshot
  if (!observed) return ''
  return observed.state === 'open' && observed.draft ? 'draft' : observed.state
}

/** Open work first, then settled, each in the store's newest-first order. The
 *  rail viewport owns containment, so every link stays reachable. */
export function linkedPullRequestRows(
  links: readonly SessionPullRequestLink[],
  linkedPr: (link: SessionPullRequestLink) => LinkedPr | null,
): LinkedPullRequestRow[] {
  const rows = links.map((link): LinkedPullRequestRow => {
    const pr = linkedPr(link)
    const state = stateOf(link, pr)
    const title = pr?.title || link.title || `#${link.number}`
    return {
      key: `${link.repository}#${link.number}`,
      link,
      number: link.number,
      title,
      state,
      isSettled: state === 'merged' || state === 'closed' || state === 'missing',
      isWatched: !!link.watch,
      detailLabel: `${title}\n${link.repository}#${link.number} · ${sourceLabel(link)}${link.watch ? '\nWatched: the agent wakes on checks, reviews and conflicts' : ''}`,
    }
  })
  return [...rows.filter((row) => !row.isSettled), ...rows.filter((row) => row.isSettled)]
}

/** What `prReview.openPullRequest` takes for a link: its repository comes
 *  from the URL, so the same number in another repository is not opened. */
export function pullRequestOpenTarget(link: SessionPullRequestLink): PullRequestOpenTarget {
  return {
    number: link.number,
    title: link.title || undefined,
    url: link.url,
    expectedRepo: parseGitHubPullRequestUrl(link.url)?.baseRepo,
  }
}

/** Why the host did not start a watch a person asked for, or null when it
 *  did. Shared with no other surface: the phone words its own. */
export function watchRefusal(outcome: SessionPullRequestWatchOutcome): string | null {
  switch (outcome) {
    case 'started':
    case 'already-watching':
    case 'stopped':
      return null
    case 'session-settled': return 'This session is settled. Make it active to watch its pull requests.'
    case 'not-linked': return 'This pull request is no longer linked to the session.'
    case 'missing': return 'The code host no longer has this pull request.'
    case 'merged':
    case 'closed':
      return `This pull request is ${outcome}, so there is nothing to watch.`
  }
}
