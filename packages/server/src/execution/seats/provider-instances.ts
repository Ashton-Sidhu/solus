import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  newProviderInstance, providerInstancesSnapshotSchema, providerInstancesWriteSchema,
  type InstanceProvider, type ProviderInstance, type ProviderProjectOverride, type ProviderInstancesSnapshot, type ProviderInstancesWrite,
} from '@solus/contracts/provider-instances'
import { providerProjectOverride } from '@solus/contracts/provider-instance-models'
import { sameHostPath } from '@solus/contracts/host-path'
import { secretStore, type SecretStore } from '../../platform/secrets'
import { dataDir } from '../../platform/paths'

const storedSchema = providerInstancesSnapshotSchema.extend({
  bindings: z.record(z.string(), z.string()),
  authEpochs: z.record(z.string(), z.number()).default({}),
  threadHomes: z.record(z.string(), z.object({ instanceId: z.string(), home: z.string() })).default({}),
})
type StoredInstances = z.infer<typeof storedSchema>

function defaults(): StoredInstances {
  return {
    revision: 0, projects: [], instances: [newProviderInstance('claude-code', 'claude-code', 'Claude Code'), newProviderInstance('codex', 'codex', 'Codex')],
    selected: { 'claude-code': 'claude-code', codex: 'codex' },
    healthCheckSeconds: 300, idleCompaction: 'onReturn', bindings: {}, authEpochs: {}, threadHomes: {},
  }
}

/** Private to one person on this host. No request can supply another person's key. */
export class ProviderInstances {
  constructor(private readonly deps: { secrets: SecretStore; root: string }) {}

  private location(personKey: string) {
    const digest = createHash('sha256').update(personKey).digest('hex')
    return { key: `provider-instances-${digest}`, path: join(this.deps.root, `${digest}.enc`) }
  }

  private read(personKey: string): StoredInstances {
    const location = this.location(personKey)
    return this.deps.secrets.loadJson(location.key, location.path, storedSchema) ?? defaults()
  }

  private save(personKey: string, value: StoredInstances): void {
    if (!this.deps.secrets.canSave()) throw new Error('Secure storage is unavailable. Provider settings were not saved.')
    mkdirSync(this.deps.root, { recursive: true, mode: 0o700 })
    const location = this.location(personKey)
    this.deps.secrets.saveJson(location.key, location.path, value)
  }

  snapshot(personKey: string): ProviderInstancesSnapshot {
    const { bindings: _bindings, authEpochs: _authEpochs, threadHomes: _threadHomes, ...snapshot } = this.read(personKey)
    for (const instance of snapshot.instances) {
      for (const variable of instance.environment) {
        if (variable.sensitive) {
          variable.configured = variable.value.length > 0
          variable.value = ''
        }
      }
    }
    return { ...snapshot, configurationVersion: 2 }
  }

  write(personKey: string, input: ProviderInstancesWrite): ProviderInstancesSnapshot {
    const request = providerInstancesWriteSchema.parse(input)
    const state = this.read(personKey)
    if (state.revision !== request.expectedRevision) throw new Error('Provider settings changed on another client. Reload, then try again.')
    const change = request.change
    if (change.kind === 'save') {
      this.saveInstance(state, change.instance)
    } else if (change.kind === 'project') {
      this.saveProjectOverride(state, change.override)
    } else if (change.kind === 'remove') {
      this.removeInstance(state, change.instanceId)
    } else if (change.kind === 'select') {
      const instance = state.instances.find((candidate) => candidate.id === change.instanceId)
      if (!instance?.enabled) throw new Error('Enable this provider instance before selecting it.')
      state.selected[instance.provider] = instance.id
    } else {
      state.healthCheckSeconds = change.healthCheckSeconds
      state.idleCompaction = change.idleCompaction
    }
    state.revision++
    this.save(personKey, state)
    return this.snapshot(personKey)
  }

  private saveInstance(state: StoredInstances, input: ProviderInstance): void {
    const previous = state.instances.find((instance) => instance.id === input.id)
    if (previous && previous.provider !== input.provider) throw new Error('An instance cannot change its provider.')
    if (!previous && state.instances.length >= 50) throw new Error('Remove an instance before adding another.')
    const next = structuredClone(input)
    next.defaultModel = null
    preserveSensitiveValues(next, previous)
    if (previous) state.instances.splice(state.instances.indexOf(previous), 1, next)
    else state.instances.push(next)
  }

