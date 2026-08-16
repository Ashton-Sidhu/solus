import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { SavedPrompt } from '../../src/shared/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()

mock.module('@client-core/server-connections', () => ({ serverConnections: connections }))

const previousStateDescriptor = Object.getOwnPropertyDescriptor(globalThis, '$state')
let SavedPromptsStore: typeof import('../../src/renderer/contexts/saved-prompts/saved-prompts.store.svelte')['SavedPromptsStore']

beforeAll(async () => {
  Object.defineProperty(globalThis, '$state', {
    configurable: true,
    writable: true,
    value: Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value }),
  })
  ;({ SavedPromptsStore } = await import('../../src/renderer/contexts/saved-prompts/saved-prompts.store.svelte'))
})

beforeEach(() => connections.reset())

afterAll(() => {
  if (previousStateDescriptor) Object.defineProperty(globalThis, '$state', previousStateDescriptor)
  else Reflect.deleteProperty(globalThis, '$state')
})

function prompt(id: string, text: string): SavedPrompt {
  return {
    id,
    projectRoot: '/same/project',
    text,
    attachments: [],
    createdAt: 1,
  }
}

describe('SavedPromptsStore host routing', () => {
  test('keeps the same project path separate on each host', async () => {
    connections.registerPrimary('host-a', {
      savedPromptsList: async () => [prompt('a', 'From A')],
    })
    connections.registerHost('host-b', {
      savedPromptsList: async () => [prompt('b', 'From B')],
    })
    const store = new SavedPromptsStore()

    await Promise.all([
      store.load('/same/project', 'host-a'),
      store.load('/same/project', 'host-b'),
    ])

    // WHY: project paths are not identities across machines. Each composer must
    // read the saved prompts from the host that owns its run.
    expect(store.forProject('/same/project', 'host-a').map((item) => item.id)).toEqual(['a'])
    expect(store.forProject('/same/project', 'host-b').map((item) => item.id)).toEqual(['b'])
  })

  test('routes create and delete through the selected host', async () => {
    const writes: string[] = []
    connections.registerPrimary('host-a', {
      savedPromptsCreate: async () => {
        writes.push('create-a')
        return []
      },
      savedPromptsDelete: async () => {
        writes.push('delete-a')
        return []
      },
    })
    connections.registerHost('host-b', {
      savedPromptsCreate: async (item: SavedPrompt) => {
        writes.push('create-b')
        return [item]
      },
      savedPromptsDelete: async () => {
        writes.push('delete-b')
        return []
      },
    })
    const store = new SavedPromptsStore()

    await store.create(prompt('remote', 'Remote'), 'host-b')
    await store.remove('/same/project', 'remote', 'host-b')

    expect(writes).toEqual(['create-b', 'delete-b'])
  })
})
