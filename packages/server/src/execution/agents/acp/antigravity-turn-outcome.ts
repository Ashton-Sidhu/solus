/**
 * How an Antigravity turn really ended (docs/plans/antigravity-provider.md §5.6).
 * agy reports an upstream API failure (a 502, a quota) as a chat message and
 * `end_turn`. Its session log ends that turn with an error step, so Solus reads
 * the steps that the turn added, read-only, from the session's own database.
 *
 * The rules port T3 Code (`pingdotgg/t3code` commit b8ef0600,
 * `apps/server/src/provider/acp/AntigravityTurnOutcome.ts` and `AntigravityProfilePaths.ts`):
 *
 *   MIT License. Copyright (c) 2026 T3 Tools Inc.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions: The above copyright
 *   notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 *   WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 */
import { lstatSync, realpathSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { createLogger } from '../../../logger'
import type { AcpTurnFailure, AcpTurnOutcomeCheck } from './acp-backend'
import type { AcpStopReason } from './acp-protocol'
import { ANTIGRAVITY_APP_DATA_DIR } from './antigravity-auth'

const log = createLogger('AntigravityTurnOutcome', 'antigravity-turn-outcome.ts')

// CORTEX_STEP_TYPE_ERROR_MESSAGE in agy's trajectory.
const ERROR_STEP_TYPE = 17
// CORTEX_STEP_TYPE_PLANNER_RESPONSE: the model answered within this turn.
const PLANNER_RESPONSE_STEP_TYPE = 15
// The error text leads the payload; a Go stack trace follows it.
const MAX_ERROR_PAYLOAD_BYTES = 16_384
// The Go harness's text of a Google API error. Status is a gRPC code or an HTTP
// status line such as "502 Bad Gateway". A message stops at the next error.
const API_ERROR = /Error (\d{3}), Message: ((?:(?!, Status: |Error \d{3}, Message: ).)+), Status: ([A-Z_]+|\d{3}[^,\n]*)/s
// agy 1.5 with a Google account writes "STATUS (code NNN): message".
const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u
// Newer agy builds attach the HTTP JSON body, pretty-printed or compact.
const ERROR_JSON_START = /\{\s*"error"\s*:/g
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/
// Claude refuses a saved thinking block without a valid signature. It stays in
// agy's history, so every later prompt to that session fails the same way.
const INVALID_THINKING_SIGNATURE = /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:([^\s\]]+)/
const RESET_DELAY = /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/
// google.rpc.RetryInfo, which a plain rate limit carries in place of a quota reset.
const RETRY_DELAY = /\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/
// agy 1.5 can give the reset only in the message: "... Resets in 4m42s.".
const RESETS_IN = /\bResets in ((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?!\w|\.\d)/
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g
const GO_DURATION_UNIT_MS = new Map([['ns', 1e-6], ['us', 1e-3], ['µs', 1e-3], ['μs', 1e-3], ['ms', 1], ['s', 1_000], ['m', 60_000], ['h', 3_600_000]])
const SESSION_ID = /^[\w-]+$/
const CONVERSATIONS = [ANTIGRAVITY_APP_DATA_DIR, 'conversations'] as const
const QUOTA_MESSAGE = 'You have reached your Antigravity quota for this period.'

const verificationErrorSchema = z.object({
  error: z.object({ code: z.literal(403), status: z.literal('PERMISSION_DENIED'), details: z.array(z.json()) }),
})
const verificationBodySchema = z.string().transform((text, context) => {
  try {
    return z.json().parse(JSON.parse(text))
  } catch {
    context.addIssue({ code: 'custom', message: 'The body is not JSON.' })
    return z.NEVER
  }
}).pipe(verificationErrorSchema)
const verificationInfoSchema = z.object({
  '@type': z.literal('type.googleapis.com/google.rpc.ErrorInfo'),
  domain: z.literal('cloudcode-pa.googleapis.com'),
  reason: z.literal('VALIDATION_REQUIRED'),
  metadata: z.object({ validation_url: z.json().optional() }).nullish(),
})
const lastIndexSchema = z.object({ idx: z.number().nullable() })
const stepSchema = z.object({ type: z.number(), payload: z.instanceof(Uint8Array).nullable() })

interface LastStep {
  type: number
  payload: Uint8Array | null
  reachedModel: boolean
}

/**
 * Proves an entry is at its literal path below the profile: each part exists
 * with the expected type and none is a link. A link could point at another
 * session's database in the same profile.
 */
function managedPath(root: string, segments: readonly string[], kind: 'file' | 'directory'): { path: string; info: Stats } | null {
  let current = root
  let info: Stats | null = null
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    info = lstatOrNull(current)
    const expectFile = kind === 'file' && index === segments.length - 1
    if (!info || info.isSymbolicLink() || (expectFile ? !info.isFile() : !info.isDirectory())) return null
  }
  return info && realpathOrNull(current) === current ? { path: current, info } : null
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** Reads the `steps` table read-only; undefined when the file has none. Throws when the file is not a database. */
function readSteps<Result>(file: string, read: (database: DatabaseSync) => Result): Result | undefined {
  const database = new DatabaseSync(file, { readOnly: true })
  try {
    database.exec('PRAGMA busy_timeout = 100')
    const hasSteps = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'").get()
    return hasSteps ? read(database) : undefined
  } finally {
    database.close()
  }
}

function lastStepIndex(database: DatabaseSync): number {
  return lastIndexSchema.safeParse(database.prepare('SELECT max(idx) AS idx FROM steps').get()).data?.idx ?? -1
}

function lastStepAfter(index: number) {
  return (database: DatabaseSync): LastStep | undefined => {
    const row = stepSchema.safeParse(database
      .prepare('SELECT step_type AS type, substr(step_payload, 1, ?) AS payload FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1')
      .get(MAX_ERROR_PAYLOAD_BYTES, index))
    if (!row.success) return undefined
    const reachedModel = !!database.prepare('SELECT 1 FROM steps WHERE idx > ? AND step_type = ? LIMIT 1').get(index, PLANNER_RESPONSE_STEP_TYPE)
    return { ...row.data, reachedModel }
  }
}

/** The reset in epoch seconds: the quota's own time, else a delay from now. */
function resetsAtFrom(text: string, nowMs: number): number | null {
  const timestamp = RESET_TIMESTAMP.exec(text)?.[1]
  const parsed = timestamp === undefined ? Number.NaN : Date.parse(timestamp)
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  const delay = RESET_DELAY.exec(text)?.[1] ?? RETRY_DELAY.exec(text)?.[1] ?? RESETS_IN.exec(text)?.[1]
  if (delay === undefined) return null
  let delayMs = 0
  for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) delayMs += Number(amount) * (GO_DURATION_UNIT_MS.get(unit!) ?? 0)
  return delayMs > 0 ? Math.floor((nowMs + delayMs) / 1000) : null
}

/** An API error as [match, HTTP status, message, status name], from either of agy's forms. */
function apiErrorOf(text: string): readonly [string, string, string, string] | null {
  const api = API_ERROR.exec(text)
  if (api) return [api[0], api[1]!, api[2]!, api[3]!]
  const status = STATUS_ERROR.exec(text)
  return status ? [status[0], status[2]!, status[3]!, status[1]!] : null
}

function balancedJsonObject(text: string, start: number): string | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/** Google's "verify your account" answer, with its link when the link is Google's own. */
function verificationOf(text: string): { url: string | null } | null {
  for (const match of text.matchAll(ERROR_JSON_START)) {
    const json = balancedJsonObject(text, match.index)
    const response = json === undefined ? null : verificationBodySchema.safeParse(json).data
    for (const detail of response?.error.details ?? []) {
      const info = verificationInfoSchema.safeParse(detail)
      if (info.success) return { url: googleVerificationUrl(z.string().safeParse(info.data.metadata?.validation_url).data) }
    }
  }
  return null
}

function googleVerificationUrl(url: string | undefined): string | null {
  if (!url || url.length > 4096 || /\p{Cc}/u.test(url)) return null
  const parsed = URL.parse(url)
  return parsed?.origin === 'https://accounts.google.com' && !parsed.username && !parsed.password ? url : null
}

/** The failure a turn's last step shows, or null when it ended as its stop reason says. */
export function antigravityTurnFailure(stopReason: AcpStopReason, step: LastStep | undefined, nowMs: number): AcpTurnFailure | null {
  const errorText = step?.type === ERROR_STEP_TYPE ? new TextDecoder().decode(step.payload ?? new Uint8Array()) : undefined
  // agy maps only the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
  if (errorText === undefined && stopReason !== 'refusal') return null
  const text = errorText ?? ''
  const apiError = apiErrorOf(text)
  if (stopReason === 'refusal' || QUOTA_EXHAUSTED.test(text)) {
    return { message: QUOTA_MESSAGE, code: apiError?.[3] ?? 'QUOTA_EXHAUSTED', usageLimit: { resetsAt: resetsAtFrom(text, nowMs) } }
  }
  if (INVALID_THINKING_SIGNATURE.test(text)) {
    return {
      message: 'Antigravity can no longer send the saved conversation of this session to the model. Start a new session to continue.',
      code: 'INVALID_THINKING_SIGNATURE',
      usageLimit: null,
    }
  }
  const verification = verificationOf(text)
  if (verification) {
    const where = verification.url ? ` at ${verification.url}` : ''
    return { message: `Verify your Google account${where}, then send the message again.`, code: 'VALIDATION_REQUIRED', usageLimit: null }
  }
  if (!apiError) return { message: 'Antigravity stopped this turn because of an error.', code: null, usageLimit: null }
  const [, httpStatus, message, status] = apiError
  const rateLimited = httpStatus === '429' || status === 'RESOURCE_EXHAUSTED'
  return { message: message.trim(), code: status, usageLimit: rateLimited ? { resetsAt: resetsAtFrom(text, nowMs) } : null }
}

/** The log as it is before the prompt: the file's identity and its last step. */
interface LogBefore {
  root: string
  identity: Pick<Stats, 'dev' | 'ino'> | null
  startIndex: number
}

function logBefore(profile: string, segments: readonly string[]): LogBefore | null {
  const root = realpathOrNull(profile)
  if (!root || !managedPath(root, CONVERSATIONS, 'directory')) return null
  const database = managedPath(root, segments, 'file')
  // The first prompt of a session creates its log. A path that exists but fails the proof is a link or another entry.
  if (!database) return lstatOrNull(join(root, ...segments)) ? null : { root, identity: null, startIndex: -1 }
  try {
    return { root, identity: database.info, startIndex: readSteps(database.path, lastStepIndex) ?? -1 }
  } catch {
    return null
  }
}

/**
 * Called before a turn's first prompt; the check it gives reads only the steps
 * the turn added. Without that evidence, a typed `refusal` still fails the turn.
 */
export function watchAntigravityTurnOutcome(profile: string, threadId: string): AcpTurnOutcomeCheck {
  const typedOnly: AcpTurnOutcomeCheck = (stopReason) => antigravityTurnFailure(stopReason, undefined, Date.now())
  if (!SESSION_ID.test(threadId)) return typedOnly
  const segments = [...CONVERSATIONS, `${threadId}.db`]
  const before = logBefore(profile, segments)
  if (!before) {
    log.warn('antigravity_session_log_unreadable', { threadId })
    return typedOnly
  }
  return (stopReason) => {
    // The same file as before the prompt, or one this prompt created.
    const after = managedPath(before.root, segments, 'file')
    const sameFile = !!after && (!before.identity || (after.info.dev === before.identity.dev && after.info.ino === before.identity.ino))
    let step: LastStep | undefined
    if (sameFile) {
      try {
        step = readSteps(after.path, lastStepAfter(before.startIndex))
      } catch {
        log.warn('antigravity_session_log_unreadable', { threadId })
      }
    }
    return antigravityTurnFailure(stopReason, step, Date.now())
  }
}
