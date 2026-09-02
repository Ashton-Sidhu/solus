import { describe, expect, test } from 'bun:test'
import { resolveReviewAgent } from '@solus/workspace-ui/lib/reviewAgent'

describe('review companion settings', () => {
  test('uses the exact persisted settings', () => {
    const resolved = resolveReviewAgent({
      reviewAgent: 'codex',
      reviewModel: 'gpt-5.6-sol',
      reviewReasoning: 'medium',
    })

    expect(resolved).toEqual({
      agent: 'codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
    })
  })
})
