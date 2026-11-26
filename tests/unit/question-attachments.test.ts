import { describe, expect, test } from 'bun:test'
import { formatAnswer, questionTakesAttachments } from '@solus/contracts/question-answer'

describe('questionTakesAttachments', () => {
  // A Claude AskUserQuestion has no kind and no responseMode. Its answer is text
  // that the provider passes to the agent as it is, so files must be offered.
  test('a callback question from a turn takes files', () => {
    expect(questionTakesAttachments({})).toBe(true)
    expect(questionTakesAttachments({ kind: 'standard' })).toBe(true)
  })

  test('a form or a card with its own answer takes no files', () => {
    for (const kind of ['mcp_form', 'mcp_url', 'secret', 'host-link', 'cloud-machine'] as const) {
      expect(questionTakesAttachments({ kind })).toBe(false)
    }
  })

  test('the files reach the agent as lines of the answer text', () => {
    expect(formatAnswer('', 'See the screenshot', ['/up/a.png', '/up/b.mov'])).toBe(
      'See the screenshot\n[Attached file: /up/a.png]\n[Attached file: /up/b.mov]',
    )
  })
})
