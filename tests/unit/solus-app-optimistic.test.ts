import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { z } from 'zod'
import { defineApp, mutation, query } from '../../resources/plugins/solus/skills/visual-artifacts/assets/react/src/solus-app-backend'
import { appClient } from '../../resources/plugins/solus/skills/visual-artifacts/assets/react/src/solus-app'

interface Note {
  id: string
  text: string
}

const noteSchema = z.object({ id: z.string(), text: z.string() })

const sampleApp = defineApp({
  name: 'Notes',
  operations: {
    list: query({ input: z.object({ search: z.string(), limit: z.number().optional() }), output: z.array(noteSchema) }, () => []),
    get: query({ input: z.object({ id: z.string() }), output: noteSchema.nullable() }, () => null),
    add: mutation({ input: z.object({ text: z.string() }), output: noteSchema }, () => ({ id: 'real', text: '' })),
    remove: mutation({ input: z.object({ id: z.string() }), output: z.null() }, () => null),
  },
})

const api = appClient<typeof sampleApp>()

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface HostMock {
  calls: Array<{ name: string; args: object }>
  emitDataChanged(): void
  setHandler(handler: (name: string, args: object) => Promise<unknown>): void
  listenerCount(): number
}

function installTestEnv(): { dom: JSDOM; host: HostMock; container: HTMLElement; root: Root; cleanup(): Promise<void> } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const listeners = new Set<(event: string, detail?: unknown) => void>()
  const calls: Array<{ name: string; args: object }> = []
  let handler: (name: string, args: object) => Promise<unknown> = async () => null

  const solusApp = {
    call: (name: string, args: object) => {
      calls.push({ name, args })
      return handler(name, args)
    },
    on: (listener: (event: string, detail?: unknown) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  Object.assign(dom.window, { solusApp })
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
  })

  const container = dom.window.document.getElementById('root')!
  const root = createRoot(container)

  return {
    dom,
    container,
    root,
    host: {
      calls,
      emitDataChanged: () => { for (const listener of [...listeners]) listener('data-changed') },
      setHandler: (next) => { handler = next },
      listenerCount: () => listeners.size,
    },
    cleanup: async () => {
      await act(async () => { root.unmount() })
      dom.window.close()
      Reflect.deleteProperty(globalThis, 'window')
      Reflect.deleteProperty(globalThis, 'document')
      Reflect.deleteProperty(globalThis, 'HTMLElement')
      Reflect.deleteProperty(globalThis, 'Node')
      Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    },
  }
}

