import { describe, expect, test } from 'bun:test'
import { promptTitle } from '@solus/contracts/session-exchange'

/**
 * A session title made from a prompt is read on a one-line card that truncates
 * again at its own width. The title must never stop mid-word without a mark,
 * which is how the old 80-character cut read ("Read the file docs/tra").
 */
describe('prompt titles', () => {
  test('a short first sentence is the whole title', () => {
    expect(promptTitle('This is a short demo session to show a conversation card. Read the file docs/transcript-cards.md and reply.'))
      .toBe('This is a short demo session to show a conversation card.')
  })

  test('a long prompt is cut at a word, with an ellipsis', () => {
    const title = promptTitle(`Refactor ${'the retry backoff worker '.repeat(10)}now`, 60)
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(60)
    expect(title.slice(0, -1).endsWith(' ')).toBe(false)
    expect('the retry backoff worker'.split(' ')).toContain(title.slice(0, -1).split(' ').at(-1))
  })

  test('a prompt that fits is kept on one line, unchanged', () => {
    expect(promptTitle('Fix the flaky\n  auth test')).toBe('Fix the flaky auth test')
  })
})
