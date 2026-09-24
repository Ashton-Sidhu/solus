import { describe, expect, test } from 'bun:test'
import {
  ORCHESTRATION_LIMITS,
  formatExchangeTag,
  formatParentPrompt,
  formatSessionNotice,
  formatSessionReport,
  parseExchangeTag,
  parseOrchestrationItems,
  type OrchestrationItem,
  type SessionNotice,
  type SessionOutput,
  type SessionReport,
} from '@solus/contracts/session-exchange'

// WHY: the host writes reports and notices into a parent's transcript, and every
// client reads them back to rebuild the parent's cards after a reload. That
// round trip is the written contract between server and client — nothing else
// parses this text — so every field must come back exactly, even when a reply
// or a title looks like part of the format. And because the parent's model
// reads the same text, nothing in it may carry full content: past a limit, the
// text is cut and points at the tool that reads the rest.

const child = '11111111-1111-4111-8111-111111111111'

const everyOutput: SessionOutput[] = [
  { kind: 'question', question: 'Which "branch"?', answer: 'main, then dev' },
  { kind: 'question', question: 'Ends in a backslash \\', answer: 'ok' },
  { kind: 'question', question: 'Skip it?' },
  { kind: 'permission', tool: 'Bash: rm -rf build', allowed: true },
  { kind: 'plan', sessionId: child, planToolUseId: 'toolu_1', title: 'Ship "the" parser' },
  { kind: 'work', workId: 'w1', title: 'Design notes', workType: 'diagram' },
  { kind: 'changed_files', sessionId: child, count: 2, branch: 'feat/store' },
  { kind: 'pull_request', number: 42, url: 'https://github.com/o/r/pull/42' },
  { kind: 'session', sessionId: 'thread-grandchild', title: 'Write tests', taskId: 'task-7' },
]

const report: SessionReport = {
  messageId: '22222222-2222-4222-8222-222222222222',
  agentSessionId: child,
  taskId: 'task-1',
  provider: 'claude-code',
  status: 'completed',
  durationMs: 1234,
  outputs: everyOutput,
  reply: 'Done.\n\nOutputs:\n- not an output\nReply:\nstill the reply',
}

const round = (items: OrchestrationItem[]) => parseOrchestrationItems(formatParentPrompt(items))

describe('session report v2', () => {
  test('round-trips every field and every output kind, including a reply that imitates the format', () => {
    expect(round([{ type: 'report', report }])).toEqual([{ type: 'report', report }])
  })

  test('changed files reach the model as a count, never as paths', () => {
    const withPaths: SessionReport = { ...report, outputs: [{ kind: 'changed_files', sessionId: child, count: 3, paths: ['a.ts', 'b.ts', 'c.ts'] }] }
    const text = formatSessionReport(withPaths)
    expect(text).toContain('- changed files 3 session=')
    expect(text).not.toContain('a.ts')
  })

  test('a long reply is cut and points at read_session for the rest', () => {
    const long = 'x'.repeat(ORCHESTRATION_LIMITS.reply + 500)
    const [item] = round([{ type: 'report', report: { ...report, outputs: [], reply: long } }])!
    const reply = item!.type === 'report' ? item!.report.reply : ''
    expect(reply.startsWith('x'.repeat(ORCHESTRATION_LIMITS.reply))).toBe(true)
    expect(reply).toContain(`read_session session_id=${child}`)
    expect(reply.length).toBeLessThan(ORCHESTRATION_LIMITS.reply + 100)
  })

  test('outputs past the limit are counted, and long titles and questions are cut', () => {
    const many: SessionOutput[] = Array.from({ length: ORCHESTRATION_LIMITS.outputs + 5 }, (_, index) => (
      { kind: 'work', workId: `w${index}`, title: 'T'.repeat(ORCHESTRATION_LIMITS.title + 50), workType: 'doc' }
    ))
    const text = formatSessionReport({ ...report, outputs: many })
    expect(text).toContain('- +5 more; call read_task_sessions')
    const [item] = parseOrchestrationItems(text)!
    const outputs = item!.type === 'report' ? item!.report.outputs : []
    expect(outputs).toHaveLength(ORCHESTRATION_LIMITS.outputs)
    expect(outputs.every((output) => output.kind === 'work' && output.title.length === ORCHESTRATION_LIMITS.title)).toBe(true)
  })

  test('ordinary text is not from the orchestrator', () => {
    expect(parseOrchestrationItems('Please ship the parser.')).toBeNull()
    // The superseded v1 head is ordinary text now.
    expect(parseOrchestrationItems(`[session report v1 session=${child} status=completed]\nFinal reply:\nold`)).toBeNull()
  })
})

