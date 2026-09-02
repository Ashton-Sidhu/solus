import type { ReviewGuideStatus } from '@solus/contracts/review'

export function reviewSessionStatus(status: ReviewGuideStatus): 'running' | 'completed' {
  return status === 'queued' || status === 'generating' ? 'running' : 'completed'
}
