import { describe, expect, test } from 'bun:test'
import { automationAgents, isModelPickerAgentVisible } from '@solus/client-core/model-picker-agents'
import { AGENT_IDS, SESSION_AGENT_IDS, type AgentId } from '@solus/contracts/types'
import { buildAgentAvailabilityRows } from '@solus/workspace-ui/lib/agentAvailability'

const replay = {
  id: 'replay' as const,
  label: 'Replay (dev)',
  models: [{ id: 'showcase', label: 'Showcase' }],
  defaultModel: 'showcase',
  available: true,
}

describe('model picker development agents', () => {
  test('production clients exclude Replay even when the host offers it', () => {
    expect(isModelPickerAgentVisible('replay', false)).toBe(false)
    expect(buildAgentAvailabilityRows([replay], { replay }, false)).toEqual([])
  })

  test('development clients can still select Replay', () => {
    expect(isModelPickerAgentVisible('replay', true)).toBe(true)
    expect(buildAgentAvailabilityRows([replay], { replay }, true)).toEqual([
      expect.objectContaining({ id: 'replay', enabled: true }),
    ])
  })

  // The host registers the providers it runs. A client that keeps its own list
  // hides each new provider until someone edits that list, as mobile once hid Antigravity.
  test('every real provider is visible in both build modes, including one added later', () => {
    for (const provider of AGENT_IDS.filter((id) => id !== 'replay')) {
      expect(isModelPickerAgentVisible(provider, false)).toBe(true)
      expect(isModelPickerAgentVisible(provider, true)).toBe(true)
    }
  })
})

describe('automation model picker agents', () => {
  const metadata = (id: AgentId) => ({ id, label: id, models: [], defaultModel: '' })

  test('offers every provider with a headless runner, and only those', () => {
    const offered = automationAgents(AGENT_IDS.map(metadata)).map((agent) => agent.id)
    expect(offered).toEqual([...SESSION_AGENT_IDS])
    expect(offered).toContain('antigravity')
  })
})
