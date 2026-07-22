import { describe, expect, test } from 'bun:test'
import { buildPrCommentsFixPrompt } from '../../src/renderer/contexts/pr-fix-session'

describe('PR fix session prompt', () => {
  test('preserves every review instruction while making commit ownership explicit', () => {
    const prompt = buildPrCommentsFixPrompt(
      { number: 42, title: 'Keep retries bounded' },
      {
        body: 'The retry loop needs a terminal condition.',
        comments: [{
          id: 'comment-1',
          path: 'src/retry.ts',
          startLine: 10,
          line: 14,
          side: 'new',
          body: 'Return the last error once the budget is exhausted.',
          createdAt: 1,
        }],
      },
    )

    expect(prompt).toContain('PR #42: Keep retries bounded')
    expect(prompt).toContain('The retry loop needs a terminal condition.')
    expect(prompt).toContain('src/retry.ts:10-14 (RIGHT)')
    expect(prompt).toContain('Return the last error once the budget is exhausted.')
    expect(prompt).toContain('Call read_pr for PR #42')
    expect(prompt).toContain('Call list_pr_threads for PR #42')
    expect(prompt).toContain('Commit the completed changes.')
    expect(prompt).toContain('Do NOT push, reply to, or resolve PR threads')
  })

  test('can start from live PR feedback without locally supplied review drafts', () => {
    const prompt = buildPrCommentsFixPrompt({ number: 7, title: 'Tighten validation' })

    expect(prompt).toContain('Address all actionable review feedback for PR #7')
    expect(prompt).toContain('Call read_pr for PR #7')
    expect(prompt).toContain('Call list_pr_threads for PR #7')
    expect(prompt).not.toContain('Feedback that triggered this run')
  })
})
