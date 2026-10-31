import { describe, expect, test } from 'bun:test'
import { ProviderInstancesClient } from '@solus/client-core/provider-instances'
import { asHostApi } from '@solus/client-core/host-api'
import { newProviderInstance, type ProviderInstancesSnapshot, type ProviderInstancesWrite, type ProviderInstanceStatus } from '@solus/contracts/provider-instances'
import type { SeatConnectStartResult } from '@solus/contracts/seats'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function snapshot(revision = 0): ProviderInstancesSnapshot {
  return { projects: [], revision, instances: [newProviderInstance('codex', 'codex', 'Codex')], selected: { codex: 'codex', 'claude-code': 'claude-code' }, healthCheckSeconds: 300, idleCompaction: 'onReturn' }
}
function status(): ProviderInstanceStatus {
  return { instanceId: 'codex', checkedAt: 1, version: 'fixture', authenticated: false, account: null, phase: 'idle', error: null }
}
function harness() {
  const api = {
    providerInstancesGet: async () => snapshot(),
    providerInstancesWrite: async () => snapshot(1),
    providerInstanceStatus: async () => status(),
    providerInstanceSignIn: async (): Promise<SeatConnectStartResult> => ({ verificationUrl: 'https://example.com', requiresCodeInput: false }),
    providerInstanceSubmitCode: async () => true,
    providerInstanceCancelSignIn: async () => true,
    providerInstanceSignOut: async () => status(),
  }
  return { api, client: new ProviderInstancesClient(() => api) }
}
describe('private provider client state', () => {
  test('older host replies gain safe defaults and runtime edits omit unsupported instance fields', async () => {
    const { defaultModel: _defaultModel, ...instance } = newProviderInstance('codex', 'codex', 'Codex')
    const { projects: _projects, ...older } = snapshot()
    const reply = { ...older, instances: [instance] }
    let sent: ProviderInstancesWrite | undefined
    const client = new ProviderInstancesClient(() => asHostApi({
      providerInstancesGet: async () => reply,
      providerInstancesWrite: async (request: ProviderInstancesWrite) => { sent = request; return reply },
    }))
    await client.load()
    expect(client.current().snapshot?.projects).toEqual([])
    expect(client.current().snapshot?.instances[0]?.defaultModel).toBeNull()
    expect(client.current().snapshot?.configurationVersion).toBeUndefined()
    await client.write({ expectedRevision: 0, change: { kind: 'save', instance: newProviderInstance('codex', 'codex', 'Renamed') } })
    expect(sent).toHaveProperty('change.instance.displayName', 'Renamed')
    expect(sent).not.toHaveProperty('change.instance.defaultModel')
    await client.write({ expectedRevision: 0, change: { kind: 'project', override: { projectRoot: '/repo', enabled: {}, selected: {} } } })
    expect(client.current().error).toBe('Update this host to use project provider overrides.')
  })
  test('a late read cannot overwrite a completed edit', async () => {
    const { api, client } = harness()
    const pending = deferred<ProviderInstancesSnapshot>()
    api.providerInstancesGet = () => pending.promise
    const load = client.load()
    await client.write({ expectedRevision: 0, change: { kind: 'select', instanceId: 'codex' } })
    pending.resolve(snapshot())
    await load
    expect(client.current().snapshot?.revision).toBe(1)
  })
  test('reset removes private account data and refuses an old sign-in response', async () => {
    const { api, client } = harness()
    const pending = deferred<SeatConnectStartResult>()
    api.providerInstanceSignIn = () => pending.promise
    const login = client.signIn('codex')
    client.clear()
    pending.resolve({ verificationUrl: 'https://example.com/private-old-login', requiresCodeInput: false })
    await login
    expect(client.current().verification).toBeNull()
    expect(client.current().statuses.size).toBe(0)
    expect(client.current().action).toBeNull()
  })
  test('concurrent status requests share one request and cannot restore data after reset', async () => {
    const { api, client } = harness()
    const pending = deferred<ProviderInstanceStatus>()
    let calls = 0
    api.providerInstanceStatus = () => { calls++; return pending.promise }
    const first = client.inspect('codex')
    const second = client.inspect('codex')
    expect(calls).toBe(1)
    client.clear()
    pending.resolve({ ...status(), account: 'private-account' })
    await Promise.all([first, second])
    expect(client.current().statuses.size).toBe(0)
  })
  test('zero disables repeated checks and closing the detail page cancels the timer', async () => {
    const { client } = harness()
    let scheduled = 0
    let cancelled = 0
    const schedule = () => { scheduled++; return () => { cancelled++ } }
    const stopDisabled = client.watchStatus('codex', 0, schedule)
    await client.inspect('codex')
    expect(scheduled).toBe(0)
    stopDisabled()
    const stop = client.watchStatus('codex', 300, schedule)
    await client.inspect('codex')
    expect(scheduled).toBe(1)
    stop()
    expect(cancelled).toBe(1)
  })
})
