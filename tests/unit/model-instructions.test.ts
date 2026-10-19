import { describe, expect, test } from 'bun:test'
import type { AgentMetadata } from '@solus/contracts/types'
import { modelInstructionGroups } from '@solus/workspace-ui/components/settings/agent-profile/lib/agent-profile-entries'
import { modelInstructionChoices } from '../../apps/mobile/src/features/settings/lib/agent-profile-entries'

/**
 * Per-model instructions are keyed by model id alone and added only when that
 * model runs, so each picker lists a model once and never hides one whose
 * instructions the person still has.
 */

function agent(id: AgentMetadata['id'], available: boolean, models: string[]): AgentMetadata {
  return { id, label: id, available, defaultModel: models[0] ?? '', models: models.map((model) => ({ id: model, label: model.toUpperCase() })) }
}

describe('per-model instructions on desktop and web', () => {
  test('lists the models of available agents, each id once', () => {
    const agents = [agent('claude-code', true, ['opus', 'shared']), agent('codex', true, ['shared', 'luna']), agent('opencode', false, ['other'])]
    expect(modelInstructionGroups(agents, {})).toEqual([
      { agentLabel: 'claude-code', models: [{ id: 'opus', label: 'OPUS' }, { id: 'shared', label: 'SHARED' }] },
      { agentLabel: 'codex', models: [{ id: 'luna', label: 'LUNA' }] },
    ])
  })

  test("a host's model list replaces the agent's own", () => {
    const agents = [agent('claude-code', true, ['opus'])]
    expect(modelInstructionGroups(agents, { 'claude-code': agent('claude-code', true, ['fable']) })[0]?.models.map((m) => m.id)).toEqual(['fable'])
  })
})

describe('per-model instructions on mobile', () => {
  test('a legacy model is listed only while it has instructions', () => {
    const without = modelInstructionChoices({}).map((choice) => choice.model)
    expect(without).toContain('claude-opus-5-5')
    expect(without).not.toContain('claude-opus-5')
    expect(modelInstructionChoices({ 'claude-opus-5': 'Show your work.' }).map((choice) => choice.model)).toContain('claude-opus-5')
  })
})
