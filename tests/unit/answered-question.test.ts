import { describe, expect, test } from 'bun:test'
import { formatAnswer } from '@solus/contracts/question-answer'
import { resolveAnswer, summarizeAnswered } from '@solus/workspace-ui/components/conversation/lib/answered-question'

/**
 * The answered card shows the choice as the option row the user picked — with
 * its consequence line — so it must recover the options from the one string
 * `formatAnswer` puts on the wire, and must not invent a match when the user
 * typed something free-form instead.
 */
const question = {
  question: 'How much of the review should land in this pass?',
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

/**
 * The card is folded shut in the transcript, so the row alone has to say which
 * decision this was and how it went. A row that loses the pick would make the
 * reader open every answered question to follow what happened.
 */
describe('summarizeAnswered', () => {
  const record = (answer: string) => ({ question, resolved: resolveAnswer(question, answer) })

  test('one question reads as the question and its pick', () => {
    expect(summarizeAnswered([record(formatAnswer('Review guides only'))])).toEqual({
      label: question.question,
      target: 'Review guides only',
    })
  })

  test('a recommended note is dropped from the pick, and a remark stays folded away', () => {
    const recommended = {
      question: 'Which slice?',
      options: [{ label: 'Everything, one pass (Recommended)' }, { label: 'Guides only' }],
    }
    expect(
      summarizeAnswered([
        {
          question: recommended,
          resolved: resolveAnswer(recommended, formatAnswer('Everything, one pass (Recommended)', 'but keep the tests')),
        },
      ]).target,
    ).toBe('Everything, one pass')
  })

  test('several questions read as a count, with every pick after the arrow', () => {
    expect(summarizeAnswered([record(formatAnswer('Guides, then tasks')), record('')])).toEqual({
      label: '2 questions',
      target: 'Guides, then tasks · left to the agent',
    })
  })

  test('free text the options never matched is still the row target', () => {
    expect(summarizeAnswered([record('do it the other way')]).target).toBe('do it the other way')
  })
})
