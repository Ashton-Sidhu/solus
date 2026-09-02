import { describe, expect, test } from 'bun:test'
import type { ReviewGuideStatusEvent } from '@solus/contracts/review'
import {
  reviewGuideCardPresentation,
  reviewGuideCardSubtitle,
} from '@solus/workspace-ui/components/review/lib/review-guide-card'

function status(
  overrides: Partial<ReviewGuideStatusEvent>,
): ReviewGuideStatusEvent {
  return {
    repoRoot: '/repo',
    key: 'session-provider-session',
    scope: 'session',
    status: 'queued',
    headSha: 'head-a',
    updatedAt: 1,
    ...overrides,
  }
}

describe('review guide card presentation', () => {
  test('shows the model and reasoning used for generation', () => {
    expect(reviewGuideCardSubtitle('Analyzing session changes', 'GPT 5.6 Sol', 'medium'))
      .toBe('Analyzing session changes · GPT 5.6 Sol · Medium')
  })

  test('reports live authoring as progress, not failure', () => {
    expect(reviewGuideCardPresentation(status({
      status: 'generating',
      step: 'analyzing',
    }))).toEqual({
      statusLabel: 'Analyzing',
      subtitle: 'Analyzing session changes',
      canRetry: false,
    })
  })

  test('reserves failure copy and retry for terminal states', () => {
    expect(reviewGuideCardPresentation(status({
      status: 'failed',
      error: 'Author stopped',
    }))).toEqual({
      statusLabel: 'Failed',
      subtitle: 'Author stopped',
      canRetry: true,
    })
  })
})
