import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AppShortcutRequest, AppShortcutTarget, AppShortcutView, AppWindowRequest } from '@solus/contracts/app-shortcuts'

// The renderer's mirror of the app shortcuts of this device
// (docs/app-shortcuts.md). What matters: a client with no shell capability
// shows no shortcut command, a launcher takes the app's name and tile, and a
// rename on the host writes the launcher again, once.

declare global {
  var $state: <T>(value: T) => T
}

const originalState = globalThis.$state
beforeEach(() => {
  globalThis.$state = <T>(value: T): T => value
})
afterEach(() => {
  globalThis.$state = originalState
})

const notes: AppShortcutTarget = { host: '0123456789abcdef0123456789abcdef', appId: '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b' }

async function storeWithFakeShell(initial: AppShortcutView[] = []) {
  const { AppShortcutsStore } = await import('@solus/workspace-ui/contexts/apps/app-shortcuts.store.svelte')
  let shortcuts = [...initial]
  const added: AppShortcutRequest[] = []
  const opened: AppWindowRequest[] = []
  const drawn: Array<{ monogram: string; hue: number }> = []
  const store = new AppShortcutsStore(
    {
      appShortcuts: async () => shortcuts,
      addAppShortcut: async (request) => {
        added.push(request)
        shortcuts = [...shortcuts.filter((shortcut) => shortcut.appId !== request.appId), { host: request.host, appId: request.appId, name: request.name }]
      },
      removeAppShortcut: async (target) => {
        shortcuts = shortcuts.filter((shortcut) => shortcut.appId !== target.appId)
      },
      openAppWindow: async (request) => { opened.push(request) },
    },
    async (monogram, hue) => {
      drawn.push({ monogram, hue })
      return new ArrayBuffer(4)
    },
  )
  store.start()
  await Promise.resolve()
  await Promise.resolve()
  return { store, added, opened, drawn }
}

describe('the app shortcuts store', () => {
  // WHY: web and mobile have no launcher. A command that does nothing there is worse than no command.
  test('a client with no shell capability has no shortcuts and offers none', async () => {
    const { AppShortcutsStore } = await import('@solus/workspace-ui/contexts/apps/app-shortcuts.store.svelte')
    const store = new AppShortcutsStore({})
    store.start()
    expect(store.isAvailable).toBe(false)
    expect(store.has(notes)).toBe(false)
  })

  test("a new shortcut takes the app's name and its tile, and the list then has it", async () => {
    const { store, added, drawn } = await storeWithFakeShell()
    expect(store.has(notes)).toBe(false)
    await store.add(notes, { id: notes.appId, name: 'notes', colorHue: 235 })
    expect(added.map(({ host, appId, name }) => ({ host, appId, name }))).toEqual([{ ...notes, name: 'notes' }])
    expect(drawn).toEqual([{ monogram: 'N', hue: 235 }])
    expect(store.has(notes)).toBe(true)
    await store.remove(notes)
    expect(store.has(notes)).toBe(false)
  })

  // WHY: a launcher with the old name of an app is a stale label. An app that was not renamed must not be written again each time it opens.
  test('a rename on the host writes the launcher again, and the same name writes nothing', async () => {
    const { store, added } = await storeWithFakeShell([{ ...notes, name: 'Notes' }])
    await store.followName(notes, { id: notes.appId, name: 'Notes', colorHue: null })
    expect(added).toEqual([])
    await store.followName(notes, { id: notes.appId, name: 'Notebook', colorHue: null })
    expect(added.map((request) => request.name)).toEqual(['Notebook'])
    await store.followName(notes, { id: notes.appId, name: 'Notebook', colorHue: null })
    expect(added).toHaveLength(1)
  })

  test('an app with no shortcut gets none from a rename', async () => {
    const { store, added } = await storeWithFakeShell()
    await store.followName(notes, { id: notes.appId, name: 'Notebook', colorHue: null })
    expect(added).toEqual([])
  })

  test('the app window opens for the app, with its name for the title', async () => {
    const { store, opened } = await storeWithFakeShell()
    await store.openWindow(notes, 'Notes')
    expect(opened).toEqual([{ ...notes, name: 'Notes' }])
  })
})
