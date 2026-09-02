import type { ReviewGuideReference } from '@solus/contracts/review'

export function reviewGuideTargetLabel(target: ReviewGuideReference['target']): string {
  return target.kind === 'working-tree'
    ? 'Working tree'
    : target.kind === 'session'
      ? 'Session changes'
      : target.kind === 'branch'
        ? 'Branch changes'
        : `Pull request #${target.number}`
}
