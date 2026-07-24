import type { StatusCardState } from '../../shared/types'

export type ConflictResolverPhase = 'worktree' | 'merge' | 'session'

const CONFLICT_RESOLVER_STEPS: { id: ConflictResolverPhase; label: string }[] = [
  { id: 'worktree', label: 'Creating the PR worktree' },
  { id: 'merge', label: 'Merging the base branch' },
  { id: 'session', label: 'Starting the resolver agent' },
]

export function buildConflictResolverCard(prNumber: number, phase: ConflictResolverPhase): StatusCardState {
  const activeIndex = CONFLICT_RESOLVER_STEPS.findIndex((step) => step.id === phase)
  return {
    id: `merge-conflict-resolver-${prNumber}`,
    title: `Preparing conflict resolution for PR #${prNumber}…`,
    icon: 'git-branch',
    status: 'active',
    steps: CONFLICT_RESOLVER_STEPS.map((step, index) => ({
      id: step.id,
      label: step.label,
      status: index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'pending',
    })),
  }
}

export function buildConflictResolverErrorCard(prNumber: number, message: string): StatusCardState {
  return {
    id: `merge-conflict-resolver-${prNumber}`,
    title: `Couldn't prepare conflict resolution for PR #${prNumber}`,
    icon: 'git-branch',
    status: 'error',
    steps: [{ id: 'error', label: message, status: 'error' }],
  }
}

export function buildConflictResolutionPrompt(input: {
  number: number
  title: string
  baseRef?: string
  headRef?: string
  conflictFiles?: string[]
}): string {
  const files = input.conflictFiles ?? []
  const base = input.baseRef ? `origin/${input.baseRef}` : 'the base branch'
  const pushInstruction = input.headRef
    ? `Push the resolved branch with \`git push origin HEAD:refs/heads/${input.headRef}\`.`
    : 'Push the resolved branch to the pull request remote.'
  return [
    `Resolve the merge conflicts for PR #${input.number} ("${input.title}"). Solus has started merging ${base} into the PR worktree.`,
    files.length > 0 ? 'Conflicted files:' : 'Run `git status` to inspect the merge and identify any conflicted files.',
    ...files.map((file) => `- ${file}`),
    'Resolve the conflicts while preserving the intent of both the PR and the base branch, then run the relevant checks.',
    'Stage the resolution and conclude the merge with `git add -A && git commit --no-edit`.',
    `${pushInstruction} Do not merge the pull request itself; the user will do that after reviewing the resolution.`,
  ].join('\n')
}
