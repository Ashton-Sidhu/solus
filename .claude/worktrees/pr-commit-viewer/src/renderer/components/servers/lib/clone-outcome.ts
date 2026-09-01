import type { CloneAuth } from '../../../../shared/types'

export type CloneFailure =
  /** The host reached the code host but wasn't allowed in — credentials, not connectivity. */
  | { kind: 'auth'; title: string; detail: string }
  /** A folder is already sitting where the clone would land, and Solus never registered it. */
  | { kind: 'occupied'; title: string; detail: string }
  /** Anything else: the host's own words, because an unfamiliar failure must not be paraphrased. */
  | { kind: 'other'; title: string; detail: string }

/** Solus's own words when it refuses to clobber a folder — see `assertEmptyDestination`. */
const OCCUPIED_RE = /already exists and is not empty/i

/**
 * Git says "authentication failed" in several dialects, and a private repo that
 * the host can't see is reported as a plain 404 — indistinguishable from a typo,
 * but far more likely on a host that was never given credentials.
 */
const AUTH_PATTERNS = [
  /authentication failed/i,
  /could not read username/i,
  /could not read password/i,
  /permission denied \(publickey\)/i,
  /repository not found/i,
  /access denied/i,
  /terminal prompts disabled/i,
]

/**
 * A git error is a dead end for anyone who didn't cause it. Naming which of the
 * two recoverable failures happened is what turns the message into an action —
 * everything else keeps the host's own words.
 */
export function classifyCloneFailure(message: string, hostLabel: string): CloneFailure {
  const host = hostLabel || 'This host'
  if (OCCUPIED_RE.test(message)) {
    return {
      kind: 'occupied',
      title: `${host} already has a folder here`,
      detail: message,
    }
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      kind: 'auth',
      title: `${host} can’t read this repo yet`,
      detail: message,
    }
  }
  return { kind: 'other', title: `Couldn’t clone onto ${host}`, detail: message }
}

/**
 * An anonymous clone read a public repo with no credentials at all, so the
 * session works right up until the push — which is 25 minutes later, at PR time.
 * Saying so at clone time is the whole point of reporting how a clone
 * authenticated.
 */
export function pushCapabilityNote(auth: CloneAuth, hostLabel: string): string | null {
  if (auth !== 'anonymous') return null
  return `${hostLabel || 'This host'} can read this repo but can’t push yet.`
}
