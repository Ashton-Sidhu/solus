import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { MODEL_PROFILES } from '@solus/contracts/types'
import { agentForProject } from '@solus/contracts/provider-instance-models'
import { reasoningLevelsFor } from '@solus/workspace-ui/components/pickers/lib/picker-selection'
import type { Model } from '@solus/server/execution/agents/codex/generated/v2/Model'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']
beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
})

// t3code #27931: Codex `model/list` reports each model's reasoning efforts, but
// Solus read levels only from model-profiles.json, so a model missing from it
// got a low/medium/high guess.
const knownModelId = Object.keys(MODEL_PROFILES.codex ?? {})[0]!
function codexModel(id: string, efforts: string[], defaultEffort: string): Model {
  return {
    id, model: id, upgrade: null, upgradeInfo: null, availabilityNux: null, displayName: id, description: '', hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: '' })),
    defaultReasoningEffort: defaultEffort, inputModalities: [], supportsPersonality: false, additionalSpeedTiers: [],
    serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }], defaultServiceTier: null, isDefault: false,
  }
}

async function backendWithLiveModels(models: Model[]) {
  const backend = new CodexBackend()
  const requests: string[] = []
  Reflect.set(backend, 'client', {
    hasStarted: true,
    request: async (method: string) => {
      requests.push(method)
      if (method === 'model/list') return { data: models, nextCursor: null }
      return { data: [], nextCursor: null }
    },
  })
  backend.requestSessionIndexRefresh()
  await Bun.sleep(1)
  Reflect.get(backend, 'sessionIndexRefreshTimer') && clearTimeout(Reflect.get(backend, 'sessionIndexRefreshTimer'))
  return { backend, requests }
}

describe('Codex reasoning levels for models the published list does not know', () => {
  test('a new Codex model offers the levels Codex reports, on every client that reads the metadata', async () => {
    const { backend } = await backendWithLiveModels([codexModel('gpt-9-codex-new', ['minimal', 'low', 'medium', 'high', 'xhigh'], 'xhigh')])
    const metadata = backend.metadata
    expect(reasoningLevelsFor('codex', 'gpt-9-codex-new', metadata)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(metadata.modelProfiles?.['gpt-9-codex-new']).toMatchObject({ defaultReasoningEffort: 'xhigh', supportsFastMode: true })
    // A provider instance's catalog keeps the live profile under its own.
    const instance = { id: 'codex-default', provider: 'codex' as const, displayName: 'Codex', enabled: true, customModels: [], hiddenModels: [], favoriteModels: [], modelOrder: [], binaryAvailable: true }
    const project = agentForProject({ ...metadata, instancePreferences: { selected: instance.id, instances: [instance], projects: [] } })
    expect(reasoningLevelsFor('codex', 'gpt-9-codex-new', project)).toContain('xhigh')
  })

  test('the published profile stays authoritative for a model it knows', async () => {
    const { backend } = await backendWithLiveModels([codexModel(knownModelId, ['low'], 'low')])
    expect(backend.metadata.modelProfiles).toBeUndefined()
    expect(reasoningLevelsFor('codex', knownModelId, backend.metadata)).toEqual(MODEL_PROFILES.codex![knownModelId]!.reasoningLevels)
  })

  test('a host whose Codex never started does not start it to read models', () => {
    const backend = new CodexBackend()
    const requests: string[] = []
    Reflect.set(backend, 'client', { hasStarted: false, request: async (method: string) => { requests.push(method); return {} } })
    backend.requestSessionIndexRefresh()
    expect(requests).toEqual([])
    expect(backend.metadata.modelProfiles).toBeUndefined()
  })
})