  private saveProjectOverride(state: StoredInstances, next: ProviderProjectOverride): void {
    for (const instanceId of Object.keys(next.enabled)) {
      if (!state.instances.some((instance) => instance.id === instanceId)) throw new Error('This provider instance is unavailable.')
    }
    for (const provider of ['codex', 'claude-code'] as const) {
      const selected = next.selected[provider]
      if (selected && !state.instances.some((instance) => instance.id === selected && instance.provider === provider)) throw new Error('Choose an instance for the matching provider.')
    }
    const at = state.projects.findIndex((project) => sameHostPath(project.projectRoot, next.projectRoot))
    const hasOverride = Object.keys(next.enabled).length > 0 || Object.values(next.selected).some(Boolean)
    if (at >= 0) state.projects.splice(at, 1)
    if (hasOverride && state.projects.length >= 1000) throw new Error('Remove a project override before adding another.')
    if (hasOverride) state.projects.push(next)
  }

  private removeInstance(state: StoredInstances, instanceId: string): void {
    if (instanceId === 'codex' || instanceId === 'claude-code') throw new Error('The built-in provider instance cannot be removed. Disable it instead.')
    if (Object.values(state.bindings).includes(instanceId) || Object.values(state.threadHomes).some((thread) => thread.instanceId === instanceId)) throw new Error('This instance has sessions. Disable it to keep those sessions resumable.')
    const instance = state.instances.find((candidate) => candidate.id === instanceId)
    if (!instance) throw new Error('This provider instance no longer exists.')
    state.instances.splice(state.instances.indexOf(instance), 1)
    for (const project of state.projects) {
      delete project.enabled[instance.id]
      if (project.selected[instance.provider] === instance.id) delete project.selected[instance.provider]
    }
    if (state.selected[instance.provider] === instance.id) state.selected[instance.provider] = instance.provider
  }

  lookup(personKey: string, instanceId: string): ProviderInstance {
    const instance = this.read(personKey).instances.find((item) => item.id === instanceId)
    if (!instance) throw new Error('This provider instance is no longer available.')
    return instance
  }

  authenticationChanged(personKey: string, instanceId: string): void {
    const state = this.read(personKey)
    if (!state.instances.some((instance) => instance.id === instanceId)) return
    state.authEpochs[instanceId] = (state.authEpochs[instanceId] ?? 0) + 1
    state.revision++
    this.save(personKey, state)
  }

  recordThreadHome(personKey: string, provider: InstanceProvider, threadId: string, instanceId: string, home: string): void {
    const state = this.read(personKey)
    if (!state.instances.some((instance) => instance.id === instanceId && instance.provider === provider)) throw new Error('This provider instance is unavailable.')
    const key = `${provider}:${threadId}`
    if (state.threadHomes[key]?.instanceId === instanceId && state.threadHomes[key]?.home === home) return
    state.threadHomes[key] = { instanceId, home }
    this.save(personKey, state)
  }

  threadHome(personKey: string, provider: InstanceProvider, threadId: string): string | undefined {
    return this.read(personKey).threadHomes[`${provider}:${threadId}`]?.home
  }

  /** A session keeps its instance when the person changes the default instance. */
  forRun(personKey: string, provider: InstanceProvider, sessionId?: string, continuation = false, projectRoot?: string) {
    const state = this.read(personKey)
    const bindingKey = sessionId ? `${provider}:${sessionId}` : null
    const project = providerProjectOverride(state.projects, projectRoot)
    const instanceId = bindingKey && state.bindings[bindingKey] || (continuation ? provider : project?.selected[provider] ?? state.selected[provider])
    const instance = state.instances.find((candidate) => candidate.provider === provider && candidate.id === instanceId)
    if (!instance) throw new Error('The provider instance for this session is unavailable.')
    if (!(project?.enabled[instance.id] ?? instance.enabled)) throw new Error(`${instance.displayName} is disabled. Check its availability in Settings → Projects or Providers.`)
    if (bindingKey && !state.bindings[bindingKey]) {
      // Avoid a write for the unchanged built-in defaults. No settings document exists yet.
      if (state.revision || instance.id !== provider) {
        state.bindings[bindingKey] = instance.id
        this.save(personKey, state)
      }
    }
    return { instance, idleCompaction: instance.idleCompaction === 'default' ? state.idleCompaction : instance.idleCompaction, revision: state.revision, authEpoch: state.authEpochs[instance.id] ?? 0 }
  }
}

let manager: ProviderInstances | null = null
export function privateProviderInstances(): ProviderInstances {
  manager ??= new ProviderInstances({ secrets: secretStore(), root: join(dataDir(), 'provider-instances') })
  return manager
}

function preserveSensitiveValues(next: ProviderInstance, previous: ProviderInstance | undefined): void {
  for (const variable of next.environment) {
    if (variable.configured && variable.sensitive && !variable.value) {
      const stored = previous?.environment.find((candidate) => candidate.name === variable.name && candidate.sensitive)
      if (!stored) throw new Error('Enter a value for the new sensitive variable.')
      variable.value = stored.value
    }
    delete variable.configured
  }
}
