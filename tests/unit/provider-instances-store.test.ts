import { afterAll, expect, test } from 'bun:test'
import { SvelteRunes } from './helpers/svelte-runes'
import { singleHostServerConnections } from './helpers/server-connections-mock'
import { newProviderInstance, type ProviderInstancesSnapshot } from '@solus/contracts/provider-instances'

const runes = new SvelteRunes()
afterAll(() => runes.dispose())
const file = SvelteRunes.file
const storeModule = runes.source('provider-instances-store', 'packages/workspace-ui/src/components/settings/provider-instances.store.svelte.ts', {
  'svelte/reactivity': file('node_modules/svelte/src/reactivity/index-client.js'),
  '@solus/client-core/provider-instances': file('packages/client-core/src/provider-instances.ts'),
  '@solus/client-core/server-connections': runes.module('unused-connections', 'export const serverConnections = null'),
})
const observerModule = runes.module('provider-settings-observer', `
  export { ProviderInstancesStore } from ${JSON.stringify(storeModule)};
  import { flushSync } from 'svelte';
  export function observe(store) {
    let seen = [];
    const stop = $effect.root(() => {
      const view = $derived(store.view('host-a'));
      $effect(() => { seen.push(view); });
    });
    flushSync();
    return { seen, stop, flush: flushSync };
  }
`)
const { observe, ProviderInstancesStore } = await import(observerModule)

function snapshot(): ProviderInstancesSnapshot {
  return { projects: [], revision: 0, instances: [newProviderInstance('codex', 'codex', 'Codex')], selected: { codex: 'codex', 'claude-code': 'claude-code' }, healthCheckSeconds: 0, idleCompaction: 'onReturn' }
}

test('the mounted provider page updates when its host finishes the initial read', async () => {
  const connections = singleHostServerConnections()
  const pending = Promise.withResolvers<ProviderInstancesSnapshot>()
  connections.registerHost('host-a', { providerInstancesGet: () => pending.promise })
  const store = new ProviderInstancesStore(connections)
  const observer = observe(store)
  const load = store.client('host-a').load()
  observer.flush()
  expect(observer.seen.at(-1).loading).toBe(true)
  pending.resolve(snapshot())
  await load
  observer.flush()
  expect(observer.seen.at(-1).snapshot?.instances[0]?.displayName).toBe('Codex')
  observer.stop()
})

test('a refused host read appears as an error and Refresh can recover', async () => {
  const connections = singleHostServerConnections()
  let fail = true
  connections.registerHost('host-a', { providerInstancesGet: async () => {
    if (fail) throw new Error('Provider settings are unavailable on this host.')
    return snapshot()
  } })
  const store = new ProviderInstancesStore(connections)
  const observer = observe(store)
  await store.client('host-a').load()
  observer.flush()
  expect(observer.seen.at(-1).error).toBe('Provider settings are unavailable on this host.')
  fail = false
  await store.client('host-a').load()
  observer.flush()
  expect(observer.seen.at(-1).error).toBe('')
  expect(observer.seen.at(-1).snapshot?.instances).toHaveLength(1)
  observer.stop()
})
