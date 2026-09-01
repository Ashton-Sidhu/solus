import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { formatAnswer, questionKey } from '@solus/contracts/question-answer'
import type { AgentConversationUpdate, NormalizedEvent, QuestionItem, SessionMeta } from '@solus/contracts/types'

// The SUT reaches the plan-annotation store, which imports node:sqlite (absent
// under Bun's test runtime). Shim before dynamically importing it.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type ReviewToolsModule = typeof import('@solus/server/sessions/session-review-tools')
type SessionToolsModule = typeof import('@solus/server/sessions/session-tools')
let reviewTools: ReviewToolsModule
let sessionTools: SessionToolsModule
let closeDb: () => void

const CWD = '/Users/test/proj'
const PEER: SessionMeta = {
  provider: 'claude-code',
  sessionId: 'peer-1',
  slug: 'peer',
  firstMessage: null,
  lastTimestamp: '',
  size: 0,
  cwd: CWD,
  projectPath: CWD,
}

let dataDir: string
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-answer-'))
  process.env.SOLUS_DATA_DIR = dataDir
  reviewTools = await import('@solus/server/sessions/session-review-tools')
  sessionTools = await import('@solus/server/sessions/session-tools')
  ;({ closeDb } = await import('@solus/server/db'))
})
afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
})

interface Spy {
  answers: Array<[string, Record<string, string>]>
  permissions: Array<[string, string, string | undefined]>
  prompts: Array<[string, string, string | undefined]>
  answerAccepted: boolean
}

function installController(pending: NormalizedEvent[]): Spy {
  const spy: Spy = { answers: [], permissions: [], prompts: [], answerAccepted: true }
  sessionTools.setSessionController({
    listSessions: async () => [],
    getSessionInfo: async () => PEER,
    loadSessionTail: async () => [],
    liveStatus: () => 'awaiting_input',
    pendingInputEvents: () => pending,
    promptSession: async (sessionId, prompt, _delivery, options) => {
      spy.prompts.push([sessionId, prompt, options?.permissionMode])
      return { disposition: 'queued', queueId: 'q1' }
    },
    watchSessionSettled: () => {},
    stopSession: () => true,
    answerQuestion: (questionId, answers) => {
      spy.answers.push([questionId, answers])
      return spy.answerAccepted
    },
    respondPermission: (questionId, optionId, revised) => {
      spy.permissions.push([questionId, optionId, revised])
      return true
    },
    loadPlanContent: async () => null,
    listPlans: async () => [],
    invalidatePlanCaches: () => {},
  })
  return spy
}

function questionEvent(questions: QuestionItem[], kind?: 'mcp_form'): NormalizedEvent {
  return { type: 'question_request', questionId: 'q-1', questions, ...(kind ? { kind } : {}) }
}

const CHOICE_QUESTION: QuestionItem = {
  id: 'strategy',
  question: 'Snapshot or hold the lock?',
  options: [{ label: 'Snapshot' }, { label: 'Hold the lock' }],
  multiSelect: false,
}

function run(args: Parameters<typeof reviewTools.executeSessionReviewTool>[1], updates: AgentConversationUpdate[] = []) {
  return reviewTools.executeSessionReviewTool('answer_session', args, {
    ctx: { agentProvider: 'claude-code', cwd: CWD, sessionId: 'caller-1' },
    onAgentConversationUpdate: (update) => updates.push(update),
  })
}

