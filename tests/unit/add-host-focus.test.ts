import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', dismiss: () => {} }) }))

// The store reads the window, the document, and runes as it loads.
const noop = () => {}
const GLOBALS = ['localStorage', 'window', 'document', '$state'] as const
const previous = GLOBALS.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
afterAll(() => GLOBALS.forEach((name, index) => {
  const descriptor = previous[index]
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  else Reflect.deleteProperty(globalThis, name)
}))
const memory = new Map<string, string>()
Object.assign(globalThis, {
  localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) },
  window: { dispatchEvent: () => true, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }) },
  document: { documentElement: { classList: { toggle: noop } }, addEventListener: noop, removeEventListener: noop, visibilityState: 'visible', hasFocus: () => true },
  $state: <T>(value: T) => value,
})

const { serversStore } = await import('@solus/workspace-ui/contexts/connections/servers.store.svelte')

afterEach(() => serversStore.closeAddServer())

// The opener that knows the way (an SSH config entry, a host to pair again) opens
// the Add host dialog on that one tab, so the person is not asked to choose among
// ways that do not apply. A plain Add host shows them all.
describe('Add host dialog focus', () => {
  test('an opener that names a tab focuses the dialog on it', () => {
    serversStore.openAddServer('', 'ssh')
    expect(serversStore.addServerMode).toBe('ssh')
    expect(serversStore.addServerFocusedTab).toBe('ssh')
  })

  test('an address to pair again focuses the address tab, filled in', () => {
    serversStore.openAddServer('http://10.0.0.4:3000')
    expect(serversStore.addServerMode).toBe('address')
    expect(serversStore.addServerFocusedTab).toBe('address')
    expect(serversStore.addServerUrl).toBe('http://10.0.0.4:3000')
  })

  test('a plain open shows every tab', () => {
    serversStore.openAddServer()
    expect(serversStore.addServerMode).toBe('address')
    expect(serversStore.addServerFocusedTab).toBeNull()
  })

  test('closing forgets the focus, so the next plain open shows every tab', () => {
    serversStore.openAddServer('', 'ssh')
    serversStore.closeAddServer()
    serversStore.openAddServer()
    expect(serversStore.addServerFocusedTab).toBeNull()
  })
})
