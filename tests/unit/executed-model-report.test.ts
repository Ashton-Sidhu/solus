import { describe, expect, test } from 'bun:test'
import { ClaudeTurnNormalizer } from '@solus/server/execution/agents/claude/claude-event-normalizer'
import { catalogClaudeModelId } from '@solus/server/execution/agents/claude/claude-models'
import { formatSessionReport, parseOrchestrationItems } from '@solus/contracts/session-exchange'
import type { ClaudeEvent } from '@solus/contracts/claude-types'

function assistantFrame(model: string, parentToolUseId: string | null): ClaudeEvent {
  return {
    type: 'assistant',
    message: { model, id: `msg_${model}`, role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stop_reason: null, usage: {} },
    parent_tool_use_id: parentToolUseId,
    session_id: 'claude-session-1',
    uuid: `uuid-${model}`,
  } as ClaudeEvent
}

// A parent that asked for one model must learn that the provider ran another,
// such as when an organization does not allow the requested model.
describe('the model a delegated child really ran', () => {
  test('the report names the root agent model by its catalog id and says it differs', () => {
    const normalizer = new ClaudeTurnNormalizer()
    normalizer.push(assistantFrame('claude-sonnet-5-5-20261001', null))
    // A native sub-agent runs its own model; it is not the run's model.
    normalizer.push(assistantFrame('claude-haiku-5-5', 'toolu_subagent'))
    const executedModel = normalizer.summary.executedModel
    expect(executedModel).toBe('claude-sonnet-5-5')

    const text = formatSessionReport({
      sessionId: 'child', status: 'completed', outputs: [], reply: 'Reviewed.',
      model: 'claude-opus-5-5', executedModel,
    })
    expect(text.split('\n')[1]).toBe('Requested model claude-opus-5-5; the provider reported running claude-sonnet-5-5.')
    const [item] = parseOrchestrationItems(text) ?? []
    expect(item?.type === 'report' && item.report.executedModel).toBe('claude-sonnet-5-5')
  })

  test('a dated id the catalog lists keeps its date', () => {
    expect(catalogClaudeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
  })

  test('a report whose model ran as asked has no note', () => {
    const text = formatSessionReport({
      sessionId: 'child', status: 'completed', outputs: [], reply: 'Reviewed.',
      model: 'claude-opus-5-5', executedModel: 'claude-opus-5-5',
    })
    expect(text).not.toContain('Requested model')
  })
})
