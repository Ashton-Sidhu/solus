import { describe, expect, test } from 'bun:test'
import { isModelPickerAgentVisible } from '@solus/client-core/model-picker-agents'
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

  test('real providers remain visible in both build modes', () => {
    for (const provider of ['claude-code', 'codex', 'opencode'] as const) {
      expect(isModelPickerAgentVisible(provider, false)).toBe(true)
      expect(isModelPickerAgentVisible(provider, true)).toBe(true)
    }
  })
})
