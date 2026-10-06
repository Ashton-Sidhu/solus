import { describe, expect, test } from 'bun:test'
import { formatParentPrompt, type SessionReport } from '@solus/contracts/session-exchange'
import type { SessionHistoryPage } from '@solus/contracts/session-history'
import type { AgentConversationUpdate, SessionRecord, WireNormalizedEvent } from '@solus/contracts/types'
import { agentCardStatus, type AgentItem } from '../../apps/mobile/src/features/conversation/lib/agent-cards'
import { TranscriptModel, type TranscriptItem } from '../../apps/mobile/src/features/conversation/lib/transcript-model'
import {
  agentWorkspace,
  agentsElapsedMs,
  agentsPillLabel,
  sessionAgentPresentation,
  subagentPresentation,
  summarizeAgents,
} from '../../apps/mobile/src/features/threads/agent-card-presentation'
import { deriveThreadFeedPresentation, type FeedSourceEntry } from '../../apps/mobile/src/features/threads/thread-feed-presentation'
import { ThreadDirectory } from '../../apps/mobile/src/features/threads/thread-directory'

const update = (u: AgentConversationUpdate): WireNormalizedEvent => ({ type: 'agent_conversation_update', update: u }) as WireNormalizedEvent
const dispatched = (messageId: string, agentSessionId = 'child-1', at = 1_000): WireNormalizedEvent => update({
  phase: 'dispatched', agentSessionId, messageId, origin: 'created', prompt: 'Fix the header favicon. Then report.', provider: 'codex',
  title: 'Fix the header favicon.', cwd: '/work/app', model: 'gpt-5.5', dispatchedAt: at,
})
const agents = (model: TranscriptModel) => model.order.map((id) => model.items.get(id)).filter((item): item is AgentItem => item?.kind === 'agent')
const kinds = (model: TranscriptModel) => model.order.map((id) => model.items.get(id)?.kind)

describe('native agent cards: live', () => {
  test('a started session is one card that follows its exchange, and the delegation call is not shown beside it', () => {
    const model = new TranscriptModel('parent')
    model.addOptimisticUser('u1', 'split this up')
    model.apply({ type: 'tool_call', toolName: 'mcp__solus__start_session', toolId: 'call-1', index: 0, toolInput: '{"prompt":"Fix the header favicon."}' })
    model.apply(dispatched('m1'))
    model.apply(update({ phase: 'accepted', agentSessionId: 'child-1', messageId: 'm1', state: 'running' }))
    expect(kinds(model)).toEqual(['user', 'agent'])
    expect(agentCardStatus(agents(model)[0]!)).toBe('running')

    model.apply({ type: 'tool_result', toolUseId: 'call-1', status: 'ok', contentBytes: 10 } as WireNormalizedEvent)
    model.apply(update({ phase: 'settled', agentSessionId: 'child-1', messageId: 'm1', status: 'completed', replyText: 'Done: favicon shows.', durationMs: 4_000, settledAt: 9_000 }))
    const [card] = agents(model)
    expect(agentCardStatus(card!)).toBe('done')
    expect(card!.reply).toBe('Done: favicon shows.')
    // The settled call still stays out of the feed: the card stands for it.
    expect(kinds(model)).toEqual(['user', 'agent'])
  })

  test('a second message to the same agent in one turn joins its card; a new turn gets a new card', () => {
    const model = new TranscriptModel('parent')
    model.addOptimisticUser('u1', 'go')
    model.apply(dispatched('m1'))
    model.apply(dispatched('m2'))
    expect(agents(model)).toHaveLength(1)
    expect(agents(model)[0]!.exchanges.map((exchange) => exchange.messageId)).toEqual(['m1', 'm2'])
    model.addOptimisticUser('u2', 'again')
    model.apply(dispatched('m3'))
    expect(agents(model)).toHaveLength(2)
  })

  test('a card started before its session existed binds to the real session when the host attaches it', () => {
    const model = new TranscriptModel('parent')
    model.apply(dispatched('m1', 'pending:abc'))
    model.apply(update({ phase: 'attached', messageId: 'm1', agentSessionId: 'child-9' }))
    expect(agents(model)[0]!.agentSessionId).toBe('child-9')
    // Later updates name the real session and land in the same card.
    model.apply(update({ phase: 'awaiting_input', agentSessionId: 'child-9', messageId: 'm1', request: { kind: 'question', questions: [] } as never }))
    expect(agentCardStatus(agents(model)[0]!)).toBe('awaiting_input')
  })

  test('a delegation call that fails made no card, so it shows', () => {
    const model = new TranscriptModel('parent')
    model.apply({ type: 'tool_call', toolName: 'start_session', toolId: 'call-1', index: 0, toolInput: '{}' })
    expect(kinds(model)).toEqual([])
    model.apply({ type: 'tool_result', toolUseId: 'call-1', status: 'error', errorHead: 'No such model', contentBytes: 10 } as WireNormalizedEvent)
    expect(kinds(model)).toEqual(['tool'])
  })

  test('stopping an agent ends its open exchange but keeps a queued one', () => {
    const model = new TranscriptModel('parent')
    model.apply(dispatched('m1'))
    model.apply(dispatched('m2'))
    model.apply(update({ phase: 'accepted', agentSessionId: 'child-1', messageId: 'm2', state: 'queued' }))
    model.apply(update({ phase: 'stopped', agentSessionId: 'child-1' }))
    expect(agents(model)[0]!.exchanges.map((exchange) => exchange.status)).toEqual(['interrupted', 'queued'])
  })
})

