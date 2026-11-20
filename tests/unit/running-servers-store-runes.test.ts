import { afterAll, expect, test } from 'bun:test'
import { SvelteRunes } from './helpers/svelte-runes'
import { singleHostServerConnections } from './helpers/server-connections-mock'
import { runningServer } from './running-server-fixtures'

const runes = new SvelteRunes()
afterAll(() => runes.dispose())
const file = SvelteRunes.file
const storeModule = runes.source('running-servers-store', 'packages/workspace-ui/src/contexts/running-servers/running-servers.store.svelte.ts', {
  'svelte/reactivity': file('node_modules/svelte/src/reactivity/index-client.js'),
  '@solus/client-core/running-servers': file('packages/client-core/src/running-servers.ts'),
  '@solus/client-core/server-connections': runes.module('unused-connections', 'export const serverConnections = null'),
  '@solus/client-core/local-api': runes.module('web-native', 'export const localApi = { getPlatform: () => "web" }'),
})
const observerModule = runes.module('running-servers-observer', `
  export { RunningServersStore } from ${JSON.stringify(storeModule)};
  import { flushSync } from 'svelte';
  export function observe(store) {
    const seen = [];
    const stop = $effect.root(() => {
      $effect(() => { seen.push({ status: store.status, count: store.servers.length, error: store.error }); });
    });
    flushSync();
    return { seen, stop, flush: flushSync };
  }
  export function observeModel(server) {
    const seen = [];
    const stop = $effect.root(() => {
      $effect(() => { seen.push(server.process.name); });
    });
    flushSync();
    return { seen, stop, flush: flushSync };
  }
`)
const { observe, observeModel, RunningServersStore } = await import(observerModule)

async function settle(observer: { flush: () => void }): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  observer.flush()
}

function setup() {
  const connections = singleHostServerConnections()
  connections.registerHost('host-a', {
    runningServersWatch: async () => [runningServer()],
    runningServersCheckoutRoots: async (paths: string[]) => paths.map((path) => ({ path, root: '/project/worktree' })),
    runningServersUnwatch: async () => {},
  })
  return { connections, store: new RunningServersStore('host-a', connections) }
}

test('the Svelte store owns reactive load, list, and disconnect state', async () => {
  const { connections, store } = setup()
  const observer = observe(store)
  const release = store.retainCheckout('/project/worktree/api')
  try {
    await settle(observer)
    expect(observer.seen.at(-1)).toEqual({ status: 'ready', count: 1, error: null })
    expect(store.rows('/project/worktree/api')).toHaveLength(1)
    connections.emitReadiness('host-a', 'unreachable')
    observer.flush()
    expect(observer.seen.at(-1)).toEqual({ status: 'disconnected', count: 0, error: null })
  } finally { release(); observer.stop() }
})

test('a held RunningServers instance updates through runes without replacing its identity', async () => {
  const { connections, store } = setup()
  const observer = observe(store)
  const release = store.retainCheckout('/project/worktree/api')
  let modelObserver: ReturnType<typeof observeModel> | undefined
  try {
    await settle(observer)
    const model = store.servers[0]
    modelObserver = observeModel(model)
    const changed = runningServer()
    changed.process.name = 'API server'
    connections.emit('host-a', 'runningServers.changed', { servers: [changed], error: null })
    observer.flush()
    expect(store.servers[0]).toBe(model)
    expect(modelObserver.seen).toEqual(['node', 'API server'])
    connections.emit('host-a', 'runningServers.changed', { servers: [structuredClone(changed)], error: null })
    observer.flush()
    expect(modelObserver.seen).toEqual(['node', 'API server'])
  } finally { release(); modelObserver?.stop(); observer.stop() }
})
