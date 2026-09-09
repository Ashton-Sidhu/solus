// What a phone prints about the branch a session runs on. The desktop project
// rail states the same three facts in its Git section — the branch, its
// uncommitted work, and the pull request that stands for it — across three rows
// with room to spare. A phone has one mono line in the navbar and one card in
// the task sheet, so each fact is reduced here to the shortest true string.

import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import type { GitState } from '@solus/contracts/types'
import type { SessionEnvironment } from '@solus/workspace-ui/contexts/git/session-environment.store.svelte'
import { worktreeDisplayName } from '@solus/workspace-ui/lib/git-context'

type BranchEnvironment = Pick<SessionEnvironment, 'branch' | 'status' | 'isolated'>

/** The branch Git reports now, or the checkout's own while status has not
 *  answered. The same reading the desktop Environment section makes, so a
 *  switch lands on both surfaces in the same frame. */
export function mobileCurrentBranch(env: BranchEnvironment): string | null {
  return env.status === undefined ? env.branch : (env.status?.branch ?? null)
}

/** The branch as the navbar and the sheet print it. Null outside a repository;
 *  a worktree drops the `solus/` prefix the way the rail does. */
export function mobileBranchLabel(env: BranchEnvironment): string | null {
  const branch = mobileCurrentBranch(env)
  if (!branch) return env.status ? 'detached HEAD' : null
  return env.isolated ? worktreeDisplayName(branch) : branch
}

/** "3 files +12 −4", "1 file +2", or "None". Empty while status is unknown, so
 *  a row never claims a clean tree it has not read. */
export function mobileChangesSummary(status: GitState | null | undefined): string {
  if (!status) return ''
  const changes = status.uncommittedChanges
  const count = changes.files.length
  if (count === 0 && !changes.hasMoreFiles) return 'None'
  const parts = [`${count}${changes.hasMoreFiles ? '+' : ''} file${count === 1 && !changes.hasMoreFiles ? '' : 's'}`]
  if (changes.insertions > 0) parts.push(`+${changes.insertions}`)
  if (changes.deletions > 0) parts.push(`−${changes.deletions}`)
  return parts.join(' ')
}

/** What the store knows about one pull request, as this file needs it. */
export interface MobileKnownPullRequest {
  number: number
  title: string
  draft: boolean
  state: 'open' | 'closed' | 'merged'
}

export type MobilePullRequestRow =
  /** The store has described the branch's pull request and it is still open. */
  | { kind: 'open'; number: number; title: string; draft: boolean }
  /** The host found a pull request for the branch that the store has not
   *  confirmed open — still loading, or landed since. Named, never asserted. */
  | { kind: 'linked'; number: number | null; url: string }
  | { kind: 'none' }

/**
 * The pull request row. Only a store answer may say "open": provider discovery
 * on the host answers for merged and closed branches too, so `prUrl` alone is
 * "there is a pull request", and the row says exactly that until the store
 * confirms more.
 */
export function mobilePullRequestRow(
  status: Pick<GitState, 'prUrl'> | null | undefined,
  pr: MobileKnownPullRequest | null,
): MobilePullRequestRow {
  if (pr?.state === 'open') return { kind: 'open', number: pr.number, title: pr.title, draft: pr.draft }
  const url = status?.prUrl
  if (!url) return { kind: 'none' }
  return { kind: 'linked', number: parseGitHubPullRequestUrl(url)?.number ?? null, url }
}
