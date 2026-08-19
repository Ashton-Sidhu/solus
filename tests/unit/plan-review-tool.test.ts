import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { AgentConversationUpdate, NormalizedEvent, PermissionOption, SessionMeta } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type ReviewToolsModule = typeof import('@solus/server/sessions/session-review-tools')
type SessionToolsModule = typeof import('@solus/server/sessions/session-tools')
type AnnotationsModule = typeof import('@solus/server/plans/annotations')
let reviewTools: ReviewToolsModule
let sessionTools: SessionToolsModule
let annotations: AnnotationsModule
let closeDb: () => void

const CWD = '/Users/test/proj'
const PLAN_TEXT = '# Evict on write\nHold the lock only for the swap.'

function peer(provider: SessionMeta['provider']): SessionMeta {
  return {
    provider,
    sessionId: 'peer-1',
    slug: 'peer',
    firstMessage: null,
    lastTimestamp: '',
    size: 0,
    cwd: CWD,
    projectPath: CWD,
  }
}

let dataDir: string
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-plan-review-'))
  process.env.SOLUS_DATA_DIR = dataDir
  reviewTools = await import('@solus/server/sessions/session-review-tools')
  sessionTools = await import('@solus/server/sessions/session-tools')
  annotations = await import('@solus/server/plans/annotations')
  ;({ closeDb } = await import('@solus/server/db'))
})
afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
})

interface Spy {
  permissions: Array<{ questionId: string; optionId: string; revised?: string }>
  prompts: Array<{ prompt: string; permissionMode?: string }>
  watches: number
  permissionAccepted: boolean
}

/** A blocking Claude plan holds its run open on an ExitPlanMode permission; a
 *  Codex plan arrives with no options because its turn has already ended. */
function planEvent(options: PermissionOption[]): NormalizedEvent {
  return {
    type: 'plan',
    planContent: PLAN_TEXT,
    planFilePath: '',
    questionId: 'perm-1',
    planToolUseId: 'toolu_1',
    options,
  }
}

const CLAUDE_OPTIONS = [
  { id: 'allow', label: 'Yes', kind: 'allow' as const },
  { id: 'deny', label: 'No', kind: 'deny' as const },
]

function installController(pending: NormalizedEvent[], provider: SessionMeta['provider'] = 'claude-code'): Spy {
  const spy: Spy = { permissions: [], prompts: [], watches: 0, permissionAccepted: true }
  sessionTools.setSessionController({
    listSessions: async () => [],
    getSessionInfo: async () => peer(provider),
    loadSessionTail: async () => [],
    liveStatus: () => 'awaiting_plan',
    pendingInputEvents: () => pending,
    promptSession: async (_sessionId, prompt, _delivery, options) => {
      spy.prompts.push({ prompt, permissionMode: options?.permissionMode })
      return { disposition: 'queued', queueId: 'q1' }
    },
    watchSessionSettled: () => { spy.watches += 1 },
    stopSession: () => true,
    answerQuestion: () => true,
    respondPermission: (questionId, optionId, revised) => {
      spy.permissions.push({ questionId, optionId, revised })
      return spy.permissionAccepted
    },
    loadPlanContent: async () => PLAN_TEXT,
    listPlans: async () => [],
    invalidatePlanCaches: () => {},
  })
  return spy
}

function run(args: Parameters<typeof reviewTools.executeSessionReviewTool>[1], updates: AgentConversationUpdate[] = []) {
  return reviewTools.executeSessionReviewTool('review_plan', args, {
    ctx: { agentProvider: 'claude-code', cwd: CWD, sessionId: 'caller-1' },
    onAgentConversationUpdate: (update) => updates.push(update),
  })
}

