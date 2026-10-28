import { describe, expect, test } from 'bun:test'
import type { QuestionRequest } from '@solus/contracts/types'
import { canSubmitSecret, isSecretRequest, secretRequestPrompt } from '@solus/workspace-ui/components/conversation/lib/secret-request'

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
    expect(secretRequestPrompt(request({}))).toEqual({ name: 'GitHub webhook secret', reason: 'To verify GitHub requests.' })
    expect(secretRequestPrompt(request({ questions: [] }))).toEqual({ name: 'A secret', reason: 'The agent did not say why it asks.' })
  })

  test('an empty value is not an answer; a value is sent as typed', () => {
    expect(canSubmitSecret('')).toBe(false)
    expect(canSubmitSecret(' x ')).toBe(true)
  })
})
