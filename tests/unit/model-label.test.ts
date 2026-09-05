import { describe, expect, test } from 'bun:test'
import { modelLabelFor } from '@solus/contracts/types'

describe('modelLabelFor', () => {
  test('uses the selectable model label for a Claude long-context runtime id', () => {
    // WHY: Claude reports `[1m]` on the runtime id. That transport detail must
    // not replace the human-readable model name in a handoff divider.
    expect(modelLabelFor('claude-code', 'claude-opus-5[1m]')).toBe('Opus 5')
  })

  test('keeps an unknown model name visible', () => {
    expect(modelLabelFor('codex', 'future-model')).toBe('future-model')
  })
})
