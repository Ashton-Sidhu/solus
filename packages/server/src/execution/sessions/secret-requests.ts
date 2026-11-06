import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { SECRET_FILE_TTL_MS, SECRET_REF_TTL_MS } from '@solus/contracts/agent-tools'
import type { ProcessUser } from '../../cli-env'
import { createLogger } from '../../logger'
import { currentIdentity } from '../../vault/acting-scope'
import { applyMemberFiles } from '../seats/member-files'
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
 * A secret asked with `delivery: 'file'` is for the agent's own commands (a CLI
 * token): it is written to a private file in the acting identity's secrets folder,
 * as that identity's OS user, and the agent gets the path. The card tells the
 * person that the agent's commands can read it. The file is removed after
 * `SECRET_FILE_TTL_MS`; the host's folder is also emptied at each process start.
 *
 * One card asks for one or more secrets, and the person saves or declines each one.
 * The card is a `question_request` of kind `secret`, so it shows and closes like
 * any request a run waits on. Its answer does not use `respondQuestion`: that
 * path reports answers to the run's orchestrator. It comes through
 * `secretRequestAnswer`, which only this module reads.
 */

interface WaitingRequest {
  sessionId: string
  /** How many secrets the card asks for; an answer has one value for each. */
  count: number
  /** One value per secret, null for a declined one; null for the whole card when the run stops. */
  resolve: (values: (string | null)[] | null) => void
}

interface StoredSecret {
  value: string
  sessionId: string
  expiresAt: number
}

interface SecretFile {
  user: ProcessUser | null
  expiresAt: number
}

const waiting = new Map<string, WaitingRequest>()
const refs = new Map<string, StoredSecret>()
/** Each file this process wrote, by path, until it is removed. */
const files = new Map<string, SecretFile>()

function sweep(now: number): void {
  for (const [ref, stored] of refs) if (stored.expiresAt <= now) refs.delete(ref)
}

/** One secret the agent asks for: what it is, for the person, and why; `file` for its own commands. */
export interface SecretAsk {
  name: string
  reason: string
  delivery?: 'ref' | 'file'
}

/** What one secret came to: saved with its ref or its file, or declined by the person. */
export type SecretOutcome =
  | { name: string; status: 'saved'; secretRef: string }
  | { name: string; status: 'saved'; path: string }
  | { name: string; status: 'declined' }

/** What a card came to: an outcome for each secret, in the order asked, or a run that stopped first. */
export type SecretRequestOutcome =
  | { secrets: SecretOutcome[] }
  | { status: 'cancelled' }

/** Shows one card for all the secrets and waits for the person, or for the run to stop. */
export async function requestSecrets(context: AgentToolContext, asks: SecretAsk[]): Promise<SecretRequestOutcome> {
  const sessionId = context.sessionId()
  if (!sessionId) throw new Error('request_secret needs a session.')
  if (!asks.length) throw new Error('request_secret needs at least one secret.')
  // The tool runs in the actor's scope: a file is theirs, readable by the processes they start.
  const identity = asks.some((ask) => ask.delivery === 'file') ? currentIdentity('a secret file') : null
  const questionId = `secret-${randomBytes(12).toString('hex')}`
  const values = await new Promise<(string | null)[] | null>((resolve) => {
    const finish = (answer: (string | null)[] | null) => {
      waiting.delete(questionId)
      resolve(answer)
    }
    waiting.set(questionId, { sessionId, count: asks.length, resolve: finish })
    if (context.abortSignal.aborted) return finish(null)
    context.abortSignal.addEventListener('abort', () => finish(null), { once: true })
    context.emit({
      type: 'question_request',
      questionId,
      kind: 'secret',
      // One field per secret: the header names it and the question says why the agent asks.
      questions: asks.map((ask) => ({
        header: ask.name,
        question: ask.reason,
        options: [],
        multiSelect: false,
        ...(ask.delivery === 'file' ? { secretDelivery: 'file' as const } : {}),
      })),
    })
  })
  context.emit({ type: 'permission_resolved', questionId })
  if (values === null) {
    log.info('secret_request_cancelled', { sessionId, questionId })
    return { status: 'cancelled' }
  }
  const now = Date.now()
  sweep(now)
  removeExpiredSecretFiles(now)
  const secrets = asks.map((ask, index): SecretOutcome => {
    const value = values[index]
    if (value === null) return { name: ask.name, status: 'declined' }
    if (identity && ask.delivery === 'file') {
      return { name: ask.name, status: 'saved', path: writeSecretFile(identity.secretFilesFolder(), identity.processUser(), value, now) }
    }
    const ref = `secretref_${randomBytes(18).toString('base64url')}`
    refs.set(ref, { value, sessionId, expiresAt: now + SECRET_REF_TTL_MS })
    return { name: ask.name, status: 'saved', secretRef: ref }
  })
  const saved = secrets.filter((secret) => secret.status === 'saved').length
  log.info('secret_request_answered', { sessionId, questionId, saved, declined: secrets.length - saved })
  return { secrets }
}

/**
 * The person's answer from the card: one value for each secret, in the order asked,
 * null for each one they decline. False when the session is not waiting on that card
 * or the answer does not fit it.
 */
export function answerSecretRequest(sessionId: string, questionId: string, values: (string | null)[]): boolean {
  const request = waiting.get(questionId)
  if (!request || request.sessionId !== sessionId) return false
  if (!Array.isArray(values) || values.length !== request.count) return false
  if (!values.every((value) => value === null || value.length > 0)) return false
  request.resolve(values)
  return true
}

/** Writes one value to a new owner-only file and keeps it until it expires. */
function writeSecretFile(folder: string, user: ProcessUser | null, value: string, now: number): string {
  const path = join(folder, randomBytes(16).toString('hex'))
  applyMemberFiles(user, [
    { kind: 'folder', path: folder, mode: 0o700 },
    { kind: 'write', path, content: value, mode: 0o600 },
  ])
  files.set(path, { user, expiresAt: now + SECRET_FILE_TTL_MS })
  // A timer for each file, so a file goes on time also when no card follows. It does not hold the process open.
  setTimeout(() => removeExpiredSecretFiles(Date.now()), SECRET_FILE_TTL_MS).unref()
  return path
}

/** Removes every secret file whose time is over. */
export function removeExpiredSecretFiles(now: number): void {
  for (const [path, file] of files) {
    if (file.expiresAt > now) continue
    try {
      applyMemberFiles(file.user, [{ kind: 'remove', path }])
      files.delete(path)
    } catch (error) {
      // Kept, so the next sweep tries again.
      log.warn('secret_file_remove_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** The value behind a secretRef, once, for the session that asked; null when it is unknown, used, expired, or another session's. */
export function takeSecretRef(ref: string, sessionId: string | null, now = Date.now()): string | null {
  sweep(now)
  const stored = refs.get(ref)
  if (!stored || stored.sessionId !== sessionId) return null
  refs.delete(ref)
  return stored.value
}
