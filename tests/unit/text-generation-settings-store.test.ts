import { describe, expect, test } from 'bun:test'
import type { TextGenerationSettingsSnapshot } from '@solus/contracts/types'
import { TextGenerationSettingsStore } from '@solus/workspace-ui/contexts/projects/text-generation-settings.store.svelte'

/** A host's snapshot says which models it offers and what it falls back to. The
 *  person's choice is not stored here (plans/018 §3.1), so the store only reads. */
function snapshot(model: string): TextGenerationSettingsSnapshot {
  const selection = { provider: 'codex' as const, model }
  return {
    textGenerationModel: selection,
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
  test('keeps each host its own snapshot and re-reads one host on force', async () => {
    const store = new TextGenerationSettingsStore()
    let modelA = 'gpt-5.6-luna'
    const hostA = { serverId: 'host-a', api: { textGenerationSettingsGet: async () => snapshot(modelA) } }
    const hostB = { serverId: 'host-b', api: { textGenerationSettingsGet: async () => snapshot('gpt-5.4') } }

    await Promise.all([store.load(hostA), store.load(hostB)])
    expect(store.snapshotFor('host-a')?.effectiveTextGenerationModel.model).toBe('gpt-5.6-luna')
    expect(store.snapshotFor('host-b')?.effectiveTextGenerationModel.model).toBe('gpt-5.4')

    modelA = 'gpt-5.5'
    await store.load(hostA)
    expect(store.snapshotFor('host-a')?.effectiveTextGenerationModel.model).toBe('gpt-5.6-luna')
    await store.load(hostA, { force: true })
    expect(store.snapshotFor('host-a')?.effectiveTextGenerationModel.model).toBe('gpt-5.5')
    expect(store.snapshotFor('host-b')?.effectiveTextGenerationModel.model).toBe('gpt-5.4')
  })

  test('the store has no write path: a host never holds the person’s choice', () => {
    expect('update' in TextGenerationSettingsStore.prototype).toBe(false)
  })
})
