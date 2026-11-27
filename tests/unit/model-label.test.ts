import { describe, expect, test } from 'bun:test'
import { BUNDLED_MODEL_PROFILES, modelLabelFor, replaceModelProfiles } from '@solus/contracts/types'
import { handoffDividerText } from '../../apps/mobile/solus-core/features/conversation/lib/provider-handoff'

describe('modelLabelFor', () => {
  test('uses the selectable model label for a Claude long-context runtime id', () => {
    // WHY: Claude reports `[1m]` on the runtime id. That transport detail must
    // not replace the human-readable model name in a handoff divider.
    expect(modelLabelFor('claude-code', 'claude-opus-5[1m]')).toBe('Opus 5')
  })

  test.each([
    ['gemini-4-neon', 'Gemini 4 Neon'],
    ['gemini-4-carbon', 'Gemini 4 Carbon'],
    ['gemini-4-argon', 'Gemini 4 Argon'],
    ['gemini-4-hydrogen', 'Gemini 4 Hydrogen'],
    ['gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'],
    ['gemini-pro-orchestrator', 'Orchestrator (Carbon)'],
    ['gemini-pro-orchestrator-argon', 'Orchestrator (Argon)'],
    ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
    ['gemini-3.7-flash', 'Gemini 3.7 Flash'],
    ['gemini-3.6-flash', 'Gemini 3.6 Flash'],
    ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro'],
  ])('resolves %s without an account catalog', (modelId, label) => {
    expect(modelLabelFor('antigravity', modelId)).toBe(label)
  })

  test('uses the bundled label when an older host catalog omits the model', () => {
    const hydrogen = BUNDLED_MODEL_PROFILES.antigravity!['gemini-4-hydrogen']!
    replaceModelProfiles({ antigravity: { 'gemini-4-hydrogen': { ...hydrogen, label: 'Updated Hydrogen label' } } })
    try {
      expect(modelLabelFor('antigravity', 'gemini-4-hydrogen')).toBe('Updated Hydrogen label')
      expect(modelLabelFor('antigravity', 'gemini-4-neon')).toBe('Gemini 4 Neon')
    } finally {
      replaceModelProfiles(BUNDLED_MODEL_PROFILES)
    }
  })

  test('uses the shared Gemini label in the mobile handoff divider', () => {
    expect(handoffDividerText({
      fromProvider: 'codex',
      fromModel: 'gpt-6.2-sol',
      provider: 'antigravity',
      model: 'gemini-4-neon',
    })).toBe('Gpt 6.2 Sol → Gemini 4 Neon')
  })

  test('keeps an unknown model name visible', () => {
    expect(modelLabelFor('codex', 'future-model')).toBe('future-model')
  })
})
