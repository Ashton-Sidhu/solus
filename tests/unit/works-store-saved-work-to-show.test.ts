import { afterAll, expect, test } from 'bun:test'
import { SvelteRunes } from './helpers/svelte-runes'

// WHY: a document card in the transcript shows the work's saved body, and the
// first card to show it must ask the host for it. The card reads the body from
// its template, where a write to state throws `state_unsafe_mutation`, so the
// read starts through `createSubscriber`. One read per work, however many
// cards show it; a work still streaming has no body to read until it finishes.

const runes = new SvelteRunes()
afterAll(() => runes.dispose())

const file = SvelteRunes.file
const stub = (name: string, source: string) => runes.module(name, source)
const connections = runes.module('server-connections', `
  export const loads = []
  export const serverConnections = {
    defaultServerId: () => 'local',
    connectedServerIds: () => ['local'],
    readinessFor: () => ({ readiness: 'ready' }),
    apiFor: () => ({
      listWorks: async () => [],
      loadWork: async (id) => {
        loads.push(id)
        return { id, organizationId: 'local', title: 'Plan', preview: '', type: 'doc', content: 'body of ' + id, contentVersion: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sessionIds: [], agentProvider: 'claude-code', cwd: '/repo' }
      },
    }),
  }
`)
const emptyStore = 'export class Store { constructor() {} }'
const store = runes.source('works-store', 'packages/workspace-ui/src/contexts/works/works.store.svelte.ts', {
  'svelte/reactivity': file('node_modules/svelte/src/reactivity/index-client.js'),
  '@solus/client-core/server-connections': connections,
  '@solus/client-core/rpc-error': file('packages/client-core/src/rpc-error.ts'),
  '@solus/contracts/uuid': file('packages/contracts/src/uuid.ts'),
  '@solus/contracts/work-preview': file('packages/contracts/src/work-preview.ts'),
  '@solus/contracts/solus-api/client': stub('solus-api-client', 'export class WorkspaceRequestError extends Error {}'),
  './external-comments.store.svelte': stub('external-comments', emptyStore.replace('Store', 'ExternalCommentsStore')),
  './work-history.store.svelte': stub('work-history', emptyStore.replace('Store', 'WorkHistoryStore')),
  './work-reviews.store.svelte': stub('work-reviews', 'export class WorkReviewsStore { loadHost() {} }'),
  './work-live.store.svelte': stub('work-live', emptyStore.replace('Store', 'WorkLiveStore')),
  './open-work.svelte': stub('open-work', 'export class OpenWork {}; export const unavailableReasonOf = () => null'),
  './work-title': file('packages/workspace-ui/src/contexts/works/work-title.ts'),
  './comment-sync': file('packages/workspace-ui/src/contexts/works/comment-sync.ts'),
  '../hosts/hosts.svelte': stub('hosts', 'export const hosts = { hasCollaboration: () => true }'),
  '../connections/organization-selection.store.svelte': stub('organization-selection', 'export const organizationSelection = { activeOrganizationId: null }'),
  '../../lib/organization-filter': file('packages/workspace-ui/src/lib/organization-filter.ts'),
  '../../lib/presence-watch': stub('presence-watch', 'export class PresenceWatch { timings = {} }'),
})
const fixture = runes.module('fixture', `
  import { flushSync } from 'svelte'
  import { WorksStore } from ${JSON.stringify(store)}
  export { loads } from ${JSON.stringify(connections)}
  // Each card reads the body from its template, which is an effect: read it
  // the same way, through a derived, as the card's props are.
  // The store does not know the work's host yet, as after a reload: the
  // read lists the works first, and that writes state.
  export function cards(workId, count, works = new WorksStore()) {
    const shown = []
    const destroy = $effect.root(() => {
      for (let i = 0; i < count; i++) {
        const body = $derived(works.savedWorkToShow(workId)?.content)
        $effect(() => { shown[i] = body })
      }
    })
    flushSync()
    return { works, shown, destroy, flush: flushSync }
  }
`)
const { cards, loads } = await import(fixture) as {
  loads: string[]
  cards(workId: string, count: number, works?: unknown): {
    works: { streaming: Record<string, boolean>; finalizeProvisional(...args: unknown[]): void }
    shown: Array<string | undefined>
    destroy(): void
    flush(): void
  }
}

/** Let the host reads finish, then let the cards render what they brought. */
const settle = async (flush: () => void) => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  flush()
}

test('the cards that show a work read its body once and all show it', async () => {
  const view = cards('work-a', 3)
  await settle(view.flush)
  expect(loads.filter((id) => id === 'work-a')).toHaveLength(1)
  expect(view.shown).toEqual(['body of work-a', 'body of work-a', 'body of work-a'])
  view.destroy()
})

test('a streaming work is read once it finishes, not before', async () => {
  const { WorksStore } = await import(store) as { WorksStore: new () => { streaming: Record<string, boolean> } }
  const works = new WorksStore()
  works.streaming['work-b'] = true
  const view = cards('work-b', 1, works)
  await settle(view.flush)
  expect(loads).not.toContain('work-b')
  expect(view.shown).toEqual([undefined])

  view.works.finalizeProvisional('work-b', 'work-b', 'Plan', 'doc', 'body', 'local')
  view.flush()
  await settle(view.flush)
  expect(loads.filter((id) => id === 'work-b')).toHaveLength(1)
  expect(view.shown).toEqual(['body of work-b'])
  view.destroy()
})
