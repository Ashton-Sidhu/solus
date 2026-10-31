import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { z } from 'zod'
import { ProviderInstances } from '@solus/server/execution/seats/provider-instances'
import type { SecretStore } from '@solus/server/platform/secrets'
import { newProviderInstance } from '@solus/contracts/provider-instances'

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>()
  loadJson<T>(key: string, _path: string, schema: z.ZodType<T>): T | null {
    const raw = this.values.get(key)
    return raw ? schema.parse(JSON.parse(raw)) : null
  }
  saveJson<T>(key: string, _path: string, value: T) { this.values.set(key, JSON.stringify(value)) }
  remove(key: string) { this.values.delete(key) }
  canSave() { return true }
}
function usingStore(run: (store: ProviderInstances) => void) {
  const root = mkdtempSync(join(tmpdir(), 'solus-provider-instances-'))
  try { run(new ProviderInstances({ secrets: new MemorySecrets(), root })) }
  finally { rmSync(root, { recursive: true, force: true }) }
}
describe('private provider instances', () => {
  test('legacy instance model defaults are cleared when an instance is saved', () => usingStore((store) => {
    const instance = newProviderInstance('codex', 'work', 'Work')
    instance.defaultModel = 'legacy-default'
    store.write('alice', { expectedRevision: 0, change: { kind: 'save', instance } })
    expect(store.lookup('alice', 'work').defaultModel).toBeNull()
  }))
  test('project selection applies to new sessions, keeps existing bindings, and resets to the host choice', () => usingStore((store) => {
    const work = newProviderInstance('codex', 'work', 'Work')
    store.write('alice', { expectedRevision: 0, change: { kind: 'save', instance: work } })
    expect(store.forRun('alice', 'codex', 'old-session', false, '/repo').instance.id).toBe('codex')
    store.write('alice', { expectedRevision: 1, change: { kind: 'project', override: { projectRoot: '/repo', selected: { codex: 'work' }, enabled: {} } } })
    expect(store.forRun('alice', 'codex', 'old-session', true, '/repo').instance.id).toBe('codex')
    expect(store.forRun('alice', 'codex', 'new-session', false, '/repo').instance.id).toBe('work')
    expect(store.forRun('alice', 'codex', undefined, false, '/other').instance.id).toBe('codex')
    expect(store.snapshot('bob').projects).toEqual([])
    store.write('alice', { expectedRevision: 2, change: { kind: 'project', override: { projectRoot: '/repo', selected: {}, enabled: {} } } })
    expect(store.snapshot('alice').projects).toEqual([])
    expect(store.forRun('alice', 'codex', undefined, false, '/repo').instance.id).toBe('codex')
    expect(store.forRun('alice', 'codex', 'new-session', true, '/repo').instance.id).toBe('work')
  }))
  test('project availability can override either host value and still gates continuation turns', () => usingStore((store) => {
    const codex = newProviderInstance('codex', 'codex', 'Codex')
    codex.enabled = false
    store.write('alice', { expectedRevision: 0, change: { kind: 'save', instance: codex } })
    store.write('alice', { expectedRevision: 1, change: { kind: 'project', override: { projectRoot: '/repo', selected: {}, enabled: { codex: true } } } })
    expect(store.forRun('alice', 'codex', 'session', false, '/repo').instance.id).toBe('codex')
    expect(() => store.forRun('alice', 'codex', undefined, false, '/other')).toThrow('disabled')
    store.write('alice', { expectedRevision: 2, change: { kind: 'project', override: { projectRoot: '/repo', selected: {}, enabled: { codex: false } } } })
    expect(() => store.forRun('alice', 'codex', 'session', true, '/repo')).toThrow('disabled')
  }))
  test('a private transcript keeps its own home across default changes and cannot be removed with its instance', () => usingStore((store) => {
    const work = newProviderInstance('claude-code', 'work', 'Work')
    store.write('alice', { expectedRevision: 0, change: { kind: 'save', instance: work } })
    store.recordThreadHome('alice', 'claude-code', 'thread-one', 'work', '/fixture/private-home')
    expect(store.threadHome('alice', 'claude-code', 'thread-one')).toBe('/fixture/private-home')
    expect(store.threadHome('bob', 'claude-code', 'thread-one')).toBeUndefined()
    expect(store.snapshot('alice').revision).toBe(1)
    expect(store.snapshot('alice')).not.toHaveProperty('threadHomes')
    expect(() => store.write('alice', { expectedRevision: 1, change: { kind: 'remove', instanceId: 'work' } })).toThrow('has sessions')
  }))
  test('a person cannot list or use another person’s instances or secrets', () => usingStore((store) => {
    const instance = newProviderInstance('codex', 'work', 'Work')
    instance.environment.push({ name: 'OPENAI_API_KEY', value: 'private-test-value', sensitive: true })
    const saved = store.write('alice', { expectedRevision: 0, change: { kind: 'save', instance } })
    expect(saved.instances.find((item) => item.id === 'work')?.environment).toEqual([{ name: 'OPENAI_API_KEY', value: '', sensitive: true, configured: true }])
    expect(store.snapshot('bob').instances.some((item) => item.id === 'work')).toBe(false)
    expect(() => store.write('bob', { expectedRevision: 0, change: { kind: 'select', instanceId: 'work' } })).toThrow('Enable this provider instance')
    store.write('alice', { expectedRevision: 1, change: { kind: 'select', instanceId: 'work' } })
    expect(store.forRun('alice', 'codex').instance.environment[0]?.value).toBe('private-test-value')
    expect(store.forRun('bob', 'codex').instance.id).toBe('codex')
  }))
  test('an edit can preserve a masked secret but cannot copy one by naming another variable', () => usingStore((store) => {
    const instance = newProviderInstance('codex', 'work', 'Work')
    instance.environment.push({ name: 'TOKEN', value: 'private-test-value', sensitive: true })
    const saved = store.write('alice', { expectedRevision: 0, change: { kind: 'save', instance } })
    const masked = saved.instances.find((item) => item.id === 'work')!
    masked.displayName = 'Renamed'
    store.write('alice', { expectedRevision: 1, change: { kind: 'save', instance: masked } })
    store.write('alice', { expectedRevision: 2, change: { kind: 'select', instanceId: 'work' } })
    expect(store.forRun('alice', 'codex').instance.environment[0]?.value).toBe('private-test-value')
    masked.environment[0]!.name = 'OTHER_TOKEN'
    expect(() => store.write('alice', { expectedRevision: 3, change: { kind: 'save', instance: masked } })).toThrow('Enter a value')
  }))
  test('a stale client cannot replace a newer edit', () => usingStore((store) => {
    const instance = newProviderInstance('codex', 'work', 'Work')
    store.write('alice', { expectedRevision: 0, change: { kind: 'save', instance } })
    expect(() => store.write('alice', { expectedRevision: 0, change: { kind: 'save', instance } })).toThrow('changed on another client')
  }))
  test('changing the selected instance preserves an existing session’s binding', () => usingStore((store) => {
    const work = newProviderInstance('codex', 'work', 'Work')
    store.write('alice', { expectedRevision: 0, change: { kind: 'save', instance: work } })
    expect(store.forRun('alice', 'codex', 'session-one').instance.id).toBe('codex')
    store.write('alice', { expectedRevision: 1, change: { kind: 'select', instanceId: 'work' } })
    expect(store.forRun('alice', 'codex', 'session-one').instance.id).toBe('codex')
    expect(store.forRun('alice', 'codex', 'session-two').instance.id).toBe('work')
    expect(() => store.write('alice', { expectedRevision: 2, change: { kind: 'remove', instanceId: 'work' } })).toThrow('has sessions')
    work.enabled = false
    store.write('alice', { expectedRevision: 2, change: { kind: 'save', instance: work } })
    expect(() => store.forRun('alice', 'codex', 'session-two')).toThrow('disabled')
  }))
})
