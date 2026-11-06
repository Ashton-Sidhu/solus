import { beforeAll, describe, expect, mock, test } from 'bun:test'
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { DatabaseSync } from './helpers/bun-sqlite'
import { MODEL_PROFILES, type AgentMetadata, type IpcContext } from '@solus/contracts/types'
import { agentForProject } from '@solus/contracts/provider-instance-models'
import type { ProviderInstance } from '@solus/contracts/provider-instances'
import { modelOptionsFor, reasoningLevelsFor } from '@solus/workspace-ui/components/pickers/lib/picker-selection'
import { agentTargetFromMetadata } from '@solus/server/execution/agents/agent-targets'
import {
  gatewayDiscoveryWaitMs,
  reportedModelEffort,
  unlistedClaudeModelProfiles,
} from '@solus/server/execution/agents/claude/claude-models'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let ClaudeBackend: typeof import('@solus/server/execution/agents/claude/claude-backend')['ClaudeBackend']
beforeAll(async () => {
  ;({ ClaudeBackend } = await import('@solus/server/execution/agents/claude/claude-backend'))
})

// t3code #30511: Claude Code can run behind an Anthropic-compatible gateway and
// list that gateway's models, but Solus offered only the published list, so
// those models could not be picked.
const publishedId = Object.keys(MODEL_PROFILES['claude-code'] ?? {})[0]!

function reported(value: string, fields: Partial<ModelInfo> = {}): ModelInfo {
  return { value, displayName: value, description: '', ...fields }
}

describe('unlistedClaudeModelProfiles', () => {
  test('the published list stays authoritative, by id, by case, and by the [1m] variant', () => {
    expect(unlistedClaudeModelProfiles([
      reported(publishedId),
      reported(publishedId.toUpperCase()),
      reported(`${publishedId}[1m]`),
    ])).toEqual({})
  })

  test('an alias of a published model adds no row', () => {
    expect(unlistedClaudeModelProfiles([reported('sonnet', { resolvedModel: publishedId })])).toEqual({})
  })

  test('default is a pointer at a model, not a model', () => {
    expect(unlistedClaudeModelProfiles([reported('default', { resolvedModel: 'gateway/other' })])).toEqual({})
  })

  test('two rows for one model give one row', () => {
    const profiles = unlistedClaudeModelProfiles([
      reported('gateway/model'),
      reported('alias', { resolvedModel: 'gateway/model' }),
    ])
    expect(Object.keys(profiles)).toEqual(['gateway/model'])
  })

  test('a reported model offers the levels Claude Code reports, and fast mode only if reported', () => {
    const profiles = unlistedClaudeModelProfiles([
      reported('gateway/effort', { displayName: 'Gateway Effort', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsFastMode: true }),
      reported('gateway/plain', { supportedEffortLevels: ['low'] }),
    ])
    expect(profiles['gateway/effort']).toMatchObject({
      label: 'Gateway Effort', reasoningLevels: ['low', 'high'], defaultReasoningEffort: 'low', supportsFastMode: true,
    })
    // Levels without `supportsEffort` are not an offer.
    expect(profiles['gateway/plain']).toMatchObject({ reasoningLevels: [], supportsFastMode: false })
  })

  test('medium is the default when a model offers it, because Claude Code names no default', () => {
    const profiles = unlistedClaudeModelProfiles([
      reported('gateway/model', { supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }),
    ])
    expect(profiles['gateway/model']?.defaultReasoningEffort).toBe('medium')
  })
})

describe('reportedModelEffort', () => {
  const profiles = unlistedClaudeModelProfiles([
    reported('gateway/effort', { supportsEffort: true, supportedEffortLevels: ['low', 'medium'] }),
    reported('gateway/plain'),
  ])

  test('keeps an offered effort and replaces one the model does not offer', () => {
    expect(reportedModelEffort(profiles['gateway/effort']!, 'low')).toBe('low')
    expect(reportedModelEffort(profiles['gateway/effort']!, 'max')).toBe('medium')
  })

  test('a model with no levels is sent no effort, so Claude Code does not reject it', () => {
    expect(reportedModelEffort(profiles['gateway/plain']!, 'high')).toBeUndefined()
  })
})

