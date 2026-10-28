import type { QuestionRequest } from '@solus/contracts/types'

/**
 * A `request_secret` card (docs/plans/webhooks.md §3.6): the agent names the
 * secret in the header and says why it asks in the question. The value the
 * user types never goes into a draft, the transcript, or the model; it is sent
 * once with `secretRequestAnswer`, never with `respondQuestion`.
 */
export interface SecretRequestPrompt {
  name: string
  reason: string
}

export function isSecretRequest(request: QuestionRequest): boolean {
  return request.kind === 'secret'
}

export function secretRequestPrompt(request: QuestionRequest): SecretRequestPrompt {
  const question = request.questions[0]
  return {
    name: question?.header?.trim() || 'A secret',
    reason: question?.question.trim() || request.message?.trim() || 'The agent did not say why it asks.',
  }
}

/** A secret is sent as typed: an empty value is not an answer. */
export function canSubmitSecret(value: string): boolean {
  return value.length > 0
}