describe('answer_session', () => {
  test('the answer record is byte-identical to what the QuestionCard sends for the same selection', async () => {
    // WHY: this is the entire reason questionKey/formatAnswer are shared. Both
    // providers key their response on this record; any divergence between the
    // card's encoding and the tool's mis-delivers the answer with no error.
    const spy = installController([questionEvent([CHOICE_QUESTION])])
    const result = await run({
      session_id: 'peer-1',
      answers: [{ key: 'strategy', choice: 'Snapshot', comment: 'lock churn is the cost' }],
    })
    expect(result.ok).toBe(true)
    const cardRecord = { [questionKey(CHOICE_QUESTION)]: formatAnswer('Snapshot', 'lock churn is the cost') }
    expect(spy.answers).toEqual([['q-1', cardRecord]])
  })

  test('called without answers it reports the keys and options and changes nothing', async () => {
    // WHY: self-describing is the point — the agent must never have to parse the
    // injected [session report] prose to learn what it is answering.
    const spy = installController([questionEvent([CHOICE_QUESTION])])
    const updates: AgentConversationUpdate[] = []
    const result = await run({ session_id: 'peer-1' }, updates)
    expect(result.ok).toBe(true)
    expect(result.text).toContain('key: strategy')
    expect(result.text).toContain('Snapshot')
    expect(spy.answers).toEqual([])
    expect(updates).toEqual([])
  })

  test('a choice the question never offered is refused rather than passed through as free text', async () => {
    // WHY: an unknown label reaches the provider as an off-menu answer and
    // silently means something else than the agent intended.
    const spy = installController([questionEvent([CHOICE_QUESTION])])
    const result = await run({ session_id: 'peer-1', answers: [{ key: 'strategy', choice: 'Rewrite it' }] })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('Rewrite it')
    expect(spy.answers).toEqual([])
  })

  test('an unknown key is refused and lists the real ones', async () => {
    const spy = installController([questionEvent([CHOICE_QUESTION])])
    const result = await run({ session_id: 'peer-1', answers: [{ key: 'stratergy', choice: 'Snapshot' }] })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('"strategy"')
    expect(spy.answers).toEqual([])
  })

  test('a free-text question accepts any answer', async () => {
    const spy = installController([
      questionEvent([{ id: 'why', question: 'Why did p99 double?', options: [], multiSelect: false }]),
    ])
    const result = await run({ session_id: 'peer-1', answers: [{ key: 'why', choice: 'the sweep holds the lock' }] })
    expect(result.ok).toBe(true)
    expect(spy.answers[0][1]).toEqual({ why: 'the sweep holds the lock' })
  })

  test('an MCP elicitation form gets __action, without which Codex declines it', async () => {
    const spy = installController([
      questionEvent([{ id: 'token', question: 'API token', options: [], multiSelect: false }], 'mcp_form'),
    ])
    await run({ session_id: 'peer-1', answers: [{ key: 'token', choice: 'abc123' }] })
    expect(spy.answers[0][1]).toEqual({ token: 'abc123', __action: 'accept' })
  })

  test('unanswered questions still ship as empty, exactly as "let the agent decide" does', async () => {
    // WHY: a missing key reads to the provider as a dropped question, not as
    // handing the decision back.
    const spy = installController([
      questionEvent([CHOICE_QUESTION, { id: 'scope', question: 'How far?', options: [], multiSelect: false }]),
    ])
    await run({ session_id: 'peer-1', answers: [{ key: 'strategy', choice: 'Snapshot' }] })
    expect(spy.answers[0][1]).toEqual({ strategy: 'Snapshot', scope: '' })
  })

  test('a pending tool permission is refused by name — that boundary is human-only', async () => {
    // WHY: an agent approving a peer's Bash/Write/MCP access is a privilege
    // escalation with no human in the loop.
    const spy = installController([
      { type: 'permission_request', questionId: 'perm-1', toolName: 'Bash', options: [{ id: 'allow', label: 'Allow', kind: 'allow' }] },
    ])
    const result = await run({ session_id: 'peer-1', answers: [{ key: 'x', choice: 'y' }] })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('only a human can grant')
    expect(spy.answers).toEqual([])
  })

  test('a pending plan is redirected to review_plan rather than answered as a question', async () => {
    installController([
      { type: 'plan', planContent: 'p', planFilePath: '', questionId: 'perm-2', options: [], planToolUseId: 'x' },
    ])
    const result = await run({ session_id: 'peer-1', answers: [{ key: 'x', choice: 'y' }] })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('review_plan')
  })

  test('a delivered answer flips the caller card to answered', async () => {
    const updates: AgentConversationUpdate[] = []
    installController([questionEvent([CHOICE_QUESTION])])
    await run({ session_id: 'peer-1', answers: [{ key: 'strategy', choice: 'Snapshot' }] }, updates)
    expect(updates).toEqual([
      { phase: 'answered', agentSessionId: 'peer-1', answerText: 'Snapshot or hold the lock? → Snapshot' },
    ])
  })

  test('a question answered elsewhere in the meantime reports that instead of pretending', async () => {
    // WHY: the peer's own tab can resolve the pause at any moment; a silent
    // success would leave the caller believing it unblocked the peer.
    const spy = installController([questionEvent([CHOICE_QUESTION])])
    spy.answerAccepted = false
    const updates: AgentConversationUpdate[] = []
    const result = await run({ session_id: 'peer-1', answers: [{ key: 'strategy', choice: 'Snapshot' }] }, updates)
    expect(result.ok).toBe(false)
    expect(result.text).toContain('no longer waiting')
    expect(updates).toEqual([])
  })

  test('answering your own session is refused', async () => {
    installController([questionEvent([CHOICE_QUESTION])])
    const result = await reviewTools.executeSessionReviewTool('answer_session', { session_id: 'caller-1' }, {
      ctx: { agentProvider: 'claude-code', cwd: CWD, sessionId: 'caller-1' },
    })
    expect(result.ok).toBe(false)
  })
})
