import { describe, expect, test } from 'bun:test'
import { SolusApp } from '../../apps/mobile/src/app/solus-app'
import { initialRoutes } from '../../apps/mobile/src/app/initial-route'
import { cloudHostsFor, cloudHostState } from '../../apps/mobile/src/features/account/lib/host-scope'
import type { NativeHost } from '../../apps/mobile/src/features/hosts/host-registry'
import { memoryKeyValueStore, memorySecretStore } from '../../apps/mobile/src/platform/ports'
import type { ConversationStore } from '../../apps/mobile/src/features/conversation/conversation-store'
import { FakeApi, FakeTransport } from './helpers/native-mobile-fakes'

/** Resolves when the conversation's watch has answered. */
function untilReady(store: ConversationStore): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (store.controller.phase.kind !== 'ready') return
      stop()
      resolve()
    }
    const stop = store.meta.subscribe(check)
    check()
  })
}

function pairFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/pair')) return new Response(JSON.stringify({ sessionToken: 'tok', installationId: 'inst-a', os: 'macos' }), { status: 200 })
    if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true, installationId: 'inst-a', name: 'Studio Mac' }), { status: 200 })
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

function createApp(storage = memoryKeyValueStore(), secrets = memorySecretStore()) {
  const api = new FakeApi()
    .on('configGet', () => ({ config: { extraInstructions: '', modelInstructions: {}, defaultPermissionMode: 'supervised' }, seeded: true }))
    .on('watchSession', (input: { sessionId: string }) => ({ sessionId: input.sessionId }))
    .on('unwatchSession', () => undefined)
  const transports: FakeTransport[] = []
  const app = new SolusApp({
    storage,
    secrets,
    fetch: pairFetch(),
    createTransport: (options) => {
      const transport = new FakeTransport(options, api)
      transports.push(transport)
      return transport
    },
    openBrowser: async () => {},
    deviceLabel: 'Solus for iPhone',
    uuid: () => 'uuid-1',
  })
  return { app, storage, secrets, transports, api }
}

describe('native app composition', () => {
  test('pairing names the device and saves the host without replacing others', async () => {
    const { app } = createApp()
    await app.load()
    await app.registry.savePaired({ id: 'inst-other', label: 'Other', url: 'http://o:1' }, 'o')
    const host = await app.pair({ url: 'http://10.0.0.8:3000', name: 'Studio Mac' }, 'ABC123')
    expect(host.id).toBe('inst-a')
    expect(host.label).toBe('Studio Mac')
    expect(app.registry.hosts().map((entry) => entry.id)).toEqual(['inst-other', 'inst-a'])
  })

  test('forgetting a host removes its queued prompts, drafts, open conversations, and last route', async () => {
    const { app, storage, api } = createApp()
    await app.load()
    await app.pair({ url: 'http://10.0.0.8:3000' }, 'ABC123')
    const store = app.conversation('inst-a', { newSession: { sessionId: 's1', provider: 'claude-code', workingDirectory: '/w' } })!
    await untilReady(store)
    app.saveDraft('inst-a', 's1', 'half a thought')
    storage.setItem('solus.sendOutbox.v1.inst-a/s1', '[]')
    app.rememberRoute({ hostId: 'inst-a', projectPath: '/w' })
    expect(app.lastRoute()).not.toBeNull()

    await app.registry.forget('inst-a')
    expect(storage.keys().filter((key) => key.includes('inst-a'))).toEqual([])
    expect(app.lastRoute()).toBeNull()
    expect(api.callsOf('unwatchSession')).toEqual([['s1']])
    expect(store.controller.phase.kind).toBe('ready')
  })

  test('a new conversation starts from the person\'s own defaults, not the host\'s config', async () => {
    // createApp's host answers configGet with 'supervised'; the person chose 'plan' on this device.
    const { app, api } = createApp()
    await app.load()
    app.personal.set({ defaultPermissionMode: 'plan' })
    await app.pair({ url: 'http://10.0.0.8:3000' }, 'ABC123')
    const store = app.conversation('inst-a', { newSession: { sessionId: 's2', provider: 'codex', workingDirectory: '/w' } })!
    await untilReady(store)
    expect(store.controller.run).toMatchObject({ preferredModel: 'gpt-6-astra', permissionMode: 'plan' })
    expect(api.callsOf('configGet')).toEqual([])
  })

  test('a returning launch reopens the last conversation once its host is loaded', async () => {
    const storage = memoryKeyValueStore()
    const secrets = memorySecretStore()
    const first = createApp(storage, secrets)
    await first.app.load()
    await first.app.pair({ url: 'http://10.0.0.8:3000' }, 'ABC123')
    const record = { sessionId: 't1', provider: 'codex' as const, projectPath: '/w', cwd: '/w', model: null, reasoningEffort: null, title: 'Fix', customTitle: null }
    first.app.rememberRoute({ hostId: 'inst-a', projectPath: '/w', record })

    const second = createApp(storage, secrets)
    // Before the load barrier the host is unknown, so nothing is restored.
    expect(second.app.registry.hosts()).toEqual([])
    await second.app.load()
    const lastRoute = second.app.lastRoute()
    expect(lastRoute?.record?.sessionId).toBe('t1')
    expect(initialRoutes({ hasHosts: true, isSignedIn: false, lastRoute, compact: true }).map((route) => route.name))
      .toEqual(['Hosts', 'Projects', 'Workspace', 'Conversation'])
    expect(initialRoutes({ hasHosts: true, isSignedIn: false, lastRoute, compact: false }).at(-1))
      .toEqual({ name: 'Workspace', params: { hostId: 'inst-a', projectPath: '/w', selected: { record } } })
  })

  test('first launch offers the two ways in; a signed-in account with no host goes to its hosts', () => {
    expect(initialRoutes({ hasHosts: false, isSignedIn: false, lastRoute: null, compact: true })).toEqual([{ name: 'Welcome' }])
    expect(initialRoutes({ hasHosts: false, isSignedIn: true, lastRoute: null, compact: true }).map((route) => route.name)).toEqual(['Hosts', 'CloudHosts'])
  })
})

describe('organization view of cloud hosts', () => {
  const cloudHost = (id: string, organizationIds: string[], extra: Partial<NativeHost['uplink']> = {}): NativeHost => ({
    id, label: id, routes: [{ kind: 'tunnel', url: `https://${id}` }], lastConnected: 0, paired: false,
    uplink: { hostId: id, directoryUrl: 'https://app.solus.sh', organizationIds, ...extra },
  })

  test('shows the selected organization\'s hosts and the person\'s own, never another organization\'s', () => {
    const hosts = [cloudHost('own', []), cloudHost('acme', ['org-acme']), cloudHost('other', ['org-other']), { ...cloudHost('paired', []), uplink: undefined, paired: true }]
    expect(cloudHostsFor(hosts, 'org-acme').map((host) => host.id)).toEqual(['own', 'acme'])
  })

  test('a stopped managed host offers start; a starting one waits', () => {
    expect(cloudHostState(cloudHost('m', ['o'], { kind: 'managed', managedState: 'stopped' }))).toBe('stopped')
    expect(cloudHostState(cloudHost('m', ['o'], { kind: 'managed', managedState: 'provisioning' }))).toBe('starting')
    expect(cloudHostState(cloudHost('m', ['o'], { kind: 'managed', managedState: 'ready' }))).toBe('ready')
  })
})
