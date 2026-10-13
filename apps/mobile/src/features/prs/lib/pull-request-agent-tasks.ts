// Adapted from T3 Code apps/mobile/src/features/pull-requests/pullRequestAgentTasks.ts (MIT, see UPSTREAM.md).
import type { PullRequest } from '@solus/contracts/providers'
import { hasMergeConflicts } from './pull-request-permissions'

/**
 * Agent work started from a pull request. Each task runs in a new session in
 * the pull request's own checkout on the host. The first prompt names the
 * pull request, because a mobile session carries no pull request context.
 * The conflict prompt follows the web client's
 * (`workspace-ui/src/lib/pr-conflict-resolution.ts`).
 */

export type PullRequestAgentTask = 'ask' | 'explain' | 'feedback' | 'conflicts'

export interface PullRequestAgentAction {
  task: PullRequestAgentTask
  title: string
  disabled: boolean
}

/** The tasks a pull request offers. A task that changes the branch needs a
 *  head the person may push to (`canUpdateHead`). */
export function pullRequestAgentActions(pr: PullRequest, canUpdateHead: boolean): PullRequestAgentAction[] {
  const open = pr.state === 'open'
  return [
    { task: 'ask', title: 'Ask a question', disabled: false },
    { task: 'explain', title: 'Explain this pull request', disabled: false },
    { task: 'feedback', title: 'Address feedback', disabled: !open || !canUpdateHead },
    { task: 'conflicts', title: 'Resolve conflicts', disabled: !open || !canUpdateHead || !hasMergeConflicts(pr) },
  ]
}

function pullRequestLine(pr: Pick<PullRequest, 'number' | 'title' | 'url' | 'headRef' | 'baseRef'>): string {
  return `Pull request #${pr.number} ("${pr.title}", ${pr.url}): branch ${pr.headRef} into ${pr.baseRef}. This session runs in a checkout of its head.`
}

/**
 * The first prompt of the session. `question` is the person's own words: it
 * is the whole request for `ask`, and an addition for the other tasks.
 */
export function pullRequestAgentPrompt(
  task: Exclude<PullRequestAgentTask, 'conflicts'>,
  pr: Pick<PullRequest, 'number' | 'title' | 'url' | 'headRef' | 'baseRef'>,
  question = '',
): string {
  const request = {
    ask: '',
    explain: 'Explain this pull request. Read the diff and walk through its purpose, the changes, the risks, and what I should read closely before I approve it. Do not change any code.',
    feedback: `Address the actionable review feedback and failing checks on this pull request. Run \`gh pr view ${pr.number} --comments\` and read every unresolved inline thread. Skip resolved feedback, and verify each finding against the current code before you change it. Keep the fixes focused, run the relevant checks, and commit the changes. Do not push, reply to, or resolve threads: I will look at the commit first.`,
  }[task]
  return [pullRequestLine(pr), request, question.trim()].filter(Boolean).join('\n\n')
}

/** The prompt for a session in the conflict worktree the host prepared. */
export function conflictResolutionPrompt(input: { number: number; title: string; baseRef?: string; headRef?: string; conflictFiles?: string[] }): string {
  const files = input.conflictFiles ?? []
  const base = input.baseRef ? `origin/${input.baseRef}` : 'the base branch'
  const push = input.headRef
    ? `Push the resolved branch with \`git push origin HEAD:refs/heads/${input.headRef}\`.`
    : 'Push the resolved branch to the pull request remote.'
  return [
    `Resolve the merge conflicts for PR #${input.number} ("${input.title}"). Solus has started merging ${base} into the PR worktree.`,
    files.length > 0 ? 'Conflicted files:' : 'Run `git status` to inspect the merge and identify any conflicted files.',
    ...files.map((file) => `- ${file}`),
    'Resolve the conflicts while preserving the intent of both the PR and the base branch, then run the relevant checks.',
    'Stage the resolution and conclude the merge with `git add -A && git commit --no-edit`.',
    `${push} Do not merge the pull request itself; the user will do that after reviewing the resolution.`,
  ].join('\n')
}