describe('@solus/app optimistic mutations and shared query cache', () => {
  let env: ReturnType<typeof installTestEnv>

  beforeEach(() => {
    env = installTestEnv()
  })

  afterEach(async () => {
    await env.cleanup()
    expect(env.host.listenerCount()).toBe(0)
  })

  test('renders optimistic updates immediately across shared and variant queries, avoids flicker, and reconciles on data-changed', async () => {
    // WHY: optimistic mutations must update all mounted views immediately before
    // the backend answers, stay visible while the post-mutation refresh runs,
    // and replace placeholder IDs with the server's rows once data-changed finishes.
    let serverNotes: Note[] = [{ id: 'note-1', text: 'First note' }]
    let pendingAdd: Deferred<Note> | null = null
    let pendingListRefresh: Deferred<Note[]> | null = null

    env.host.setHandler((name, args) => {
      if (name === '@app/list') {
        const search = (args as { search: string }).search.toLowerCase()
        const filtered = serverNotes.filter((note) => note.text.toLowerCase().includes(search))
        if (pendingListRefresh && search === '') return pendingListRefresh.promise
        return Promise.resolve(filtered)
      }
      if (name === '@app/add') {
        pendingAdd = deferred<Note>()
        return pendingAdd.promise
      }
      return Promise.resolve(null)
    })

    function ListView({ label, search }: { label: string; search: string }) {
      const notes = api.useQuery('list', { search })
      return React.createElement(
        'div',
        { 'data-testid': label },
        notes.data ? notes.data.map((note) => `${note.id}:${note.text}`).join('|') : 'loading',
      )
    }

    await act(async () => {
      env.root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(ListView, { label: 'all-a', search: '' }),
          React.createElement(ListView, { label: 'all-b', search: '' }),
          React.createElement(ListView, { label: 'filtered', search: 'milk' }),
        ),
      )
    })

    const textOf = (label: string) => env.container.querySelector(`[data-testid="${label}"]`)?.textContent
    expect(textOf('all-a')).toBe('note-1:First note')
    expect(textOf('all-b')).toBe('note-1:First note')
    expect(textOf('filtered')).toBe('')
    // Shared cache: two mounted components with the same query + input issue only one RPC.
    expect(env.host.calls.filter((call) => call.name === '@app/list')).toHaveLength(2)

    let seenBeforeUpdate: Note[] | undefined
    let mutationPromise!: Promise<Note>
    await act(async () => {
      mutationPromise = api.mutate('add', { text: 'Buy milk' }, {
        optimistic(cache) {
          seenBeforeUpdate = cache.get('list', { search: '' })
          cache.updateAll('list', (notes, input) => {
            if (!notes) return notes
            if (input.search && !'buy milk'.includes(input.search.toLowerCase())) return notes
            return [{ id: 'optimistic-1', text: 'Buy milk' }, ...notes]
          })
        },
      })
    })

    expect(seenBeforeUpdate).toEqual([{ id: 'note-1', text: 'First note' }])
    // Immediate optimistic render across all matching mounted variants.
    expect(textOf('all-a')).toBe('optimistic-1:Buy milk|note-1:First note')
    expect(textOf('all-b')).toBe('optimistic-1:Buy milk|note-1:First note')
    expect(textOf('filtered')).toBe('optimistic-1:Buy milk')

    // Backend resolves the mutation before data-changed refreshes the list: no flicker back to old serverData.
    serverNotes = [{ id: 'note-2', text: 'Buy milk' }, { id: 'note-1', text: 'First note' }]
    pendingListRefresh = deferred<Note[]>()
    await act(async () => {
      pendingAdd!.resolve({ id: 'note-2', text: 'Buy milk' })
      await mutationPromise
    })
    expect(textOf('all-a')).toBe('optimistic-1:Buy milk|note-1:First note')

    // data-changed triggers refresh; optimistic state stays visible while the refresh is in flight.
    await act(async () => {
      env.host.emitDataChanged()
    })
    expect(textOf('all-a')).toBe('optimistic-1:Buy milk|note-1:First note')
    expect(textOf('filtered')).toBe('note-2:Buy milk')

    // Once the refresh finishes, the placeholder ID reconciles cleanly to the real server row.
    await act(async () => {
      pendingListRefresh!.resolve(serverNotes)
      await pendingListRefresh!.promise
    })
    expect(textOf('all-a')).toBe('note-2:Buy milk|note-1:First note')
    expect(textOf('all-b')).toBe('note-2:Buy milk|note-1:First note')
  })

  test('rolls back optimistic updates automatically when the mutation fails', async () => {
    // WHY: a failed write must never leave phantom or deleted rows in mounted queries.
    let pendingRemove: Deferred<null> | null = null
    env.host.setHandler((name) => {
      if (name === '@app/list') return Promise.resolve([{ id: 'note-1', text: 'Keep me' }])
      if (name === '@app/get') return Promise.resolve({ id: 'note-1', text: 'Keep me' })
      if (name === '@app/remove') {
        pendingRemove = deferred<null>()
        return pendingRemove.promise
      }
      return Promise.resolve(null)
    })

    function View() {
      const list = api.useQuery('list', { search: '' })
      const detail = api.useQuery('get', { id: 'note-1' })
      return React.createElement(
        'div',
        null,
        React.createElement('span', { 'data-testid': 'list' }, String(list.data?.length ?? 'loading')),
        React.createElement('span', { 'data-testid': 'detail' }, detail.data === undefined ? 'loading' : detail.data === null ? 'missing' : detail.data.text),
      )
    }

    await act(async () => {
      env.root.render(React.createElement(View))
    })

    expect(env.container.querySelector('[data-testid="list"]')?.textContent).toBe('1')
    expect(env.container.querySelector('[data-testid="detail"]')?.textContent).toBe('Keep me')

    let mutationPromise!: Promise<null>
    await act(async () => {
      mutationPromise = api.mutate('remove', { id: 'note-1' }, {
        optimistic(cache) {
          cache.set('get', { id: 'note-1' }, null)
          cache.update('list', { search: '' }, (notes) => notes?.filter((note) => note.id !== 'note-1'))
        },
      })
    })

    expect(env.container.querySelector('[data-testid="list"]')?.textContent).toBe('0')
    expect(env.container.querySelector('[data-testid="detail"]')?.textContent).toBe('missing')

    let caught: unknown
    await act(async () => {
      pendingRemove!.reject(new Error('Permission denied'))
      await mutationPromise.catch((error: unknown) => { caught = error })
    })

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('Permission denied')
    expect(env.container.querySelector('[data-testid="list"]')?.textContent).toBe('1')
    expect(env.container.querySelector('[data-testid="detail"]')?.textContent).toBe('Keep me')
  })

  test('rolls back only the failed mutation when two optimistic mutations overlap', async () => {
    // WHY: concurrent optimistic updates must layer independently so one failure
    // does not erase another still-in-flight optimistic update.
    let serverNotes: Note[] = [{ id: 'note-1', text: 'Base' }]
    const pendingAdds: Deferred<Note>[] = []

    env.host.setHandler((name) => {
      if (name === '@app/list') return Promise.resolve(serverNotes)
      if (name === '@app/add') {
        const next = deferred<Note>()
        pendingAdds.push(next)
        return next.promise
      }
      return Promise.resolve(null)
    })

    function ListView() {
      const notes = api.useQuery('list', { search: '' })
      return React.createElement('div', { 'data-testid': 'list' }, notes.data?.map((note) => note.id).join(',') ?? 'loading')
    }

    await act(async () => {
      env.root.render(React.createElement(ListView))
    })
    expect(env.container.querySelector('[data-testid="list"]')?.textContent).toBe('note-1')

    let first!: Promise<Note>
    let second!: Promise<Note>
    await act(async () => {
      first = api.mutate('add', { text: 'One' }, {
        optimistic(cache) {
          cache.update('list', { search: '' }, (notes) => [{ id: 'temp-1', text: 'One' }, ...(notes ?? [])])
        },
      })
      second = api.mutate('add', { text: 'Two' }, {
        optimistic(cache) {
          cache.update('list', { search: '' }, (notes) => [{ id: 'temp-2', text: 'Two' }, ...(notes ?? [])])
        },
      })
    })
    expect(env.container.querySelector('[data-testid="list"]')?.textContent).toBe('temp-2,temp-1,note-1')

    // First mutation fails -> only temp-1 rolls back; temp-2 remains visible.
    await act(async () => {
      pendingAdds[0]!.reject(new Error('Conflict'))
      await first.catch(() => undefined)
    })
    expect(env.container.querySelector('[data-testid="list"]')?.textContent).toBe('temp-2,note-1')

    // Second mutation succeeds and data-changed reconciles with the server's list.
    serverNotes = [{ id: 'note-2', text: 'Two' }, { id: 'note-1', text: 'Base' }]
    await act(async () => {
      pendingAdds[1]!.resolve({ id: 'note-2', text: 'Two' })
      await second
      env.host.emitDataChanged()
    })
    expect(env.container.querySelector('[data-testid="list"]')?.textContent).toBe('note-2,note-1')
  })

  test('matches cache keys regardless of input key order and reconciles when data-changed completes before mutate resolves', async () => {
    // WHY: callers may write object keys in any order, and SSE data-changed can
    // complete its refetch before the mutation RPC response arrives.
    let serverNotes: Note[] = [{ id: 'note-1', text: 'Initial' }]
    let pendingAdd: Deferred<Note> | null = null

    env.host.setHandler((name) => {
      if (name === '@app/list') return Promise.resolve(serverNotes)
      if (name === '@app/add') {
        pendingAdd = deferred<Note>()
        return pendingAdd.promise
      }
      return Promise.resolve(null)
    })

    function ListView() {
      const notes = api.useQuery('list', { search: '', limit: 10 })
      return React.createElement('div', { 'data-testid': 'list' }, notes.data?.map((note) => note.id).join(',') ?? 'loading')
    }

    await act(async () => {
      env.root.render(React.createElement(ListView))
    })
    expect(env.container.querySelector('[data-testid="list"]')?.textContent).toBe('note-1')

    let mutationPromise!: Promise<Note>
    await act(async () => {
      mutationPromise = api.mutate('add', { text: 'Second' }, {
        optimistic(cache) {
          const current = cache.get('list', { limit: 10, search: '' })
          expect(current).toEqual([{ id: 'note-1', text: 'Initial' }])
          cache.set('list', { limit: 10, search: '' }, [{ id: 'temp-2', text: 'Second' }, ...(current ?? [])])
        },
      })
    })
    expect(env.container.querySelector('[data-testid="list"]')?.textContent).toBe('temp-2,note-1')

    // data-changed arrives and completes its refetch BEFORE the mutation RPC resolves.
    serverNotes = [{ id: 'note-2', text: 'Second' }, { id: 'note-1', text: 'Initial' }]
    await act(async () => {
      env.host.emitDataChanged()
    })
    await act(async () => {
      pendingAdd!.resolve({ id: 'note-2', text: 'Second' })
      await mutationPromise
    })
    expect(env.container.querySelector('[data-testid="list"]')?.textContent).toBe('note-2,note-1')
  })
})
