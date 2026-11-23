import { describe, expect, test } from 'bun:test'
import {
  formatCompactElapsed,
  railAgentList,
  relatedSessionTitle,
  sessionAgentMessages,
} from '@solus/workspace-ui/components/project-panel/lib/rail-agents'
import type { AgentConversationRef, AgentExchangeStatus, Message, Session, SessionMeta } from '@solus/contracts/types'
import type { AgentActivity } from '@solus/contracts/agent-activity'
import type { SessionExecution, SessionExecutionPhase, SessionTurnOutcome } from '@solus/contracts/session-execution'
import { agentExecutionLink } from '@solus/workspace-ui/components/conversation/lib/agent-link'
import {
  agentConversationLink,
} from '@solus/workspace-ui/components/conversation/agent-conversation/lib/agent-conversation'

const NOW = 100_000

test('a related row uses the open fork title on its host and the saved title when closed', () => {
  const relation = { kind: 'fork' as const, sessionId: 'fork', title: 'Saved prompt', runnerHostId: 'runner' }
  const workspace = {
    tabIdForHostSession: (sessionId: string, host: string | undefined) =>
      sessionId === 'fork' && host === 'runner' ? 'tab' : undefined,
    sessionFor: () => ({ title: 'Fork: Session Pinning Behavior' }) as Session,
  }

  expect(relatedSessionTitle(relation, 'local', workspace)).toBe('Fork: Session Pinning Behavior')
  expect(relatedSessionTitle({ ...relation, runnerHostId: 'other' }, 'local', workspace)).toBe('Saved prompt')
})

const phaseOf = (phase: SessionExecutionPhase): SessionExecution => ({
  revision: 1, current: { runId: 'run', startedAt: NOW - 2000, phase }, lastTurn: null,
})
const outcomeOf = (outcome: SessionTurnOutcome): SessionExecution => ({
  revision: 2, current: null, lastTurn: { runId: 'run', startedAt: NOW - 3000, endedAt: NOW - 1000, outcome },
})
const CONTEXT = {
  fallback: { model: 'Sonnet 5', effort: 'medium' },
  metaFor: (): SessionMeta | undefined => undefined,
  hostLabel: null,
  activityOf: (): AgentActivity | null => null,
  executionOf: (ref: AgentConversationRef): SessionExecution =>
    ref.sessionId === 'done-session' ? outcomeOf('completed') : phaseOf('running'),
  subagentExecutionOf: (toolId: string): SessionExecution => {
    if (toolId === 'live' || toolId === 'reader') return phaseOf('running')
    return outcomeOf(toolId === 'b' ? 'failed' : 'completed')
  },
}

function subagent(overrides: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    role: 'tool',
    content: '',
    toolName: 'Agent',
    timestamp: NOW - 60_000,
    toolCompletedAt: NOW - 30_000,
    toolStatus: 'completed',
    subMessages: [],
    ...overrides,
  } as Message
}

function sessionCard(id: string, sessionId: string, status: AgentExchangeStatus, timestamp: number): Message {
  const ref: AgentConversationRef = {
    sessionId,
    provider: 'codex',
    title: `Session ${sessionId}`,
    cwd: '/repo',
    origin: 'created',
    exchanges: [{ messageId: id, index: 0, prompt: 'go', dispatchedAt: timestamp, status }],
  }
  return { id, role: 'assistant', content: '', timestamp, agentConversationRef: ref } as Message
}

describe('session agents', () => {
  test('sub-agents and the sessions this one started are both agents; other tool calls are not', () => {
    const messages = [
      { id: 'u', role: 'user', content: 'go', timestamp: NOW } as Message,
      { id: 't', role: 'tool', content: '', toolName: 'Read', timestamp: NOW } as Message,
      subagent({ id: 'a', toolName: 'Task' }),
      sessionCard('c', 's1', 'running', NOW),
    ]

    expect(sessionAgentMessages(messages).map((m) => m.id)).toEqual(['a', 'c'])
  })
})

