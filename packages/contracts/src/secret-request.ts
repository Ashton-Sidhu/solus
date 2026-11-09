import { z } from 'zod'
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
  /** `file`: the agent's commands can read the value from a private file on the host. */
  delivery: 'ref' | 'file'
  /** The page the person opens to get the secret, such as a sign-in link. http(s) only. */
  url?: string
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
  if (!request.questions.length) return [{ name: 'A secret', reason: fallbackReason, delivery: 'ref' }]
  return request.questions.map((question) => {
    const prompt: SecretRequestPrompt = {
      name: question.header?.trim() || 'A secret',
      reason: question.question.trim() || fallbackReason,
      delivery: question.secretDelivery === 'file' ? 'file' : 'ref',
    }
    if (question.secretUrl) prompt.url = question.secretUrl
    return prompt
  })
}

/** The http(s) page a secret card may open, or null for any other text or scheme. */
export function secretPageUrl(value: string): URL | null {
  // React Native's URL has no `canParse`.
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.host !== '' ? url : null
  } catch {
    return null
  }
}

// Backticks, <angle brackets>, and markdown link targets keep their exact text;
// a bare link loses the sentence punctuation and emphasis marks after it.
const REASON_LINK = /`(https?:\/\/[^`\s]+)`|<(https?:\/\/[^>\s]+)>|\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)|(https?:\/\/[^\s<>"'`[\]]+)/gi

/** Drops trailing punctuation and `*` or `_`; a `)` stays when the link opened a matching `(`. */
function trimBareLink(link: string): string {
  let end = link.length
  while (end > 0 && '.,;:!?)*_'.includes(link[end - 1])) {
    const kept = link.slice(0, end)
    if (link[end - 1] === ')' && kept.split('(').length > kept.split(')').length - 1) break
    end -= 1
  }
  return link.slice(0, end)
}

/** The one distinct http(s) link in a reason, or undefined for none or for two or more. */
function reasonLink(reason: string): string | undefined {
  const links = new Set<string>()
  for (const [, ticked, angled, target, bare] of reason.matchAll(REASON_LINK)) {
    const link = ticked ?? angled ?? target ?? trimBareLink(bare)
    // Two spellings of one page (`https://a.dev` and `https://a.dev/`) count once.
    links.add(secretPageUrl(link)?.href ?? link)
  }
  return links.size === 1 ? [...links][0] : undefined
}

/**
 * The page a secret card offers to open: the agent's `url`, else the one link in
 * its reason. `isInReason` says that the reason already shows the raw link.
 */
export function secretRequestLink(prompt: Pick<SecretRequestPrompt, 'url' | 'reason'>): { href: string; host: string; isInReason: boolean } | null {
  const raw = prompt.url ?? reasonLink(prompt.reason)
  const url = raw === undefined ? null : secretPageUrl(raw)
  return url === null ? null : { href: url.href, host: url.host, isInReason: prompt.url === undefined }
}

/** The empty field's hint. */
export const SECRET_PLACEHOLDER = 'Paste the secret'

/**
 * The line under one field: where its value goes. A `file` secret is readable by
 * the agent's commands, so its line must not say that the agent never sees it.
 */
export function secretPrivacyNote(prompt: Pick<SecretRequestPrompt, 'delivery'>): string {
  return prompt.delivery === 'file'
    ? "Not in the transcript. The agent's commands can read it from a private file for 24 hours."
    : 'Kept on the host. The agent never sees it.'
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

/** What the transcript keeps of one secret: never a value, a ref, or a path. */
export interface SecretOutcomeRecord {
  name: string
  status: 'saved' | 'declined'
  delivery?: 'file'
}

export function isSecretTool(name: string | undefined): boolean {
  return !!name && /(?:^|[._])request_secret$/.test(name)
}

const CANCELLED_RESULT = '{"status":"cancelled"}'

const resultSchema = z.object({
  secrets: z.array(z.object({ name: z.string(), status: z.enum(['saved', 'declined']), path: z.string().optional() })),
})

/**
 * The outcomes in a `request_secret` result, empty for a card the run ended, or
 * undefined for any other text. A live result does not name its tool, so a client
 * reads this only on a `request_secret` row. The shape check comes first: every
 * tool result passes through here.
 */
export function secretOutcomesFromResult(content: string): SecretOutcomeRecord[] | undefined {
  if (content === CANCELLED_RESULT) return []
  if (!content.startsWith('{"secrets":[')) return undefined
  try {
    const parsed = resultSchema.safeParse(JSON.parse(content))
    if (!parsed.success) return undefined
    return parsed.data.secrets.map(({ name, status, path }) => (path === undefined ? { name, status } : { name, status, delivery: 'file' }))
  } catch {
    return undefined
  }
}

/** One line of the row that replaces an answered card. */
export interface SecretReceiptRow {
  name: string
  outcome: 'saved' | 'declined' | 'ended'
  label: string
}

const inputSchema = z.object({ secrets: z.array(z.object({ name: z.string() })) })

function askedNames(toolInput: string | undefined): string[] {
  try {
    return inputSchema.parse(JSON.parse(toolInput ?? '')).secrets.map((secret) => secret.name)
  } catch {
    return []
  }
}

/** The row after a card closes: one line per secret. A card the run ended has no outcomes, so its names come from the call. */
export function secretReceiptRows(outcomes: SecretOutcomeRecord[], toolInput: string | undefined): SecretReceiptRow[] {
  if (outcomes.length === 0) {
    const names = askedNames(toolInput)
    return (names.length ? names : ['Secret request']).map((name) => ({ name, outcome: 'ended', label: 'Request ended' }))
  }
  return outcomes.map(({ name, status, delivery }) => {
    if (status === 'declined') return { name, outcome: 'declined', label: 'Declined' }
    return { name, outcome: 'saved', label: delivery === 'file' ? "Saved for the agent's commands" : 'Saved securely' }
  })
}

/** The same row as one line of text, for a client whose work log has one label per call. */
export function secretReceiptText(rows: SecretReceiptRow[]): string {
  return rows.map((row) => `${row.name} · ${row.label}`).join(', ')
}
