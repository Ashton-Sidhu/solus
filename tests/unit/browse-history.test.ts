import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const previousState = (globalThis as unknown as { $state?: unknown }).$state
type HistoryModule = typeof import('@solus/workspace-ui/components/pickers/lib/browse-history.svelte')
let BrowseHistory: HistoryModule['BrowseHistory']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ BrowseHistory } = await import('@solus/workspace-ui/components/pickers/lib/browse-history.svelte'))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function historyAt(...directories: string[]) {
  const history = new BrowseHistory()
  history.reset(directories[0])
  for (const directory of directories.slice(1)) history.visit(directory)
  return history
}

describe('BrowseHistory', () => {
  test('a new session has nowhere to go back or forward to', () => {
    const history = historyAt('~/projects/')
    expect(history.canGoBack).toBe(false)
    expect(history.canGoForward).toBe(false)
    expect(history.back()).toBeNull()
    expect(history.forward()).toBeNull()
  })

  test('Back returns through the folders in the order they were shown, and Forward undoes it', () => {
    const history = historyAt('~/projects/', '~/projects/site/', '~/Downloads/')
    expect(history.back()).toBe('~/projects/site/')
    expect(history.back()).toBe('~/projects/')
    expect(history.canGoBack).toBe(false)
    expect(history.forward()).toBe('~/projects/site/')
    expect(history.forward()).toBe('~/Downloads/')
    expect(history.canGoForward).toBe(false)
  })

  // Typing a filter changes the path but not the folder; each keystroke must
  // not become a Back step.
  test('a visit to the folder already shown adds no step', () => {
    const history = historyAt('~/projects/', '~/projects/', '~/projects/')
    expect(history.canGoBack).toBe(false)
  })

  // The same rule as a web browser: a new place after Back replaces the
  // folders that were ahead.
  test('a new visit after Back drops the folders ahead', () => {
    const history = historyAt('~/', '~/projects/', '~/projects/site/')
    history.back()
    history.visit('~/Downloads/')
    expect(history.canGoForward).toBe(false)
    expect(history.back()).toBe('~/projects/')
  })

  test('reset starts again with nothing behind it', () => {
    const history = historyAt('~/', '~/projects/')
    history.reset('/srv/')
    expect(history.canGoBack).toBe(false)
    expect(history.canGoForward).toBe(false)
  })
})
