import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AcpStopReason } from '../../packages/server/src/execution/agents/acp/acp-protocol'
import { watchAntigravityTurnOutcome } from '../../packages/server/src/execution/agents/acp/antigravity-turn-outcome'

// agy reports an upstream failure as an answer and `end_turn`; only its session
// log shows the error step. These payloads follow T3 Code's fixtures, which
// trim real agy 1.4.5 and 1.5 error steps.
const USER_INPUT = 14
const PLANNER_RESPONSE = 15
const TOOL = 8
const ERROR_MESSAGE = 17

const errorPayload = (error: string) => Buffer.concat([
  Buffer.from([0x0a, 0x24]),
  Buffer.from(`Agent execution terminated due to error.\u0012agent executor error: ${error}: ${error}\n(1) attached stack trace\n  -- stack trace:`),
])
// An unparsable reset time must not hide the reset delay, nor a retry delay outrank it.
const QUOTA_ERROR = errorPayload('Error 429, Message: Quota exhausted for test model., Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.RetryInfo retryDelay:42s] map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:googleapis.com metadata:map[quotaResetDelay:3600s quotaResetTimeStamp:soon] reason:QUOTA_EXHAUSTED]]')
const DATED_QUOTA_ERROR = errorPayload('Error 429, Message: Quota exhausted for test model., Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:googleapis.com metadata:map[quotaResetDelay:3600s quotaResetTimeStamp:2026-11-09T01:05:00Z] reason:QUOTA_EXHAUSTED]]')
const RATE_LIMIT_ERROR = errorPayload('Error 429, Message: Resource has been exhausted (e.g. check quota)., Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:cloudcode-pa.googleapis.com reason:RATE_LIMIT_EXCEEDED] map[@type:type.googleapis.com/google.rpc.RetryInfo retryDelay:42s]]')
const STATUS_QUOTA_ERROR = Buffer.concat([Buffer.from([0x12, 0x6e]), Buffer.from('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4m42s.')])
const INVALID_ARGUMENT_ERROR = errorPayload('Error 400, Message: Request contains an invalid argument., Status: INVALID_ARGUMENT, Details: []')
const BAD_GATEWAY_ERROR = Buffer.concat([
  errorPayload('Error 502, Message: Bad Gateway: Failed to connect to backend API, Status: 502 Bad Gateway, Details: []'),
  Buffer.from('\nThe model is currently unreachable.'),
])
const STATUS_NOT_FOUND_ERROR = Buffer.concat([
  Buffer.from([0x12, 0x37]),
  Buffer.from('NOT_FOUND (code 404): Requested entity was not found.\u001a\u0080\u0001HTTP 404 Not Found\n\n{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}'),
])
const MISSING_SIGNATURE_ERROR = errorPayload('Error 400, Message: {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0.thinking.signature: Field required"}}, Status: INVALID_ARGUMENT, Details: []')
const INVALID_SIGNATURE_ERROR = errorPayload('Error 400, Message: {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.0: Invalid `signature` in `thinking` block"}}, Status: INVALID_ARGUMENT, Details: []')
// The model's answer that quotes agy's quota notice is an ordinary response.
const QUOTED_NOTICE = Buffer.from('Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 1 hour.')
const VERIFICATION_URL = 'https://accounts.google.com/v3/signin/continue?plt=fixture&flowName=GlifWebSignIn'

function verificationError(url: string | undefined, compact = false): Buffer {
  const response = {
    error: {
      code: 403,
      details: [
        { '@type': 'type.googleapis.com/google.rpc.Help', links: [] },
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', domain: 'cloudcode-pa.googleapis.com', metadata: { validation_url: url }, reason: 'VALIDATION_REQUIRED' },
      ],
      message: 'Verify your account to continue.',
      status: 'PERMISSION_DENIED',
    },
  }
  const body = compact ? JSON.stringify(response) : JSON.stringify(response, null, 2)
  return errorPayload(`Verification Required\u0012PERMISSION_DENIED (code 403): Verify your account to continue.\u001aHTTP 403 Forbidden\n\n${body}\n`)
}

