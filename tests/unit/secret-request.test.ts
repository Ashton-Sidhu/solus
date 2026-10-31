import { describe, expect, test } from 'bun:test'
import type { QuestionRequest } from '@solus/contracts/types'
import { canSubmitSecret, canSubmitSecrets, isSecretRequest, secretAnswer, secretRequestPrompts } from '@solus/contracts/secret-request'

function request(patch: Partial<QuestionRequest>): QuestionRequest {
  return { questionId: 'q1', questions: [{ header: 'GitHub webhook secret', question: 'To verify GitHub requests.', options: [], multiSelect: false }], kind: 'secret', ...patch }
}

// A request_secret card is answered through secretRequestAnswer, never
// respondQuestion (docs/plans/webhooks.md §3.6), so the card must be told apart.
describe('secret request card', () => {
  test('only the secret kind is a secret request', () => {
    expect(isSecretRequest(request({}))).toBe(true)
    expect(isSecretRequest(request({ kind: 'standard' }))).toBe(false)
    expect(isSecretRequest(request({ kind: undefined }))).toBe(false)
  })

  test('the header names the secret and the question says why', () => {
    expect(secretRequestPrompts(request({}))).toEqual([{ name: 'GitHub webhook secret', reason: 'To verify GitHub requests.' }])
    expect(secretRequestPrompts(request({ questions: [] }))).toEqual([{ name: 'A secret', reason: 'The agent did not say why it asks.' }])
  })

  test('an empty value is not an answer; a value is sent as typed', () => {
    expect(canSubmitSecret('')).toBe(false)
    expect(canSubmitSecret(' x ')).toBe(true)
  })

  test('a group card has one field per secret; each is typed or declined before it sends', () => {
    // WHY: the person declines only the secrets they do not want to give (docs/plans/webhooks.md §3.6).
    const group = request({ questions: [
      { header: 'Stripe key', question: 'To call the API.', options: [], multiSelect: false },
      { header: 'Slack token', question: '', options: [], multiSelect: false },
    ], message: 'For the deploy.' })
    expect(secretRequestPrompts(group)).toEqual([{ name: 'Stripe key', reason: 'To call the API.' }, { name: 'Slack token', reason: 'For the deploy.' }])
    expect(canSubmitSecrets([{ value: 'sk', isDeclined: false }, { value: '', isDeclined: false }])).toBe(false)
    expect(canSubmitSecrets([{ value: 'sk', isDeclined: false }, { value: '', isDeclined: true }])).toBe(true)
    expect(secretAnswer([{ value: 'sk', isDeclined: false }, { value: 'stale', isDeclined: true }])).toEqual(['sk', null])
  })
})