describe('session notice v1', () => {
  const target = { messageId: 'm1', agentSessionId: child, taskId: 'task-1', provider: 'codex' as const }
  const notices: SessionNotice[] = [
    { ...target, kind: 'question', questionId: 'q1', questions: [{ question: 'Which "database"?', options: ['SQLite', 'Postgres, managed'] }, { question: 'Now?', options: [] }] },
    { ...target, kind: 'plan', title: 'Split the store', planToolUseId: 'toolu_9', questionId: 'plan-q' },
    { ...target, kind: 'permission', questionId: 'p1', tool: 'Bash', summary: 'rm -rf build' },
    { ...target, kind: 'rate_limited', resetsAt: 1_790_000_000_000, limitType: 'Codex 5h' },
  ]

  test('round-trips every kind', () => {
    for (const notice of notices) expect(round([{ type: 'notice', notice }])).toEqual([{ type: 'notice', notice }])
  })

  test('a plan notice names the plan and never carries its text', () => {
    const text = formatSessionNotice(notices[1]!)
    expect(text).toContain('plan=toolu_9')
    expect(text.split('\n')).toHaveLength(2)
  })

  test('questions and options past the limits are counted, not listed', () => {
    const options = Array.from({ length: ORCHESTRATION_LIMITS.options + 2 }, (_, index) => `option ${index}`)
    const questions = Array.from({ length: ORCHESTRATION_LIMITS.questionsPerNotice + 1 }, (_, index) => ({ question: `q${index}`, options }))
    const text = formatSessionNotice({ ...target, kind: 'question', questionId: 'q1', questions })
    expect(text).toContain('+2 more')
    expect(text).toContain('+1 more questions')
    const [item] = parseOrchestrationItems(text)!
    const parsed = item!.type === 'notice' && item!.notice.kind === 'question' ? item!.notice.questions : []
    expect(parsed).toHaveLength(ORCHESTRATION_LIMITS.questionsPerNotice)
    expect(parsed[0]!.options).toHaveLength(ORCHESTRATION_LIMITS.options)
  })
})

describe('the prompt a parent receives', () => {
  test('carries reports and notices together, in order', () => {
    const notice: SessionNotice = { agentSessionId: child, kind: 'rate_limited' }
    const second: SessionReport = { ...report, messageId: 'm2', status: 'failed', outputs: [], reply: '' }
    expect(round([{ type: 'report', report }, { type: 'notice', notice }, { type: 'report', report: second }])).toEqual([
      { type: 'report', report }, { type: 'notice', notice }, { type: 'report', report: second },
    ])
  })

  test('past the merged limit, the oldest reports keep only their head', () => {
    const items: OrchestrationItem[] = Array.from({ length: ORCHESTRATION_LIMITS.mergedItems + 2 }, (_, index) => (
      { type: 'report', report: { ...report, messageId: `m${index}`, reply: `reply ${index}` } }
    ))
    const text = formatParentPrompt(items)
    expect(text).toContain('2 earlier reports were shortened')
    const parsed = parseOrchestrationItems(text)!
    expect(parsed).toHaveLength(items.length)
    expect(parsed.slice(0, 2).map((item) => item.type === 'report' && [item.report.shortened, item.report.reply])).toEqual([[true, ''], [true, '']])
    expect(parsed[2]).toMatchObject({ type: 'report', report: { messageId: 'm2', reply: 'reply 2' } })
    expect(parsed.at(-1)).toMatchObject({ type: 'report', report: { reply: `reply ${items.length - 1}` } })
  })
})

describe('exchange tag on a tool result', () => {
  test('names the message, the session and its provider', () => {
    const tag = { messageId: 'm1', agentSessionId: 's1', provider: 'codex' as const }
    expect(parseExchangeTag(`Prompt dispatched to [s1](session://open?sessionId=zzz).\n${formatExchangeTag(tag)}`)).toEqual(tag)
  })

  test('a result without the tag names nothing', () => {
    expect(parseExchangeTag('Created session [x](session://open?provider=codex&sessionId=abc).')).toBeNull()
  })
})
