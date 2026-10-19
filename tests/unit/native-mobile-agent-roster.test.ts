import { describe, expect, test } from 'bun:test'
import type { AgentConversationUpdate, WireNormalizedEvent } from '@solus/contracts/types'
import { TranscriptModel } from '../../apps/mobile/src/features/conversation/lib/transcript-model'
import { agentPresentation, agentsPillLabel } from '../../apps/mobile/src/features/threads/agent-card-presentation'
import { agentCandidates, agentRoster } from '../../apps/mobile/src/features/threads/agent-roster'

// T3 Code #20785: the Agents pill and sheet list the newest turn's agents and
// every earlier agent that still works or waits.

const update = (u: AgentConversationUpdate): WireNormalizedEvent => ({ type: 'agent_conversation_update', update: u }) as WireNormalizedEvent
const dispatched = (messageId: string, sessionId: string, at = 1_000): WireNormalizedEvent => update({
  phase: 'dispatched', sessionId, messageId, origin: 'created', prompt: `Work for ${sessionId}.`, provider: 'codex',
  title: `Work for ${sessionId}.`, cwd: '/work/app', model: 'gpt-5.5', dispatchedAt: at,
})
const accepted = (messageId: string, sessionId: string) => update({ phase: 'accepted', sessionId, messageId, state: 'running' })
const settled = (messageId: string, sessionId: string, status: 'completed' | 'failed' = 'completed') =>
  update({ phase: 'settled', sessionId, messageId, status, replyText: 'Done.', durationMs: 1_000, settledAt: 9_000 })
const subagent = (toolId: string): WireNormalizedEvent =>
  ({ type: 'tool_call', toolName: 'Agent', toolId, index: 0, toolInput: `{"description":"Subagent ${toolId}"}`, isSubagent: true, subagentType: 'claude' }) as WireNormalizedEvent
const subagentResult = (toolId: string, status: 'ok' | 'error' = 'ok') =>
  ({ type: 'tool_result', toolUseId: toolId, status, contentBytes: 10 }) as WireNormalizedEvent

/** What `useAgentRoster` computes: candidates from the order, presentations from each item. */
function roster(model: TranscriptModel, candidates = agentCandidates({ item: (id) => model.items.get(id) }, model.order)) {
  const rows = candidates.ids.flatMap((id) => {
    const item = model.items.get(id)
    const row = item ? agentPresentation(item, null) : null
    return row ? [row] : []
  })
  return agentRoster(rows, candidates)
}
const titles = (model: TranscriptModel, candidates?: ReturnType<typeof agentCandidates>) => roster(model, candidates).map((row) => row.title)

/** Turn 1 starts a Solus session and a provider subagent that keep running; turn 2 starts one that finishes. */
function twoTurns() {
  const model = new TranscriptModel('parent')
  model.addOptimisticUser('u1', 'start the background work')
  model.apply(dispatched('m1', 'child-1'))
  model.apply(accepted('m1', 'child-1'))
  model.apply(subagent('sa-1'))
  model.addOptimisticUser('u2', 'meanwhile, check the docs')
  model.apply(subagent('sa-2'))
  model.apply(subagentResult('sa-2'))
  return model
}

describe('agents pill roster', () => {
  test('a new prompt keeps the earlier agents that still run, beside the newest turn', () => {
    const model = twoTurns()
    expect(titles(model)).toEqual(['Work for child-1.', 'Subagent sa-1', 'Subagent sa-2'])
    // The pill counts them while the parent session is idle.
    expect(agentsPillLabel(roster(model), false)?.label).toBe('2/3')
  })

  test('an earlier agent that settles leaves, with no new transcript row', () => {
    const model = twoTurns()
    const candidates = agentCandidates({ item: (id) => model.items.get(id) }, model.order)
    const order = [...model.order]
    model.apply(settled('m1', 'child-1'))
    model.apply(subagentResult('sa-1', 'error'))
    expect(model.order).toEqual(order)
    // The same candidates, read again through their items, as the item subscriptions do.
    expect(titles(model, candidates)).toEqual(['Subagent sa-2'])
    expect(agentsPillLabel(roster(model, candidates), false)).toBeNull()
  })

  test('an earlier agent that waits stays listed, and leaves when it fails', () => {
    const model = twoTurns()
    model.apply(update({ phase: 'rate_limited', sessionId: 'child-1', messageId: 'm1' }))
    expect(roster(model).find((row) => row.title === 'Work for child-1.')).toMatchObject({ live: true, tone: 'waiting' })
    model.apply(settled('m1', 'child-1', 'failed'))
    expect(titles(model)).not.toContain('Work for child-1.')
  })

  test('the newest turn keeps its settled agents, as before', () => {
    const model = twoTurns()
    expect(roster(model).find((row) => row.title === 'Subagent sa-2')).toMatchObject({ live: false, tone: 'completed' })
  })

  test('settled agents of earlier turns stay out', () => {
    const model = new TranscriptModel('parent')
    model.addOptimisticUser('u1', 'go')
    model.apply(subagent('sa-1'))
    model.apply(subagentResult('sa-1'))
    model.apply(dispatched('m1', 'child-1'))
    model.apply(settled('m1', 'child-1'))
    model.addOptimisticUser('u2', 'next')
    expect(roster(model)).toEqual([])
  })

  test('a session messaged in two turns is one row: its newest card', () => {
    const model = new TranscriptModel('parent')
    model.addOptimisticUser('u1', 'start it')
    model.apply(dispatched('m1', 'child-1'))
    model.apply(accepted('m1', 'child-1'))
    model.addOptimisticUser('u2', 'tell it more')
    model.apply(dispatched('m2', 'child-1', 2_000))
    const rows = roster(model)
    expect(rows).toHaveLength(1)
    const newestCard = agentCandidates({ item: (id) => model.items.get(id) }, model.order).ids.at(-1)
    expect(rows[0]!.id).toBe(newestCard!)
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
  })

  test('a conversation with no prompt row lists all its agents as its newest turn', () => {
    const model = new TranscriptModel('parent')
    model.apply(subagent('sa-1'))
    model.apply(subagentResult('sa-1'))
    expect(titles(model)).toEqual(['Subagent sa-1'])
  })

  test('candidates are the transcript agents only, each once, with the newest turn marked', () => {
    const model = twoTurns()
    model.apply({ type: 'tool_call', toolName: 'Bash', toolId: 'bash-1', index: 1, toolInput: 'ls' } as WireNormalizedEvent)
    const candidates = agentCandidates({ item: (id) => model.items.get(id) }, model.order)
    expect(candidates.ids).toHaveLength(3)
    expect(new Set(candidates.ids).size).toBe(3)
    expect([...candidates.newestTurn]).toEqual([candidates.ids[2]!])
    expect(candidates.sessionOf.get(candidates.ids[0]!)).toBe('child-1')
  })
})