beforeEach(() => {
  closeDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

describe('review_plan — reading', () => {
  test('called without a decision it returns the plan and changes nothing', async () => {
    const spy = installController([planEvent(CLAUDE_OPTIONS)])
    const updates: AgentConversationUpdate[] = []
    const result = await run({ session_id: 'peer-1' }, updates)
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Hold the lock only for the swap.')
    expect(spy.permissions).toEqual([])
    expect(spy.prompts).toEqual([])
    expect(updates).toEqual([])
  })

  test('request_changes without a comment is refused — there would be nothing to revise against', async () => {
    const spy = installController([planEvent(CLAUDE_OPTIONS)])
    const result = await run({ session_id: 'peer-1', decision: 'request_changes' })
    expect(result.ok).toBe(false)
    expect(spy.permissions).toEqual([])
    expect(spy.prompts).toEqual([])
  })

  test('a pending question is redirected to answer_session', async () => {
    installController([{ type: 'question_request', questionId: 'q-1', questions: [{ question: 'which?', options: [], multiSelect: false }] }])
    const result = await run({ session_id: 'peer-1', decision: 'approve' })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('answer_session')
  })
})

describe('review_plan — a blocking plan (Claude ExitPlanMode)', () => {
  test("approve answers the permission with the event's own allow id and rides revised_plan through it", async () => {
    // WHY: approving in place is what that held permission already means — it
    // keeps the peer's exploration context instead of resetting the session, and
    // `updatedPlan` is the existing path for implementing an edited plan.
    const spy = installController([planEvent(CLAUDE_OPTIONS)])
    const result = await run({ session_id: 'peer-1', decision: 'approve', revised_plan: '# Evict on write\nSwap under a read lock.' })
    expect(result.ok).toBe(true)
    expect(spy.permissions).toEqual([{ questionId: 'perm-1', optionId: 'allow', revised: '# Evict on write\nSwap under a read lock.' }])
    expect(spy.prompts).toEqual([])
  })

  test('request_changes denies the permission, then queues the revision in plan mode and re-arms the watch', async () => {
    // WHY: the deny cancels the run, which consumes the caller's live watch. A
    // new watch is the only way the revised plan comes back to the reviewer.
    const spy = installController([planEvent(CLAUDE_OPTIONS)])
    const result = await run({ session_id: 'peer-1', decision: 'request_changes', comment: 'the swap still blocks readers' })
    expect(result.ok).toBe(true)
    expect(spy.permissions).toEqual([{ questionId: 'perm-1', optionId: 'deny', revised: undefined }])
    expect(spy.prompts).toEqual([
      { prompt: 'Please revise the plan with these comments:\n\nthe swap still blocks readers', permissionMode: 'plan' },
    ])
    expect(spy.watches).toBe(1)
  })

  test('a plan the peer no longer holds open reports that instead of half-applying', async () => {
    const spy = installController([planEvent(CLAUDE_OPTIONS)])
    spy.permissionAccepted = false
    const result = await run({ session_id: 'peer-1', decision: 'approve' })
    expect(result.ok).toBe(false)
    expect(spy.prompts).toEqual([])
  })
})

describe('review_plan — a non-blocking plan (Codex)', () => {
  test('approve prompts the plan back with permissionMode ask, and answers no permission', async () => {
    // WHY: the turn has already ended so there is nothing to respond to, and the
    // session is still in 'plan' mode — without the override Codex refuses to
    // touch a file and the approval does nothing at all.
    const spy = installController([planEvent([])], 'codex')
    const result = await run({ session_id: 'peer-1', decision: 'approve' })
    expect(result.ok).toBe(true)
    expect(spy.permissions).toEqual([])
    expect(spy.prompts).toEqual([{ prompt: `Implement this plan:\n\n${PLAN_TEXT}`, permissionMode: 'ask' }])
    expect(spy.watches).toBe(1)
  })

  test('approve with revised_plan implements the revision, not the plan the peer wrote', async () => {
    const spy = installController([planEvent([])], 'codex')
    await run({ session_id: 'peer-1', decision: 'approve', revised_plan: 'Swap under a read lock.' })
    expect(spy.prompts[0].prompt).toBe('Implement this plan:\n\nSwap under a read lock.')
  })

  test('request_changes prompts in plan mode with the same copy a human rejection sends', async () => {
    const spy = installController([planEvent([])], 'codex')
    await run({ session_id: 'peer-1', decision: 'request_changes', comment: 'measure first' })
    expect(spy.permissions).toEqual([])
    expect(spy.prompts).toEqual([{ prompt: 'Please revise the plan with these comments:\n\nmeasure first', permissionMode: 'plan' }])
  })
})

describe('review_plan — the ruling is recorded', () => {
  test('the decision and its comment land on the plan, so the gallery reads like a human ruling', async () => {
    installController([planEvent(CLAUDE_OPTIONS)])
    await run({ session_id: 'peer-1', decision: 'request_changes', comment: 'measure first' })
    const saved = await annotations.loadAnnotations('peer-1', 'toolu_1')
    expect(saved?.status).toBe('rejected')
    expect(saved?.title).toBe('Evict on write')
    expect(saved?.comments).toHaveLength(1)
    expect(saved?.comments[0]).toMatchObject({ author: 'solus', comment: 'measure first' })
    // Attribution names the agent, because 'solus' cannot say which one.
    expect(saved?.comments[0].authorAgent).toMatchObject({ sessionId: 'caller-1', provider: 'claude-code' })
  })

  test('an approval is recorded as accepted', async () => {
    installController([planEvent(CLAUDE_OPTIONS)])
    await run({ session_id: 'peer-1', decision: 'approve' })
    expect((await annotations.loadAnnotations('peer-1', 'toolu_1'))?.status).toBe('accepted')
  })

  test('a ruling flips the caller card to answered', async () => {
    installController([planEvent(CLAUDE_OPTIONS)])
    const updates: AgentConversationUpdate[] = []
    await run({ session_id: 'peer-1', decision: 'approve' }, updates)
    expect(updates.some((u) => u.phase === 'answered' && u.answerText === 'Approved the plan')).toBe(true)
  })
})
