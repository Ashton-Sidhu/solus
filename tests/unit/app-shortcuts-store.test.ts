import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AppShortcutRequest, AppShortcutTarget, AppShortcutView, AppWindowRequest } from '@solus/contracts/app-shortcuts'

// The renderer's mirror of the app shortcuts of this device
// (docs/app-shortcuts.md). What matters: a client with no shell capability
// shows no shortcut command, a launcher takes the app's name and tile, a
// rename on the host writes the launcher again, once, and each surface sees the
// change that runs, so a second click does not run it twice.

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

  // WHY: the menu shows "Adding shortcut…" from this state, and a second click while it runs must not write a second launcher.
  test('while a shortcut is written, every surface sees it and a second add does nothing', async () => {
    const { AppShortcutsStore } = await import('@solus/workspace-ui/contexts/apps/app-shortcuts.store.svelte')
    let finish = () => {}
    const added: AppShortcutRequest[] = []
    const store = new AppShortcutsStore({
      appShortcuts: async () => added.map(({ host, appId, name }) => ({ host, appId, name })),
      addAppShortcut: (request) => {
        added.push(request)
        return new Promise<void>((resolve) => { finish = resolve })
      },
    }, async () => new ArrayBuffer(4))
    const app = { id: notes.appId, name: 'Notes', colorHue: null }
    const first = store.add(notes, app)
    expect(store.changeFor(notes)).toBe('adding')
    await store.add(notes, app)
    await Promise.resolve()
    finish()
    await first
    expect(added).toHaveLength(1)
    expect(store.changeFor(notes)).toBeNull()
    expect(store.has(notes)).toBe(true)
  })

  test('a failed add leaves no change running, so the person can try again', async () => {
    const { AppShortcutsStore } = await import('@solus/workspace-ui/contexts/apps/app-shortcuts.store.svelte')
    const store = new AppShortcutsStore({
      appShortcuts: async () => [],
      addAppShortcut: async () => { throw new Error('Other files hold every name this shortcut can have.') },
    }, async () => new ArrayBuffer(4))
    await expect(store.add(notes, { id: notes.appId, name: 'Notes', colorHue: null })).rejects.toThrow('Other files hold')
    expect(store.changeFor(notes)).toBeNull()
  })

  test('a removal answers where the launcher went', async () => {
    const { AppShortcutsStore } = await import('@solus/workspace-ui/contexts/apps/app-shortcuts.store.svelte')
    let shortcuts: AppShortcutView[] = [{ ...notes, name: 'Notes' }]
    const store = new AppShortcutsStore({
      appShortcuts: async () => shortcuts,
      removeAppShortcut: async () => {
        shortcuts = []
        return { launcher: 'trashed' }
      },
    })
    await store.loaded()
    expect(await store.remove(notes)).toEqual({ launcher: 'trashed' })
    expect(store.has(notes)).toBe(false)
  })

  // WHY: "Remove all" and the offer after a host removal remove many. One that fails must not keep the others, and the result names it for "Try again".
  test('a removal of several shortcuts goes on past a failure and names it', async () => {
    const { AppShortcutsStore } = await import('@solus/workspace-ui/contexts/apps/app-shortcuts.store.svelte')
    const otherHost = '89abcdef0123456789abcdef01234567'
    const tasks = { host: notes.host, appId: '11111111-2222-4333-8444-555555555555', name: 'Tasks' }
    const journal = { host: otherHost, appId: '22222222-3333-4444-8555-666666666666', name: 'Journal' }
    let shortcuts: AppShortcutView[] = [{ ...notes, name: 'Notes' }, tasks, journal]
    let reads = 0
    const store = new AppShortcutsStore({
      appShortcuts: async () => {
        reads += 1
        return shortcuts
      },
      removeAppShortcut: async (target) => {
        if (target.appId === tasks.appId) throw new Error('The launcher is open in another program.')
        shortcuts = shortcuts.filter((shortcut) => shortcut.appId !== target.appId)
        return target.appId === notes.appId ? { launcher: 'kept', launcherPath: '/Apps/Notes.app' } : { launcher: 'trashed' }
      },
    })
    await store.loaded()
    expect(store.ofHost(notes.host).map((shortcut) => shortcut.name)).toEqual(['Notes', 'Tasks'])
    const readsBefore = reads
    const result = await store.removeMany(store.list)
    expect(result.removed.map((shortcut) => shortcut.name)).toEqual(['Notes', 'Journal'])
    expect(result.kept).toEqual([{ shortcut: { ...notes, name: 'Notes' }, launcherPath: '/Apps/Notes.app' }])
    expect(result.failed).toEqual([{ shortcut: tasks, message: 'The launcher is open in another program.' }])
    expect(reads - readsBefore).toBe(1)
    expect(store.list).toEqual([tasks])
  })

  // WHY: an empty list after a failed read is not "no shortcuts". Settings shows the error and "Check again" instead of a count.
  test('a failed read is an error, not an empty list, until a read succeeds', async () => {
    const { AppShortcutsStore } = await import('@solus/workspace-ui/contexts/apps/app-shortcuts.store.svelte')
    let fails = true
    const store = new AppShortcutsStore({
      appShortcuts: async () => {
        if (fails) throw new Error('The desktop app did not answer.')
        return [{ ...notes, name: 'Notes' }]
      },
    })
    await store.loaded()
    expect(store.listError).toBe('The desktop app did not answer.')
    fails = false
    await store.checkAgain()
    expect(store.listError).toBeNull()
    expect(store.has(notes)).toBe(true)
  })
})