describe('gatewayDiscoveryWaitMs', () => {
  const on = { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1', ANTHROPIC_BASE_URL: 'https://gateway.example' }

  test('no process waits unless discovery is on and a gateway is set', () => {
    expect(gatewayDiscoveryWaitMs({}, {})).toBe(0)
    expect(gatewayDiscoveryWaitMs({ ANTHROPIC_BASE_URL: on.ANTHROPIC_BASE_URL }, {})).toBe(0)
    expect(gatewayDiscoveryWaitMs({ CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' }, {})).toBe(0)
    expect(gatewayDiscoveryWaitMs({ ...on, CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: 'false' }, {})).toBe(0)
  })

  test('settings.json counts, with unquoted values, and wins over the environment', () => {
    expect(gatewayDiscoveryWaitMs({}, { ...on, CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: true })).toBe(3_000)
    expect(gatewayDiscoveryWaitMs(
      { ...on, CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS: '9000' },
      { CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS: 5_000 },
    )).toBe(5_000)
  })

  test('a setting cannot hold the process without limit', () => {
    expect(gatewayDiscoveryWaitMs({ ...on, CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS: '999999' }, {})).toBe(30_000)
  })
})

describe('ClaudeBackend metadata', () => {
  const context = { session: { workingDirectory: '/tmp' }, statusBar: { model: '' } } as unknown as IpcContext

  async function backendReporting(reportedModels: () => Promise<ModelInfo[]>) {
    const backend = new ClaudeBackend()
    let announced = 0
    backend.on('models-reported', () => { announced += 1 })
    Reflect.set(backend, 'agent', { reportedModels, supportedCommands: async () => [] })
    const read = async () => {
      await backend.listPluginCommands('/tmp', context)
      await Bun.sleep(1)
    }
    return { backend, read, announced: () => announced }
  }

  test('reported models reach the picker with their levels, and clients hear of them once', async () => {
    let reads = 0
    const { backend, read, announced } = await backendReporting(async () => {
      reads += 1
      return [reported('gateway/model', { supportsEffort: true, supportedEffortLevels: ['low'] })]
    })
    await read()
    await read()
    const { metadata } = backend

    expect(reads).toBe(1)
    expect(announced()).toBe(1)
    expect(modelOptionsFor('claude-code', { 'claude-code': metadata })).toContainEqual({ id: 'gateway/model', label: 'gateway/model' })
    expect(reasoningLevelsFor('claude-code', 'gateway/model', metadata)).toEqual(['low'])
    // A picker's default reads these profiles, so the published ones stay among them.
    expect(metadata.modelProfiles?.[publishedId]).toBe(MODEL_PROFILES['claude-code']?.[publishedId])
    expect(agentTargetFromMetadata(metadata).models.find(({ id }) => id === 'gateway/model')?.reasoningLevels).toEqual(['low'])
  })

  test('a host with no unlisted models keeps the published metadata and announces nothing', async () => {
    const { backend, read, announced } = await backendReporting(async () => [reported(publishedId)])
    await read()
    expect(backend.metadata.modelProfiles).toBeUndefined()
    expect(announced()).toBe(0)
  })

  test('a failed read is tried again', async () => {
    let reads = 0
    const { backend, read } = await backendReporting(async () => {
      reads += 1
      if (reads === 1) throw new Error('claude is not installed')
      return [reported('gateway/model')]
    })
    await read()
    expect(backend.metadata.modelProfiles).toBeUndefined()
    await read()
    expect(backend.metadata.modelProfiles?.['gateway/model']).toBeDefined()
  })
})

describe('ClaudeBackend runs', () => {
  type RunOptions = { model?: string; reasoningEffort?: string; disableReasoning?: boolean }

  async function runOptions(request: { model: string; reasoningEffort: string; providerRuntime?: unknown }): Promise<RunOptions> {
    const backend = new ClaudeBackend()
    const seen = Promise.withResolvers<RunOptions>()
    const execution = () => ({ events: (async function* () {})(), result: new Promise(() => {}), stopTask: async () => {} })
    const agent: { reportedModels: () => Promise<ModelInfo[]>; run: (options: RunOptions) => ReturnType<typeof execution> } = {
      reportedModels: async () => [
        reported('gateway/effort', { supportsEffort: true, supportedEffortLevels: ['low', 'medium'] }),
        reported('gateway/plain'),
      ],
      run: execution,
    }
    Reflect.set(backend, 'agent', agent)
    const base = { prompt: 'hello', cwd: '/tmp', tools: [], permissionMode: 'default', persistence: 'ephemeral' }
    const start = (runRequest: object) => Reflect.apply(backend.startRun, backend, [runRequest])
    // The first run starts the read; the next one sees what it found.
    start({ ...base, model: publishedId, reasoningEffort: 'high' })
    await Bun.sleep(1)
    agent.run = (options) => {
      seen.resolve(options)
      return execution()
    }
    start({ ...base, ...request })
    return seen.promise
  }

  test('a run on a model with no levels sends no effort', async () => {
    expect(await runOptions({ model: 'gateway/plain', reasoningEffort: 'high' })).toMatchObject({ disableReasoning: true })
  })

  test('a run on a reported model sends only an effort it offers', async () => {
    const options = await runOptions({ model: 'gateway/effort', reasoningEffort: 'max' })
    expect(options).toMatchObject({ reasoningEffort: 'medium', disableReasoning: false })
  })

  test('a published model keeps the requested effort', async () => {
    const options = await runOptions({ model: publishedId, reasoningEffort: 'high' })
    expect(options).toMatchObject({ reasoningEffort: 'high', disableReasoning: false })
  })

  test('a custom model of the same id keeps its own profile', async () => {
    const options = await runOptions({
      model: 'gateway/plain', reasoningEffort: 'high', providerRuntime: { launch: { env: {} }, modelProfiles: { 'gateway/plain': { contextWindows: [200_000] } } },
    })
    expect(options).toMatchObject({ reasoningEffort: 'high', disableReasoning: false })
  })
})

describe('agentForProject with a provider instance', () => {
  const instance = {
    id: 'instance', provider: 'claude-code', displayName: 'Claude', enabled: true, binaryAvailable: true,
    customModels: [], hiddenModels: [], favoriteModels: [], modelOrder: [], modelGroups: {},
  } as unknown as ProviderInstance

  function metadataFor(hiddenModels: string[]): AgentMetadata {
    const profiles = unlistedClaudeModelProfiles([reported('gateway/model')])
    return {
      id: 'claude-code', label: 'Claude Code', defaultModel: publishedId,
      models: [{ id: publishedId, label: 'Published' }, { id: 'gateway/model', label: 'gateway/model' }],
      modelProfiles: { ...MODEL_PROFILES['claude-code'], ...profiles },
      instancePreferences: { selected: 'instance', instances: [{ ...instance, hiddenModels }], projects: [] },
    } as unknown as AgentMetadata
  }

  // The catalog replaces the list, and it knows only published and custom models.
  test('a reported model stays in the list once, after the catalog', () => {
    const ids = agentForProject(metadataFor([])).models.map(({ id }) => id)
    expect(ids.filter((id) => id === 'gateway/model')).toHaveLength(1)
    expect(ids.at(-1)).toBe('gateway/model')
    expect(ids.filter((id) => id === publishedId)).toHaveLength(1)
  })

  test('a person can still hide a reported model', () => {
    const ids = agentForProject(metadataFor(['gateway/model'])).models.map(({ id }) => id)
    expect(ids).not.toContain('gateway/model')
  })
})