type Step = readonly [number, Uint8Array]
const SESSION = 'e6aba774-5472-4277-b6ee-27b2e05570a7'
const input: Step = [USER_INPUT, Buffer.from('Run the fixture.')]
const reply: Step = [PLANNER_RESPONSE, Buffer.from('FIXTURE_OK')]

function profileWithLog() {
  const profile = mkdtempSync(join(tmpdir(), 'agy-outcome-'))
  const conversations = join(profile, 'antigravity-acp', 'conversations')
  mkdirSync(conversations, { recursive: true })
  const append = (sessionId: string, steps: readonly Step[]) => {
    const database = new DatabaseSync(join(conversations, `${sessionId}.db`))
    try {
      database.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)')
      const insert = database.prepare('INSERT INTO steps (step_type, step_payload) VALUES (?, ?)')
      for (const [type, payload] of steps) insert.run(type, payload)
    } finally {
      database.close()
    }
  }
  /** One turn: watch before the prompt, then agy writes its steps, then the check reads them. */
  const turn = (steps: readonly Step[], stopReason: AcpStopReason = 'end_turn') => {
    const check = watchAntigravityTurnOutcome(profile, SESSION)
    append(SESSION, steps)
    return check(stopReason)
  }
  return { profile, conversations, append, turn, remove: () => rmSync(profile, { recursive: true, force: true }) }
}

/** The reset a delay gives, in epoch seconds, measured around the call. */
function resetAfter(delayMs: number, run: () => { usageLimit: { resetsAt: number | null } | null } | null) {
  const before = Math.floor((Date.now() + delayMs) / 1000)
  const resetsAt = run()?.usageLimit?.resetsAt ?? null
  const after = Math.floor((Date.now() + delayMs) / 1000)
  expect(resetsAt).not.toBeNull()
  expect(resetsAt!).toBeGreaterThanOrEqual(before)
  expect(resetsAt!).toBeLessThanOrEqual(after)
}