describe('rail list', () => {
  test('one list for both kinds: live agents show, settled ones fold under Previous, newest first', () => {
    const list = railAgentList(
      [
        subagent({ id: 'old', timestamp: NOW - 90_000 }),
        subagent({ id: 'live', toolStatus: 'running', timestamp: NOW - 80_000 }),
        sessionCard('c1', 'running-session', 'running', NOW - 50_000),
        sessionCard('c2', 'done-session', 'done', NOW - 20_000),
      ],
      NOW,
      CONTEXT,
    )

    expect(list.active.map((row) => row.id)).toEqual(['running-session', 'live'])
    expect(list.previous.map((row) => row.id)).toEqual(['done-session', 'old'])
    expect(list.detail).toBe('2 running')
  })

  test('a session messaged across turns is one row: it shows the saved session status and sorts by its first card', () => {
    const list = railAgentList(
      [
        sessionCard('first', 's1', 'done', NOW - 90_000),
        subagent({ id: 'between', timestamp: NOW - 50_000 }),
        sessionCard('second', 's1', 'running', NOW - 10_000),
      ],
      NOW,
      CONTEXT,
    )

    expect(list.active.map((row) => row.key)).toEqual(['session:s1'])
    expect(list.previous.map((row) => row.key)).toEqual(['subagent:between'])
  })

  test('the index title and provider win over what the dispatch guessed', () => {
    const list = railAgentList([sessionCard('c', 's1', 'done', NOW)], NOW, {
      ...CONTEXT,
      executionOf: () => outcomeOf('completed'),
      metaFor: () => ({ slug: 'audit-the-rpc-chain', provider: 'claude-code' }) as SessionMeta,
    })

    expect(list.previous[0]).toMatchObject({ title: 'audit-the-rpc-chain', provider: 'claude-code' })
  })

  test('the header counts running agents, and outcomes once none run', () => {
    expect(railAgentList([], NOW, CONTEXT).detail).toBe('')
    expect(railAgentList([subagent({ id: 'a' }), subagent({ id: 'b', toolStatus: 'error' })], NOW, CONTEXT).detail).toBe('1 done · 1 failed')
  })
})

describe('rail marks', () => {
  // WHY: the Agents card and the conversation show one agent, so they must
  // show it in one mark: a person who reads "Reading" in the transcript must
  // not read "Working" in the card.
  test('a rail row has the mark the conversation row gives the same agent', () => {
    const reader = subagent({
      id: 'reader',
      toolStatus: 'running',
      subMessages: [{ id: 'r', role: 'tool', content: '', toolName: 'Read', toolStatus: 'running', timestamp: NOW } as Message],
    })
    const replying = sessionCard('c1', 'replying', 'running', NOW)
    const waiting = sessionCard('c2', 'waiting', 'waiting_for_children', NOW)
    const context = {
      ...CONTEXT,
      executionOf: (ref: AgentConversationRef) => phaseOf(ref.sessionId === 'waiting' ? 'background' : 'running'),
      activityOf: (ref: AgentConversationRef) => ref.sessionId === 'replying' ? 'edit' as const : null,
    }
    const list = railAgentList([reader, replying, waiting], NOW, context)
    const byId = new Map(list.active.map((row) => [row.id, row.mark]))

    expect(byId.get('reader')).toEqual(agentExecutionLink(phaseOf('running'), { providerSubagent: true }).mark)
    expect(byId.get('reader')).toEqual({ kind: 'dot', mark: 'working' })
    const replyingRef = replying.agentConversationRef!
    expect(byId.get('replying')).toEqual(agentConversationLink(replyingRef, context.executionOf(replyingRef), 'edit').mark)
    expect(byId.get('replying')).toEqual({ kind: 'dot', mark: 'editing' })
    expect(byId.get('waiting')).toEqual({ kind: 'dot', mark: 'background' })
  })

  // WHY: the host's activity is live only while the session replies; a
  // settled session must not keep the dot mark of its last step.
  test('a settled session reads no activity', () => {
    let reads = 0
    const context = { ...CONTEXT, activityOf: () => { reads++; return 'read' as const } }
    const list = railAgentList([sessionCard('c', 'done-session', 'done', NOW)], NOW, context)
    expect(list.previous[0]!.mark).toEqual({ kind: 'glyph', status: 'finished' })
    expect(reads).toBe(0)
  })
})

test('elapsed time fits a narrow row', () => {
  expect(formatCompactElapsed(45_000)).toBe('45s')
  expect(formatCompactElapsed(12 * 60_000 + 30_000)).toBe('12m')
  expect(formatCompactElapsed(90 * 60_000)).toBe('1.5h')
  expect(formatCompactElapsed(14 * 3_600_000)).toBe('14h')
})
