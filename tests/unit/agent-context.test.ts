import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  BUNDLED_MODEL_PROFILES,
  MODEL_PROFILES,
  isLegacyModel,
  replaceModelProfiles,
  type AgentMetadata,
  type ModelProfiles,
} from '@solus/contracts/types'
import { splitLegacyModels } from '@solus/workspace-ui/components/pickers/lib/picker-selection'

declare global {
  var $state: <T>(value: T) => T
  var $derived: { <T>(value: T): T; by<T>(fn: () => T): T }
}

const originalState = globalThis.$state
const originalDerived = globalThis.$derived

beforeEach(() => {
  globalThis.$state = <T>(value: T): T => value
  globalThis.$derived = Object.assign(<T>(value: T): T => value, { by: <T>(fn: () => T): T => fn() })
})

afterEach(() => {
  globalThis.$state = originalState
  globalThis.$derived = originalDerived
  replaceModelProfiles(BUNDLED_MODEL_PROFILES)
})

function publishedProfiles(): ModelProfiles {
  const list = structuredClone(BUNDLED_MODEL_PROFILES)
  list.antigravity = {
    'gemini-4-neon': {
      label: 'Gemini 4 Neon',
      isDefault: true,
      reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'medium',
      supportsFastMode: false,
      contextWindows: [524_288],
      defaultContextWindow: 524_288,
    },
    'gemini-4-carbon': {
      label: 'Gemini 4 Carbon',
      isLegacy: true,
      reasoningLevels: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
      supportsFastMode: false,
      contextWindows: [1_048_576],
      defaultContextWindow: 1_048_576,
    },
    'claude-opus-4-6-thinking': {
      label: 'Claude Opus 4.6 (Thinking)',
      isLegacy: true,
      reasoningLevels: [],
      defaultReasoningEffort: 'high',
      supportsFastMode: false,
      contextWindows: [1_000_000],
      defaultContextWindow: 1_000_000,
    },
    'gemini-3.7-flash': {
      label: 'Gemini 3.7 Flash',
      isLegacy: true,
      reasoningLevels: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
      supportsFastMode: false,
      contextWindows: [1_048_576],
      defaultContextWindow: 1_048_576,
    },
  }
  return list
}

