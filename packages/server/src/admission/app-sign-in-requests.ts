import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { formatCheckCode, normalizeCheckCode, PAIR_APPROVAL_WAIT_MS } from '@solus/contracts/add-machine'
import type { AppSignInRequest } from '@solus/contracts/host-api'
import { redirectPlace, withdrawRedirect, type AuthorizationRequest } from './app-sign-in'

/**
 * Outside app sign-ins that wait for a person to approve them in their own
 * Solus client (plans/035 §0.5). The consent page starts one and shows its
 * check code and a link with its id; a signed-in client reads it by either and
 * decides it as its person. Only the page that started it, which holds the
 * wait token, gets the result. The requests live in memory: a restart ends them.
 *
 * They are not `PairApprovals`: those show to the host owner on every client,
 * and a member's sign-in must not.
 */

export const APP_SIGN_IN_REQUEST_TTL_MS = 10 * 60 * 1000
/** Anyone who reaches the consent page can start one: this bounds the memory they take. */
const MAX_OPEN = 100
/** How long a result stays for the page's next wait. */
const SETTLED_KEEP_MS = 2 * PAIR_APPROVAL_WAIT_MS

type State =
  | { kind: 'pending' }
  | { kind: 'approved'; redirect: string; keepUntil: number }
  | { kind: 'denied'; keepUntil: number }

interface Entry {
  requestId: string
  checkCode: string
  signIn: AuthorizationRequest
  expiresAt: number
  waitTokenHash: Buffer
  state: State
  /** Wakes the page's long poll when the state changes. */
  wake: Set<() => void>
}

export type AppSignInOutcome = { status: 'pending' } | { status: 'approved'; redirect: string } | { status: 'denied' } | { status: 'expired' }

const entries = new Map<string, Entry>()

/** Drops what is due. An approved code that the page never took is withdrawn. */
function sweep(now: number): void {
  for (const [requestId, entry] of entries) {
    const due = entry.state.kind === 'pending' ? entry.expiresAt : entry.state.keepUntil
    if (now < due) continue
    entries.delete(requestId)
    if (entry.state.kind === 'approved') withdrawRedirect(entry.state.redirect)
    for (const wake of entry.wake) wake()
  }
}

function pendingEntry(requestId: string, now: number): Entry | null {
  sweep(now)
  const entry = entries.get(requestId)
  return entry?.state.kind === 'pending' ? entry : null
}

/** A new waiting sign-in, or null when too many are open. */
export function startAppSignInRequest(signIn: AuthorizationRequest, now = Date.now()): { requestId: string; waitToken: string; checkCode: string; expiresAt: number } | null {
  sweep(now)
  if (entries.size >= MAX_OPEN) return null
  const open = new Set([...entries.values()].map((entry) => entry.checkCode))
  let checkCode = formatCheckCode((n) => randomInt(n))
  while (open.has(checkCode)) checkCode = formatCheckCode((n) => randomInt(n))
  // 128 bits: the id alone lets a person who may connect an app decide the sign-in.
  const requestId = randomBytes(16).toString('base64url')
  const waitToken = randomBytes(32).toString('base64url')
  const expiresAt = now + APP_SIGN_IN_REQUEST_TTL_MS
  entries.set(requestId, { requestId, checkCode, signIn, expiresAt, waitTokenHash: hashOf(waitToken), state: { kind: 'pending' }, wake: new Set() })
  return { requestId, waitToken, checkCode, expiresAt }
}

/** A sign-in that still waits, by its id or its check code; null when it is unknown, expired, or decided. */
export function readAppSignInRequest(by: { requestId: string } | { checkCode: string }, now = Date.now()): { view: AppSignInRequest; signIn: AuthorizationRequest } | null {
  sweep(now)
  let entry: Entry | null = null
  if ('requestId' in by) entry = pendingEntry(by.requestId, now)
  else {
    const checkCode = normalizeCheckCode(by.checkCode)
    entry = checkCode ? [...entries.values()].find((candidate) => candidate.state.kind === 'pending' && candidate.checkCode === checkCode) ?? null : null
  }
  if (!entry) return null
  const { signIn } = entry
  const place = redirectPlace(signIn.redirectUri)
  const view: AppSignInRequest = {
    requestId: entry.requestId,
    appName: signIn.appName,
    appId: signIn.app,
    redirectPlace: place.label,
    onThisComputer: place.onThisComputer,
    access: signIn.access,
    expiresAt: entry.expiresAt,
  }
  return { view, signIn }
}

/**
 * Decides a sign-in that still waits, once: `approve` carries the redirect with
 * the new authorization code. False when it no longer waits.
 */
export function settleAppSignInRequest(requestId: string, decision: { approve: string } | 'deny', now = Date.now()): boolean {
  const entry = pendingEntry(requestId, now)
  if (!entry) return false
  const keepUntil = now + SETTLED_KEEP_MS
  entry.state = decision === 'deny' ? { kind: 'denied', keepUntil } : { kind: 'approved', redirect: decision.approve, keepUntil }
  for (const wake of entry.wake) wake()
  return true
}

/**
 * The page's long poll: the result once there is one, else `pending` after at
 * most `waitMs`. A wrong wait token reads `expired`, as an unknown request does.
 * A result is read once.
 */
export async function waitAppSignInRequest(requestId: string, waitToken: string, signal?: AbortSignal, waitMs = PAIR_APPROVAL_WAIT_MS): Promise<AppSignInOutcome> {
  sweep(Date.now())
  const entry = entries.get(requestId)
  if (!entry || !timingSafeEqual(entry.waitTokenHash, hashOf(waitToken))) return { status: 'expired' }
  if (entry.state.kind === 'pending') {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        entry.wake.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, Math.min(waitMs, entry.expiresAt - Date.now())))
      entry.wake.add(done)
      signal?.addEventListener('abort', done, { once: true })
      if (signal?.aborted) done()
    })
  }
  sweep(Date.now())
  if (entries.get(requestId) !== entry) return { status: 'expired' }
  const state = entry.state
  if (state.kind === 'pending') return { status: 'pending' }
  entries.delete(requestId)
  return state.kind === 'approved' ? { status: 'approved', redirect: state.redirect } : { status: 'denied' }
}

export function resetAppSignInRequestsForTests(): void {
  entries.clear()
}

function hashOf(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}