describe('Antigravity turn outcome', () => {
  test('a turn whose own steps end well is a success, even when the answer quotes a quota notice', () => {
    const log = profileWithLog()
    expect(log.turn([input, reply])).toBeNull()
    expect(log.turn([input, [ERROR_MESSAGE, INVALID_ARGUMENT_ERROR]])).not.toBeNull()
    // The earlier error step is outside this turn.
    expect(log.turn([input, [PLANNER_RESPONSE, QUOTED_NOTICE]])).toBeNull()
    log.remove()
  })

  test('a quota or a rate limit parks the run until its reset', () => {
    const log = profileWithLog()
    log.turn([input, reply])
    resetAfter(3_600_000, () => log.turn([input, [ERROR_MESSAGE, QUOTA_ERROR]]))
    expect(log.turn([input, [ERROR_MESSAGE, QUOTA_ERROR]])).toMatchObject({ message: 'You have reached your Antigravity quota for this period.', code: 'RESOURCE_EXHAUSTED' })
    resetAfter(282_000, () => log.turn([input, [ERROR_MESSAGE, STATUS_QUOTA_ERROR]]))
    resetAfter(42_000, () => log.turn([input, [ERROR_MESSAGE, RATE_LIMIT_ERROR]]))
    expect(log.turn([input, [ERROR_MESSAGE, RATE_LIMIT_ERROR]])?.message).toBe('Resource has been exhausted (e.g. check quota).')
    // A quota's own reset time wins over its delay.
    expect(log.turn([input, [ERROR_MESSAGE, DATED_QUOTA_ERROR]])?.usageLimit).toEqual({ resetsAt: Date.parse('2026-11-09T01:05:00Z') / 1000 })
    // A completed tool before the error does not hide it.
    expect(log.turn([input, reply, [TOOL, Buffer.from('ok')], [ERROR_MESSAGE, QUOTA_ERROR]])?.usageLimit).not.toBeNull()
    log.remove()
  })

  test('another upstream error fails the run with the error the API gave', () => {
    const log = profileWithLog()
    log.turn([input, reply])
    expect(log.turn([input, [ERROR_MESSAGE, INVALID_ARGUMENT_ERROR]])).toEqual({ message: 'Request contains an invalid argument.', code: 'INVALID_ARGUMENT', usageLimit: null })
    expect(log.turn([input, [ERROR_MESSAGE, BAD_GATEWAY_ERROR]])).toMatchObject({ message: 'Bad Gateway: Failed to connect to backend API', usageLimit: null })
    expect(log.turn([input, [ERROR_MESSAGE, STATUS_NOT_FOUND_ERROR]])).toEqual({ message: 'Requested entity was not found.', code: 'NOT_FOUND', usageLimit: null })
    for (const error of [MISSING_SIGNATURE_ERROR, INVALID_SIGNATURE_ERROR]) {
      expect(log.turn([input, [ERROR_MESSAGE, error]])?.code).toBe('INVALID_THINKING_SIGNATURE')
    }
    log.remove()
  })

  test("Google's account check names only Google's own link", () => {
    const log = profileWithLog()
    log.turn([input, reply])
    expect(log.turn([input, [ERROR_MESSAGE, verificationError(VERIFICATION_URL)]])?.message).toBe(`Verify your Google account at ${VERIFICATION_URL}, then send the message again.`)
    expect(log.turn([input, [ERROR_MESSAGE, verificationError(VERIFICATION_URL, true)]])?.code).toBe('VALIDATION_REQUIRED')
    for (const url of [undefined, 'https://accounts.google.com.example.invalid/v3/signin/continue?plt=fixture', `${VERIFICATION_URL}\u0007`]) {
      expect(log.turn([input, [ERROR_MESSAGE, verificationError(url)]])?.message).toBe('Verify your Google account, then send the message again.')
    }
    // The same text in an answer is not an error.
    expect(log.turn([[PLANNER_RESPONSE, verificationError(VERIFICATION_URL)]])).toBeNull()
    log.remove()
  })

  test("agy's typed refusal is a quota, with or without a log", () => {
    const log = profileWithLog()
    expect(log.turn([], 'refusal')).toEqual({ message: 'You have reached your Antigravity quota for this period.', code: 'QUOTA_EXHAUSTED', usageLimit: { resetsAt: null } })
    expect(watchAntigravityTurnOutcome(join(log.profile, 'missing'), SESSION)('refusal')?.usageLimit).not.toBeNull()
    expect(watchAntigravityTurnOutcome(join(log.profile, 'missing'), SESSION)('end_turn')).toBeNull()
    log.remove()
  })

  test("only the session's own log is read: a link to another session's log, or a damaged file, gives no evidence", () => {
    const log = profileWithLog()
    const peer = '0d9c2b4e-1111-4222-8333-944455556666'
    log.append(peer, [input])
    symlinkSync(join(log.conversations, `${peer}.db`), join(log.conversations, `${SESSION}.db`))
    const linked = watchAntigravityTurnOutcome(log.profile, SESSION)
    log.append(peer, [[ERROR_MESSAGE, QUOTA_ERROR]])
    expect(linked('end_turn')).toBeNull()
    expect(linked('refusal')?.usageLimit).not.toBeNull()

    rmSync(join(log.conversations, `${SESSION}.db`))
    writeFileSync(join(log.conversations, `${SESSION}.db`), 'not a database')
    const damaged = watchAntigravityTurnOutcome(log.profile, SESSION)
    expect(damaged('end_turn')).toBeNull()
    expect(damaged('refusal')?.code).toBe('QUOTA_EXHAUSTED')
    // A thread id that is not a plain name is never joined into a path.
    expect(watchAntigravityTurnOutcome(log.profile, '../escape')('end_turn')).toBeNull()
    log.remove()
  })
})
