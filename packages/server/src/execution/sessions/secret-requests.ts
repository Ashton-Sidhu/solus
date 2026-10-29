import { randomBytes } from 'node:crypto'
import { SECRET_REF_TTL_MS } from '@solus/contracts/agent-tools'
import { createLogger } from '../../logger'
import type { AgentToolContext } from '../agents/tools/agent-tool'

const log = createLogger('SessionRuntime', 'secret-requests.ts')

/**
 * Secret requests, a session facility (docs/plans/webhooks.md §3.6): an agent asks
 * the person for a secret — an API key, a signing secret, a password — through a
 * private card. The value never goes into the transcript, the tool output, or the
 * model; the agent gets a one-use `secretRef`. A secretRef works once, only for the
 * session that asked, and ends after 15 minutes. A tool that needs a credential takes
 * a `secretRef` field and calls `takeSecretRef`; the webhook tools are the first.
 *
 * The card is a `question_request` of kind `secret`, so it shows and closes like
 * any request a run waits on. Its answer does not use `respondQuestion`: that
 * path reports answers to the run's orchestrator. It comes through
 * `secretRequestAnswer`, which only this module reads.
 */

interface WaitingRequest {
  sessionId: string
  resolve: (value: string | null) => void
}

interface StoredSecret {
  value: string
  sessionId: string
  expiresAt: number
}

const waiting = new Map<string, WaitingRequest>()
const refs = new Map<string, StoredSecret>()

function sweep(now: number): void {
  for (const [ref, stored] of refs) if (stored.expiresAt <= now) refs.delete(ref)
}

/** What a secret request came to: a saved secret and its ref, a person who declined, or a run that stopped first. */
export type SecretRequestOutcome =
  | { status: 'saved'; secretRef: string }
  | { status: 'declined' }
  | { status: 'cancelled' }

/** Shows the card and waits for the person, or for the run to stop. */
export async function requestSecret(context: AgentToolContext, request: { name: string; reason: string }): Promise<SecretRequestOutcome> {
  const sessionId = context.sessionId()
  if (!sessionId) throw new Error('request_secret needs a session.')
  const questionId = `secret-${randomBytes(12).toString('hex')}`
  let cancelled = false
  const value = await new Promise<string | null>((resolve) => {
    const finish = (answer: string | null) => {
      waiting.delete(questionId)
      resolve(answer)
    }
    const cancel = () => {
      cancelled = true
      finish(null)
    }
    waiting.set(questionId, { sessionId, resolve: finish })
    if (context.abortSignal.aborted) return cancel()
    context.abortSignal.addEventListener('abort', cancel, { once: true })
    context.emit({
      type: 'question_request',
      questionId,
      kind: 'secret',
      // The card names the secret and why the agent asks; the person may decline.
      questions: [{ header: request.name, question: request.reason, options: [], multiSelect: false }],
    })
  })
  context.emit({ type: 'permission_resolved', questionId })
  if (value === null) {
    log.info(cancelled ? 'secret_request_cancelled' : 'secret_request_declined', { sessionId, questionId })
    return { status: cancelled ? 'cancelled' : 'declined' }
  }
  const now = Date.now()
  sweep(now)
  const ref = `secretref_${randomBytes(18).toString('base64url')}`
  refs.set(ref, { value, sessionId, expiresAt: now + SECRET_REF_TTL_MS })
  log.info('secret_request_answered', { sessionId, questionId })
  return { status: 'saved', secretRef: ref }
}

/** The person's answer from the card: the value, or null to decline. False when the session is not waiting on that card. */
export function answerSecretRequest(sessionId: string, questionId: string, value: string | null): boolean {
  const request = waiting.get(questionId)
  if (!request || request.sessionId !== sessionId) return false
  if (value !== null && !value.length) return false
  request.resolve(value)
  return true
}

/** The value behind a secretRef, once, for the session that asked; null when it is unknown, used, expired, or another session's. */
export function takeSecretRef(ref: string, sessionId: string | null, now = Date.now()): string | null {
  sweep(now)
  const stored = refs.get(ref)
  if (!stored || stored.sessionId !== sessionId) return null
  refs.delete(ref)
  return stored.value
}