describe('native agent cards: history', () => {
  const report: SessionReport = { messageId: 'm1', agentSessionId: 'child-1', provider: 'codex', status: 'completed', outputs: [], reply: 'Favicon fixed.', durationMs: 3_000 }
  const page = (messages: SessionHistoryPage['messages']): SessionHistoryPage => ({ messages, before: null })

  test('a reload rebuilds the card from the tool row and the report turn, and the report is not a bubble', () => {
    const model = TranscriptModel.fromHistory('parent', page([
      { role: 'user', content: 'split this up', messageId: 'u1', timestamp: 1 },
      {
        role: 'tool', toolId: 'call-1', toolName: 'mcp__solus__start_session', toolInput: '{"prompt":"Fix the header favicon.","model_id":"gpt-5.5"}',
        toolStatus: 'completed', content: '', messageId: 't1', timestamp: 2,
        agentConversationResult: { agentSessionId: 'child-1', messageId: 'm1', provider: 'codex', progress: { state: 'running' } },
      },
      { role: 'user', content: formatParentPrompt([{ type: 'report', report }]), messageId: 'u2', timestamp: 5 },
    ] as SessionHistoryPage['messages']))
    expect(kinds(model)).toEqual(['user', 'agent'])
    const [card] = agents(model)
    expect(card).toMatchObject({ agentSessionId: 'child-1', provider: 'codex', title: 'Fix the header favicon.', reply: 'Favicon fixed.' })
    expect(agentCardStatus(card!)).toBe('done')
  })

  test('an exchange the host no longer carries reads as lost, not as working', () => {
    const model = TranscriptModel.fromHistory('parent', page([
      { role: 'tool', toolId: 'c', toolName: 'send_session', toolInput: '{"session_id":"child-2","message":"status?"}', toolStatus: 'completed', content: '', messageId: 't', timestamp: 2, agentConversationResult: { messageId: 'm7' } },
    ] as SessionHistoryPage['messages']))
    expect(agentCardStatus(agents(model)[0]!)).toBe('lost')
  })

  test('a provider subagent from history keeps its report and has no session to open', () => {
    const model = TranscriptModel.fromHistory('parent', page([
      { role: 'tool', toolId: 'task-1', toolName: 'Task', toolInput: '{"description":"Audit icons","prompt":"Find every icon"}', toolStatus: 'completed', content: '', messageId: 't', timestamp: 2, report: 'Found 4 icons.' },
    ] as SessionHistoryPage['messages']))
    const tool = model.items.get('t') as Extract<TranscriptItem, { kind: 'tool' }>
    expect(tool).toMatchObject({ subagent: 'claude', report: 'Found 4 icons.' })
    const row = subagentPresentation(tool)
    expect(row).toMatchObject({ title: 'Audit icons', statusLabel: 'Completed', sessionId: null, detail: 'Found 4 icons.', provider: 'claude-code' })
  })
})

describe('native agent cards: provider subagents live', () => {
  test('a flagged call is a subagent; its report arrives apart from tool output', () => {
    const model = new TranscriptModel('parent')
    model.apply({ type: 'tool_call', toolName: 'spawn_agent', toolId: 'sa-1', index: 0, toolInput: '{"description":"Read the docs"}', isSubagent: true, subagentType: 'codex' })
    model.apply({ type: 'subagent_report', toolUseId: 'sa-1', text: 'Docs say X.' })
    const tool = model.items.get(model.order[0]!) as Extract<TranscriptItem, { kind: 'tool' }>
    expect(tool).toMatchObject({ subagent: 'codex', report: 'Docs say X.', status: 'running' })
    expect(subagentPresentation(tool)).toMatchObject({ live: true, tone: 'working', provider: 'codex', sessionId: null })
  })
})

