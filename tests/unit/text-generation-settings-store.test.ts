import { describe, expect, test } from 'bun:test'
import type { TextGenerationSettingsSnapshot } from '../../src/shared/types'
import { TextGenerationSettingsStore } from '../../src/renderer/contexts/projects/text-generation-settings.store.svelte'

function snapshot(model: string): TextGenerationSettingsSnapshot {
  const selection = { provider: 'codex' as const, model }
  return {
    textGenerationModel: selection,
    backupTextGenerationModel: selection,
    sourceControlWriterModel: null,
    effectiveTextGenerationModel: selection,
    effectiveSourceControlWriterModel: selection,
    sourceControlWriting: {
      mode: 'repo_conventions',
      customInstructions: '',
      followPullRequestTemplate: true,
    },
    agents: [],
  }
}

describe('TextGenerationSettingsStore', () => {
  test('keeps host settings isolated and replaces the saved host snapshot', async () => {
    const store = new TextGenerationSettingsStore()
    const hostA = {
      serverId: 'host-a',
      api: {
        textGenerationSettingsGet: async () => snapshot('gpt-5.6-luna'),
        textGenerationSettingsUpdate: async () => snapshot('gpt-5.5'),
      },
    }
    const hostB = {
      serverId: 'host-b',
      api: {
        textGenerationSettingsGet: async () => snapshot('gpt-5.4'),
        textGenerationSettingsUpdate: async () => snapshot('gpt-5.4'),
      },
    }

    await Promise.all([store.load(hostA), store.load(hostB)])
    expect(store.snapshotFor('host-a')?.textGenerationModel.model).toBe('gpt-5.6-luna')
    expect(store.snapshotFor('host-b')?.textGenerationModel.model).toBe('gpt-5.4')

    await store.update(hostA, {
      textGenerationModel: { provider: 'codex', model: 'gpt-5.5' },
    })
    expect(store.snapshotFor('host-a')?.textGenerationModel.model).toBe('gpt-5.5')
    expect(store.snapshotFor('host-b')?.textGenerationModel.model).toBe('gpt-5.4')
  })
})