describe('applyLiveModelProfiles', () => {
  test('keeps only offered models for an ACP agent and refreshes their legacy flags from live profiles', async () => {
    // WHY: Overwriting `meta.models` with `providerModelsFor()` dumped unoffered
    // models from model-profiles.json (Claude Opus 4.6, Gemini 3.7 Flash) into
    // the picker without adding them to `meta.modelProfiles`, so `isLegacyModel`
    // saw `undefined` and placed them in the main list instead of excluding them.
    const { applyLiveModelProfiles } = await import('@solus/workspace-ui/contexts/app/agent.context.svelte')
    replaceModelProfiles(publishedProfiles())

    const hydrated: AgentMetadata = {
      id: 'antigravity',
      label: 'Google Antigravity',
      available: true,
      modelsOffered: true,
      defaultModel: 'gemini-4-carbon',
      models: [
        { id: 'gemini-4-neon', label: 'Gemini 4 Neon' },
        { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon' },
      ],
      modelProfiles: {
        'gemini-4-neon': {
          label: 'Gemini 4 Neon',
          reasoningLevels: ['low', 'high'],
          defaultReasoningEffort: 'high',
          supportsFastMode: false,
          contextWindows: [1_048_576],
          defaultContextWindow: 1_048_576,
        },
        'gemini-4-carbon': {
          label: 'Gemini 4 Carbon',
          reasoningLevels: ['low', 'medium', 'high'],
          defaultReasoningEffort: 'medium',
          supportsFastMode: false,
          contextWindows: [1_048_576],
          defaultContextWindow: 1_048_576,
        },
      },
      capabilities: { planMode: true, permissions: true, transport: 'acp' },
    }

    const antigravity = applyLiveModelProfiles(hydrated)
    expect(antigravity.models.map((m) => m.id)).toEqual(['gemini-4-neon', 'gemini-4-carbon'])
    expect(antigravity.defaultModel).toBe('gemini-4-neon')
    // Preserves the efforts agy reported for the account.
    expect(antigravity.modelProfiles?.['gemini-4-neon']?.reasoningLevels).toEqual(['low', 'high'])
    expect(isLegacyModel('antigravity', 'gemini-4-carbon', antigravity.modelProfiles)).toBe(true)

    const sections = splitLegacyModels('antigravity', antigravity.models, antigravity.modelProfiles)
    expect(sections.current.map((m) => m.id)).toEqual(['gemini-4-neon'])
    expect(sections.legacy.map((m) => m.id)).toEqual(['gemini-4-carbon'])
  })

  test('preserves provider instance modelGroups overrides when refreshing offered models', async () => {
    const { applyLiveModelProfiles } = await import('@solus/workspace-ui/contexts/app/agent.context.svelte')
    replaceModelProfiles(publishedProfiles())

    const hydrated: AgentMetadata = {
      id: 'antigravity',
      label: 'Google Antigravity',
      available: true,
      modelsOffered: true,
      defaultModel: 'gemini-4-neon',
      models: [
        { id: 'gemini-4-neon', label: 'Gemini 4 Neon' },
        { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon' },
      ],
      modelProfiles: {
        'gemini-4-neon': {
          label: 'Gemini 4 Neon',
          reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'medium',
          supportsFastMode: false,
          contextWindows: [524_288],
          defaultContextWindow: 524_288,
        },
        'gemini-4-carbon': {
          label: 'Gemini 4 Carbon',
          reasoningLevels: ['low', 'medium', 'high'],
          defaultReasoningEffort: 'medium',
          supportsFastMode: false,
          contextWindows: [1_048_576],
          defaultContextWindow: 1_048_576,
        },
      },
      instancePreferences: {
        selected: 'antigravity',
        instances: [{
          id: 'antigravity',
          provider: 'antigravity',
          displayName: 'Google Antigravity',
          enabled: true,
          binaryAvailable: true,
          customModels: [],
          hiddenModels: [],
          favoriteModels: [],
          modelOrder: [],
          modelGroups: { 'gemini-4-carbon': 'current' },
        }],
        projects: [],
      },
      capabilities: { planMode: true, permissions: true, transport: 'acp' },
    }

    const antigravity = applyLiveModelProfiles(hydrated)
    expect(antigravity.models.map((m) => m.id)).toEqual(['gemini-4-neon', 'gemini-4-carbon'])
    expect(isLegacyModel('antigravity', 'gemini-4-carbon', antigravity.modelProfiles)).toBe(false)
  })

  test('updates modelProfiles when a non-offered provider refreshes from published profiles', async () => {
    // WHY: When a host has not reported offered models yet, `models` and
    // `modelProfiles` must refresh together so newly published legacy models
    // stay under Legacy instead of leaking into the main list.
    const { applyLiveModelProfiles } = await import('@solus/workspace-ui/contexts/app/agent.context.svelte')
    replaceModelProfiles(publishedProfiles())

    const hydrated: AgentMetadata = {
      id: 'antigravity',
      label: 'Google Antigravity',
      available: true,
      defaultModel: 'gemini-4-neon',
      models: [{ id: 'gemini-4-neon', label: 'Gemini 4 Neon' }],
      modelProfiles: {
        'gemini-4-neon': MODEL_PROFILES.antigravity!['gemini-4-neon']!,
      },
      capabilities: { planMode: true, permissions: true, transport: 'acp' },
    }

    const antigravity = applyLiveModelProfiles(hydrated)
    const sections = splitLegacyModels('antigravity', antigravity.models, antigravity.modelProfiles)
    expect(sections.current.map((m) => m.id)).toEqual(['gemini-4-neon'])
    expect(sections.legacy.map((m) => m.id)).toEqual([
      'gemini-4-carbon',
      'claude-opus-4-6-thinking',
      'gemini-3.7-flash',
    ])
  })
})
