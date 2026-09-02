import { describe, expect, test } from 'bun:test'
import { directReviewRequest } from '@solus/workspace-ui/components/review/lib/direct-review-command'

describe('direct review command', () => {
  test('carries raw skill input into a working-tree review', () => {
    expect(directReviewRequest('/solus-review focus on migrations')).toEqual({
      target: { kind: 'working-tree' },
      instructions: 'focus on migrations',
    })
    expect(directReviewRequest('/solus:solus-review\ncheck accessibility')).toEqual({
      target: { kind: 'working-tree' },
      instructions: 'check accessibility',
    })
  })

  test('keeps target arguments separate from review instructions', () => {
    expect(directReviewRequest('/review:branch main\nfocus on API compatibility')).toEqual({
      target: { kind: 'branch', targetBranch: 'main' },
      instructions: 'focus on API compatibility',
    })
    expect(directReviewRequest('/review https://github.com/acme/app/pull/42\ncheck the migration')).toEqual({
      target: {
        kind: 'pr',
        host: 'github.com',
        owner: 'acme',
        repo: 'app',
        number: 42,
        url: 'https://github.com/acme/app/pull/42',
      },
      instructions: 'check the migration',
    })
  })

  test('does not take over prose or an incomplete PR command', () => {
    expect(directReviewRequest('Please run /review')).toBeNull()
    expect(directReviewRequest('/review:pr')).toBeNull()
  })
})
