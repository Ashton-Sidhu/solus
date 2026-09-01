import { describe, expect, test } from 'bun:test'
import type { TextGenerationSettingsSnapshot } from '@solus/contracts/types'
import { DEFAULT_HOST_CONFIG } from '@solus/contracts/host-config'
import type { HostConfigSnapshot } from '@solus/contracts/host-config'
import { TextGenerationSettingsStore } from '@solus/workspace-ui/contexts/projects/text-generation-settings.store.svelte'

/** The store ignores what `configUpdate` returns and re-reads the computed
 *  snapshot, because only that reports which model is actually available. */
const configSnapshot = (): HostConfigSnapshot => ({ config: DEFAULT_HOST_CONFIG, seeded: true })

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
    let modelA = 'gpt-5.6-luna'
    const hostA = {
      serverId: 'host-a',
      api: {
        textGenerationSettingsGet: async () => snapshot(modelA),
        configUpdate: async () => { modelA = 'gpt-5.5'; return configSnapshot() },
      },
    }
    const hostB = {
      serverId: 'host-b',
      api: {
        textGenerationSettingsGet: async () => snapshot('gpt-5.4'),
        configUpdate: async () => configSnapshot(),
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
