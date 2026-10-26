import { describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { NormalizedEvent, PermissionRequest, Session } from '@solus/contracts/types'
import type { SessionRuntime } from '@solus/server/execution/session-runtime'
import { permissionForFeedback } from '@solus/workspace-ui/components/input/lib/pending-permission'
import { permissionForFeedback as mobilePermissionForFeedback, type PendingPermission } from '../../apps/mobile/src/features/conversation/lib/transcript-model'

// The host modules open SQLite through node:sqlite, which Bun serves as bun:sqlite.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { InputRequests } = await import('@solus/server/execution/sessions/input-requests')

const OPTIONS = [{ id: 'allow', label: 'Allow Once', kind: 'allow' as const }, { id: 'deny', label: 'Deny', kind: 'deny' as const }]
const HOST = { principal: { kind: 'system' as const }, user: null }

/** One session with two open Bash requests; only `q-fb` takes feedback. */
function holdingTwoRequests() {
  const answers: Array<{ questionId: string; optionId: string; feedback?: string }> = []
  const session = {
    sessionId: 'session-1',
    backendId: 'claude-code',
    pendingInputEvents: [
      { type: 'permission_request', questionId: 'q-plain', toolName: 'Bash', options: OPTIONS },
      { type: 'permission_request', questionId: 'q-fb', toolName: 'Bash', options: OPTIONS, supportsFeedback: true },
    ] satisfies NormalizedEvent[] as NormalizedEvent[],
    hasPendingInput: true,
  }
  const permissions = {
    getPendingInfo: () => ({ toolName: 'Bash', sessionId: 'thread-1' }),
    respondToPermission: (questionId: string, optionId: string, _updatedPayload?: string, feedback?: string) => {
      answers.push({ questionId, optionId, feedback })
      return true
    },
  }
  const runtime = {
    activeSessions: new Map([['session-1', session]]),
    backends: new Map([['claude-code', { id: 'claude-code', permissions }]]),
    publish: () => {},
    reportToActiveRun: () => {},
    sessionEmitter: { resolvePermission: () => {} },
    statuses: { setStatus: () => {}, pendingInputStatus: () => 'running' },
  }
  // SAFETY: the test fake holds every runtime member `respondToPermission` reads.
  const requests = new InputRequests(runtime as unknown as SessionRuntime)
  requests.questionIdToSession.set('q-plain', 'session-1')
  requests.questionIdToSession.set('q-fb', 'session-1')
  return { requests, answers }
}

describe('permission feedback on the host', () => {
  test('feedback reaches the provider only with a denial of a request that takes it', () => {
    const { requests, answers } = holdingTwoRequests()

    // WHY: a provider that cannot carry the text (Codex) must not drop it in
    // silence, and feedback never goes with an allow. Both stay open.
    expect(() => requests.respondToPermission('session-1', 'q-plain', 'deny', undefined, HOST, 'safer')).toThrow()
    expect(() => requests.respondToPermission('session-1', 'q-fb', 'allow', undefined, HOST, 'safer')).toThrow()
    expect(answers).toEqual([])

    expect(requests.respondToPermission('session-1', 'q-fb', 'deny', undefined, HOST, 'Run it in a safer manner.')).toBe(true)
    expect(answers).toEqual([{ questionId: 'q-fb', optionId: 'deny', feedback: 'Run it in a safer manner.' }])
    // The other request is still answerable on its own.
    expect(requests.respondToPermission('session-1', 'q-plain', 'allow', undefined, HOST)).toBe(true)
  })
})

function webRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    questionId: 'q-1',
    toolTitle: 'Bash',
    options: [{ optionId: 'allow', kind: 'allow', label: 'Allow Once' }, { optionId: 'deny', kind: 'deny', label: 'Deny' }],
    supportsFeedback: true,
    ...overrides,
  }
}

function webSession(permissionQueue: PermissionRequest[]): Session {
  return { permissionQueue } as Session
}

describe('composer text as permission feedback', () => {
  test('the web composer denies the request the card shows, with the text', () => {
    // WHY: the composer must answer the displayed request; sent as a prompt,
    // the text reaches the parent while a subagent's call stays blocked.
    expect(permissionForFeedback(webSession([webRequest(), webRequest({ questionId: 'q-2' })])))
      .toEqual({ questionId: 'q-1', denyOptionId: 'deny' })
  })

  test('the web composer stays ordinary for a request that takes no feedback or is closed', () => {
    expect(permissionForFeedback(webSession([webRequest({ supportsFeedback: undefined })]))).toBeNull()
    expect(permissionForFeedback(webSession([webRequest({ expired: 'run_ended' })]))).toBeNull()
    expect(permissionForFeedback(webSession([]))).toBeNull()
  })

  test('the mobile composer picks the same request', () => {
    const pending: PendingPermission = { questionId: 'q-1', toolName: 'Bash', description: null, options: OPTIONS, supportsFeedback: true }
    expect(mobilePermissionForFeedback([pending])).toEqual({ questionId: 'q-1', denyOptionId: 'deny' })
    expect(mobilePermissionForFeedback([{ ...pending, supportsFeedback: undefined }])).toBeNull()
    expect(mobilePermissionForFeedback([{ ...pending, expired: 'closed' }])).toBeNull()
  })
})
