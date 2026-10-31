import type { QuestionRequest } from './types'

/**
 * A `request_secret` card (docs/plans/webhooks.md §3.6): one field per secret.
 * Every client that shows the card reads it through these rules.
 * The agent names each secret in a question's header and says why it asks in
 * the question. The values the user types never go into a draft, the
 * transcript, or the model; they are sent once with `secretRequestAnswer`,
 * never with `respondQuestion`.
 */
export interface SecretRequestPrompt {
  name: string
  reason: string
}

/** One field of the card as the user left it: a typed value, or declined. */
export interface SecretField {
  value: string
  isDeclined: boolean
}

export function isSecretRequest(request: QuestionRequest): boolean {
  return request.kind === 'secret'
}

/** One prompt per secret, in the order the agent asked. A card always has at least one. */
export function secretRequestPrompts(request: Pick<QuestionRequest, 'questions' | 'message'>): SecretRequestPrompt[] {
  const fallbackReason = request.message?.trim() || 'The agent did not say why it asks.'
  if (!request.questions.length) return [{ name: 'A secret', reason: fallbackReason }]
  return request.questions.map((question) => ({
    name: question.header?.trim() || 'A secret',
    reason: question.question.trim() || fallbackReason,
  }))
}

/** A secret is sent as typed: an empty value is not an answer. */
export function canSubmitSecret(value: string): boolean {
  return value.length > 0
}

/** The card is ready when each secret has a value or is declined. */
export function canSubmitSecrets(fields: SecretField[]): boolean {
  return fields.length > 0 && fields.every((field) => field.isDeclined || canSubmitSecret(field.value))
}

/** The answer to send: one value per secret, null for each declined one. */
export function secretAnswer(fields: SecretField[]): (string | null)[] {
  return fields.map((field) => (field.isDeclined ? null : field.value))
}
