import { describe, expect, test } from 'bun:test'
import { formatAnswer } from '@solus/contracts/question-answer'
import { resolveAnswer } from '@solus/workspace-ui/components/conversation/lib/answered-question'

/**
 * The answered card shows the choice as the option row the user picked — with
 * its consequence line — so it must recover the options from the one string
 * `formatAnswer` puts on the wire, and must not invent a match when the user
 * typed something free-form instead.
 */
const question = {
  options: [
    { label: 'Review guides only', description: 'Smallest slice' },
    { label: 'Everything, one pass' },
    { label: 'Guides, then tasks' },
  ],
}

describe('resolveAnswer', () => {
  test('a chosen option comes back with its description', () => {
    expect(resolveAnswer(question, formatAnswer('Review guides only'))).toEqual({
      chosen: [question.options[0]],
      remark: '',
      deferred: false,
    })
  })

  test('a choice with a remark keeps both, even when a label holds a comma', () => {
    expect(resolveAnswer(question, formatAnswer('Everything, one pass', 'but keep the tests'))).toEqual({
      chosen: [question.options[1]],
      remark: 'but keep the tests',
      deferred: false,
    })
  })

  test('a multi-select answer maps every label, in the question order', () => {
    expect(resolveAnswer(question, formatAnswer('Guides, then tasks, Review guides only')).chosen).toEqual([
      question.options[0],
      question.options[2],
    ])
  })

  test('free text that matches no option is the whole answer, not a partial match', () => {
    expect(resolveAnswer(question, 'Review guides only for now')).toEqual({
      chosen: [],
      remark: 'Review guides only for now',
      deferred: false,
    })
  })

  test('an empty answer means the decision was left to the agent', () => {
    expect(resolveAnswer(question, '')).toEqual({ chosen: [], remark: '', deferred: true })
  })
})
