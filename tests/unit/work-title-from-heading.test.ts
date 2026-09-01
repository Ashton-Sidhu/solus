import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Work } from '@solus/contracts/types'
import { firstHeadingTitle, isPlaceholderWorkTitle } from '@solus/workspace-ui/contexts/works/work-title'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: connections,
}))

/** The store is a `.svelte.ts` module: outside the compiler, `$state` is an
 *  identity function and `$state.snapshot` a plain read. */
const stateShim = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value })
type RuneHost = typeof globalThis & { $state?: typeof stateShim }
const runeHost: RuneHost = globalThis
const previousState = runeHost.$state

beforeEach(() => {
  connections.reset()
  runeHost.$state = stateShim
})

afterEach(() => {
  connections.reset()
  if (previousState === undefined) delete runeHost.$state
  else runeHost.$state = previousState
})

function work(overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-a',
    title: 'Untitled document',
    content: '',
    preview: '',
    type: 'doc',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: [],
    agentProvider: 'claude-code',
    cwd: '/repo',
    storage: { kind: 'local' },
    ...overrides,
  }
}

type WorkUpdates = Partial<Pick<Work, 'title' | 'preview' | 'content'>>

/** Register a host whose saveWork records what the store asked it to write. */
function hostRecordingSaves() {
  const updates: WorkUpdates[] = []
  connections.registerPrimary('host-a', {
    saveWork: async (workId: string, update: WorkUpdates) => {
      updates.push(update)
      return work({ id: workId, ...update, updatedAt: '2026-01-02T00:00:00.000Z' })
    },
  })
  return { updates }
}

async function storeWith(entry: Work) {
  const { WorksStore } = await import('@solus/workspace-ui/contexts/works/works.store.svelte')
  const store = new WorksStore()
  store.works[entry.id] = entry
  store.rememberHost(entry.id, 'host-a')
  return store
}

describe('first heading', () => {
  test('a level-1 heading names the document, a lower one does not', () => {
    expect(firstHeadingTitle('# Release plan\n\nBody')).toBe('Release plan')
    expect(firstHeadingTitle('## Release plan\n\nBody')).toBeNull()
  })

  test('a heading inside a fenced code block is content, not a name', () => {
    // WHY: a document that opens with a shell snippet would otherwise be named
    // after a comment line in that snippet.
    expect(firstHeadingTitle('```sh\n# install deps\nbun install\n```\n\n# Setup')).toBe('Setup')
  })

  test('a heading the user has only started typing leaves the name alone', () => {
    expect(firstHeadingTitle('# ')).toBeNull()
    expect(firstHeadingTitle('#Notaheading')).toBeNull()
  })

  test('only the birth titles count as unclaimed', () => {
    expect(isPlaceholderWorkTitle('Untitled document')).toBe(true)
    expect(isPlaceholderWorkTitle('Untitled')).toBe(true)
    expect(isPlaceholderWorkTitle('')).toBe(true)
    expect(isPlaceholderWorkTitle('Untitled feature notes')).toBe(false)
  })
})

describe('naming a work from its first heading', () => {
  test('a still-unnamed document takes the heading the user typed', async () => {
    const host = hostRecordingSaves()
    const store = await storeWith(work())

    await store.save('work-a', { content: '# Release plan\n\nBody' })

    expect(host.updates[0].title).toBe('Release plan')
    expect(store.get('work-a')?.title).toBe('Release plan')
  })

  test('a named document keeps its name', async () => {
    // WHY: the title is the user's or the agent's choice once it is set. A
    // heading typed later must not silently rename their document.
    const host = hostRecordingSaves()
    const store = await storeWith(work({ title: 'Release plan' }))

    await store.save('work-a', { content: '# Appendix\n\nBody' })

    expect(host.updates[0].title).toBeUndefined()
    expect(store.get('work-a')?.title).toBe('Release plan')
  })

  test('a diagram is never named from its content', async () => {
    // WHY: diagram content is JSON, so a heading match there is a coincidence.
    const host = hostRecordingSaves()
    const store = await storeWith(work({ title: 'Untitled diagram', type: 'diagram' }))

    await store.save('work-a', { content: '{"nodes":[{"label":"# Release plan"}],"edges":[]}' })

    expect(host.updates[0].title).toBeUndefined()
    expect(store.get('work-a')?.title).toBe('Untitled diagram')
  })

  test('an explicit rename still wins', async () => {
    const host = hostRecordingSaves()
    const store = await storeWith(work({ content: '# Release plan' }))

    await store.save('work-a', { title: 'Q3 launch' })

    expect(host.updates[0].title).toBe('Q3 launch')
    expect(store.get('work-a')?.title).toBe('Q3 launch')
  })
})
