import { describe, expect, test } from 'bun:test'
import { MODEL_PROFILES, REASONING_EFFORT_LABELS } from '../../src/shared/types'

describe('Codex model profiles', () => {
  test('exposes Ultra only on the GPT-5.6 models that support it', () => {
    // WHY: Ultra is a distinct Codex effort value (not Claude's "ultracode"),
    // and showing it for Luna would produce an app-server validation failure.
    expect(MODEL_PROFILES.codex?.['gpt-5.6-sol']?.reasoningLevels).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ])
    expect(MODEL_PROFILES.codex?.['gpt-5.6-terra']?.reasoningLevels).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ])
    expect(MODEL_PROFILES.codex?.['gpt-5.6-luna']?.reasoningLevels).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max',
    ])
    expect(REASONING_EFFORT_LABELS.ultra).toBe('Ultra')
  })

  test('matches the current Codex defaults', () => {
    // WHY: a new session must start at the provider's advertised default rather
    // than silently spending more reasoning tokens than the user selected.
    expect(MODEL_PROFILES.codex?.['gpt-5.6-sol']?.defaultReasoningEffort).toBe('low')
    expect(MODEL_PROFILES.codex?.['gpt-5.6-terra']?.defaultReasoningEffort).toBe('medium')
    expect(MODEL_PROFILES.codex?.['gpt-5.5']?.defaultReasoningEffort).toBe('medium')
  })

  test('does not offer the unsupported none effort for current Codex models', () => {
    // WHY: app-server advertises Low as the minimum for these models; passing
    // None from a static profile would fail only after the user starts a turn.
    for (const modelId of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']) {
      expect(MODEL_PROFILES.codex?.[modelId]?.reasoningLevels).not.toContain('none')
    }
  })
})