describe('native agent rows', () => {
  const card: AgentItem = {
    kind: 'agent', id: 'agent:1', agentSessionId: 'child-1', provider: 'codex', title: 'Fix the header favicon.', model: null,
    prompt: 'Fix the header favicon.', reply: null, exchanges: [{ messageId: 'm1', status: 'running' }], startedAt: 1_000, settledAt: null, durationMs: null,
  }
  const record = { sessionId: 'child-1', provider: 'codex', title: 'fix the header', customTitle: 'Header Favicon Fix', model: null } as SessionRecord

  test('the host record names the session and makes the row open it', () => {
    expect(sessionAgentPresentation(card, record)).toMatchObject({ title: 'Header Favicon Fix', sessionId: 'child-1', live: true, statusLabel: 'Working' })
  })

  test('without a record the row says why it cannot open yet', () => {
    const row = sessionAgentPresentation(card, null)
    expect(row.sessionId).toBeNull()
    expect(row.unopenableReason).toMatch(/not listed/)
  })

  test('settled rows lead with the reply and stop their clock at the reported duration', () => {
    const settled = { ...card, reply: 'Shipped.', exchanges: [{ messageId: 'm1', status: 'done' as const }], settledAt: 9_000, durationMs: 4_000 }
    const row = sessionAgentPresentation(settled, record)
    expect(row).toMatchObject({ detail: 'Shipped.', tone: 'completed', endedAt: 5_000 })
    expect(agentsElapsedMs([row], 1_000_000)).toBe(4_000)
  })

  test('summaries, clock and pill count what runs', () => {
    const working = sessionAgentPresentation(card, record)
    const done = { ...working, tone: 'completed' as const, live: false, endedAt: 3_000 }
    expect(summarizeAgents([working, done, done])).toBe('1 working · 2 done')
    expect(agentsElapsedMs([working, done], 6_000)).toBe(5_000)
    expect(agentsPillLabel([working, done], true)?.label).toBe('1/2')
    expect(agentsPillLabel([done], false)).toBeNull()
    expect(agentsPillLabel([done], true)?.label).toBe('1 done')
  })
})

describe('native feed: agent groups', () => {
  const entries = (...kinds: Array<[string, FeedSourceEntry['kind']]>): FeedSourceEntry[] => kinds.map(([id, kind]) => ({ id, kind }))
  const present = (input: FeedSourceEntry[], turnActive: boolean, expandedTurnIds: string[] = []) => deriveThreadFeedPresentation({
    entries: input, turnActive, working: false, expandedTurnIds: new Set(expandedTurnIds), expandedWorkGroupIds: new Set(),
  })

  test('consecutive agents are one group, apart from the tool rows around them', () => {
    const rows = present(entries(['u', 'user'], ['t1', 'tool'], ['a1', 'agent'], ['a2', 'agent'], ['t2', 'tool']), true)
    expect(rows.map((row) => row.type)).toEqual(['message', 'work-toggle', 'agents', 'work-toggle'])
    expect(rows.find((row) => row.type === 'agents')).toMatchObject({ itemIds: ['a1', 'a2'] })
  })

  test('a finished turn folds its agents with the rest of its work', () => {
    const input = entries(['u', 'user'], ['p1', 'assistant'], ['a1', 'agent'], ['p2', 'assistant'], ['p3', 'assistant'])
    expect(present(input, false).map((row) => row.type)).toEqual(['message', 'message', 'run-fold', 'message'])
    expect(present(input, false, ['turn:u']).map((row) => row.type)).toContain('agents')
  })
})

describe('native directory: child sessions', () => {
  test('a child session opens by id but is not listed', async () => {
    const record = (sessionId: string, parentSessionId: string | null) => ({ sessionId, parentSessionId, lastActivityAt: 1, projectPath: '/p' }) as SessionRecord
    const connection = {
      state: { sessionGeneration: 0 },
      api: {
        sessionRecordList: async () => ({ records: [record('parent', null), record('child', 'parent')], indexing: false }),
        listProjects: async () => [],
      },
    }
    const registry = { host: () => ({ id: 'h', label: 'Mac' }), hosts: () => [{ id: 'h', label: 'Mac' }] }
    const directory = new ThreadDirectory(registry as never, () => connection as never)
    await directory.load('h')
    expect(directory.threads().map((thread) => thread.record.sessionId)).toEqual(['parent'])
    expect(directory.thread('h', 'child')?.record.parentSessionId).toBe('parent')
  })
})

describe('native agent rows: where the agent works (T3 resolveSubagentMetadata)', () => {
  const place = (fields: Partial<SessionRecord>) => ({ cwd: '/work/app', projectRoot: '/work/app', branch: 'main', isWorktree: false, ...fields }) as SessionRecord

  test('a child in its own worktree shows its branch', () => {
    expect(agentWorkspace(place({ cwd: '/work/app/.git/solus/worktrees/w1', branch: 'fix-favicon', isWorktree: true }), place({}))).toEqual([{ label: 'Branch', value: 'fix-favicon' }])
  })

  test('without a branch it names the worktree folder; another project leads with the project', () => {
    expect(agentWorkspace(place({ cwd: '/work/app/.git/solus/worktrees/w1', branch: null, isWorktree: true }), place({}))).toEqual([{ label: 'Worktree', value: 'w1' }])
    expect(agentWorkspace(place({ cwd: '/work/site', projectRoot: '/work/site', branch: null }), place({}))).toEqual([
      { label: 'Project', value: 'site' }, { label: 'Workspace', value: 'site' },
    ])
  })

  test('the same folder, or a record the host has not listed, shows nothing rather than a guess', () => {
    expect(agentWorkspace(place({}), place({}))).toEqual([])
    expect(agentWorkspace(place({ cwd: '/elsewhere' }), null)).toEqual([])
  })
})
