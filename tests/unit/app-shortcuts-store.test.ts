import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appShortcutIconKey, type AppShortcutRequest, type AppShortcutTarget, type AppShortcutView, type AppWindowRequest } from '@solus/contracts/app-shortcuts'
import type { AppShortcutIconSource } from '@solus/workspace-ui/contexts/apps/app-shortcut-icon'

// The renderer's mirror of the app shortcuts of this device
// (docs/app-shortcuts.md). What matters: a client with no shell capability
// shows no shortcut command, a launcher takes the app's name and its icon (its
// own icon.svg, else its tile), when the app opens a launcher with an old
// name, an old icon, or an old format is written again, once, and each surface
// sees the change that runs, so a second click does not run it twice.

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
const SERVER = 'server-1'
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>'

function app(name: string, overrides: { colorHue?: number | null; iconHash?: string | null } = {}) {
  return { id: notes.appId, name, colorHue: overrides.colorHue ?? 235, iconHash: overrides.iconHash ?? null }
}

/** A shortcut as the main process lists it after it wrote the launcher of `request`. */
function viewOf(request: Pick<AppShortcutRequest, 'host' | 'appId' | 'name' | 'iconKey'>, isOutdated = false): AppShortcutView {
  return { host: request.host, appId: request.appId, name: request.name, iconKey: request.iconKey, isOutdated }
}

/** A listed shortcut whose launcher is current. */
function shortcutOf(target: AppShortcutTarget, name: string): AppShortcutView {
  return { ...target, name, iconKey: '', isOutdated: false }
}

const noIcons = { svgFor: async () => null }

async function storeWithFakeShell(initial: AppShortcutView[] = [], icons: { [hash: string]: string } = {}) {
  const { AppShortcutsStore } = await import('@solus/workspace-ui/contexts/apps/app-shortcuts.store.svelte')
  let shortcuts = [...initial]
  const added: AppShortcutRequest[] = []
  const opened: AppWindowRequest[] = []
  const drawn: AppShortcutIconSource[] = []
  const store = new AppShortcutsStore(
    {
      appShortcuts: async () => shortcuts,
      addAppShortcut: async (request) => {
        added.push(request)
        shortcuts = [...shortcuts.filter((shortcut) => shortcut.appId !== request.appId), viewOf(request)]
      },
      removeAppShortcut: async (target) => {
        shortcuts = shortcuts.filter((shortcut) => shortcut.appId !== target.appId)
      },
      openAppWindow: async (request) => { opened.push(request) },
    },
    async (source) => {
      drawn.push(source)
      return new ArrayBuffer(4)
    },
    { svgFor: async (_serverId, { iconHash }) => (iconHash ? icons[iconHash] ?? null : null) },
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
    await store.add(notes, SERVER, app('notes'))
    expect(added.map(({ host, appId, name, iconKey }) => ({ host, appId, name, iconKey }))).toEqual([{ ...notes, name: 'notes', iconKey: 'monogram:N:235' }])
    expect(drawn).toEqual([{ monogram: 'N', hue: 235, svg: null }])
    expect(store.has(notes)).toBe(true)
    await store.remove(notes)
    expect(store.has(notes)).toBe(false)
  })

  // WHY: an app's own icon is what the person knows it by. The launcher must show it, not the letter.
  test("an app with an icon.svg gets a launcher drawn from it, keyed by the icon's hash", async () => {
    const { store, added, drawn } = await storeWithFakeShell([], { abc: ICON })
    await store.add(notes, SERVER, app('Notes', { iconHash: 'abc' }))
    expect(drawn).toEqual([{ monogram: 'N', hue: 235, svg: ICON }])
    expect(added.map((request) => request.iconKey)).toEqual(['svg:abc'])
  })

  // WHY: an icon that did not arrive must not be recorded as drawn, or the launcher keeps the letter for good.
  test('an icon that cannot be read gives the tile and the key of the tile, so the next open tries again', async () => {
    const { store, added, drawn } = await storeWithFakeShell()
    await store.add(notes, SERVER, app('Notes', { iconHash: 'missing' }))
    expect(drawn).toEqual([{ monogram: 'N', hue: 235, svg: null }])
    expect(added.map((request) => request.iconKey)).toEqual(['monogram:N:235'])
    await store.follow(notes, SERVER, app('Notes', { iconHash: 'missing' }))
    expect(added).toHaveLength(2)
  })

  // WHY: a launcher with the old name of an app is a stale label. An app that was not renamed must not be written again each time it opens.
  test('a rename on the host writes the launcher again, and the same name writes nothing', async () => {
    const { store, added } = await storeWithFakeShell([viewOf({ ...notes, name: 'Notes', iconKey: 'monogram:N:235' })])
    await store.follow(notes, SERVER, app('Notes'))
    expect(added).toEqual([])
    await store.follow(notes, SERVER, app('Notebook'))
    expect(added.map((request) => request.name)).toEqual(['Notebook'])
    await store.follow(notes, SERVER, app('Notebook'))
    expect(added).toHaveLength(1)
  })

  // WHY: docs/app-shortcuts.md §7 named this gap: the launcher followed a rename but kept an old colour or an old icon.
  test('a new colour, a new icon.svg, and a removed icon each write the launcher again, once', async () => {
    const { store, added } = await storeWithFakeShell([viewOf({ ...notes, name: 'Notes', iconKey: 'monogram:N:235' })], { one: ICON, two: ICON.replace('8"/>', '7"/>') })
    await store.follow(notes, SERVER, app('Notes', { colorHue: 25 }))
    await store.follow(notes, SERVER, app('Notes', { colorHue: 25 }))
    expect(added.map((request) => request.iconKey)).toEqual(['monogram:N:25'])
    await store.follow(notes, SERVER, app('Notes', { colorHue: 25, iconHash: 'one' }))
    await store.follow(notes, SERVER, app('Notes', { colorHue: 25, iconHash: 'one' }))
    // A colour changes only the monogram: with an icon, it writes nothing.
    await store.follow(notes, SERVER, app('Notes', { colorHue: 145, iconHash: 'one' }))
    await store.follow(notes, SERVER, app('Notes', { colorHue: 145, iconHash: 'two' }))
    await store.follow(notes, SERVER, app('Notes', { colorHue: 145 }))
    expect(added.map((request) => request.iconKey)).toEqual(['monogram:N:25', 'svg:one', 'svg:two', 'monogram:N:145'])
  })

  // WHY: a launcher of an older format (or a record from before the icon key) must not wait for a change of the app to be fixed.
  test('a launcher of an older format, or with no icon key, is written again when the app opens', async () => {
    const key = appShortcutIconKey({ iconHash: null, monogram: 'N', hue: 235 })
    const { store, added } = await storeWithFakeShell([viewOf({ ...notes, name: 'Notes', iconKey: key }, true)])
    await store.follow(notes, SERVER, app('Notes'))
    expect(added).toHaveLength(1)
    await store.follow(notes, SERVER, app('Notes'))
    expect(added).toHaveLength(1)

    const old = await storeWithFakeShell([viewOf({ ...notes, name: 'Notes', iconKey: '' })])
    await old.store.follow(notes, SERVER, app('Notes'))
    expect(old.added).toHaveLength(1)
  })

  test('an app with no shortcut gets none from a change', async () => {
    const { store, added } = await storeWithFakeShell()
    await store.follow(notes, SERVER, app('Notebook', { iconHash: 'abc' }))
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
      appShortcuts: async () => added.map((request) => viewOf(request)),
      addAppShortcut: (request) => {
        added.push(request)
        return new Promise<void>((resolve) => { finish = resolve })
      },
    }, async () => new ArrayBuffer(4), noIcons)
    const first = store.add(notes, SERVER, app('Notes'))
    expect(store.changeFor(notes)).toBe('adding')
    await store.add(notes, SERVER, app('Notes'))
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
    }, async () => new ArrayBuffer(4), noIcons)
    await expect(store.add(notes, SERVER, app('Notes'))).rejects.toThrow('Other files hold')
    expect(store.changeFor(notes)).toBeNull()
  })

  test('a removal answers where the launcher went', async () => {
    const { AppShortcutsStore } = await import('@solus/workspace-ui/contexts/apps/app-shortcuts.store.svelte')
    let shortcuts: AppShortcutView[] = [shortcutOf(notes, 'Notes')]
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
    const tasks = shortcutOf({ host: notes.host, appId: '11111111-2222-4333-8444-555555555555' }, 'Tasks')
    const journal = shortcutOf({ host: otherHost, appId: '22222222-3333-4444-8555-666666666666' }, 'Journal')
    let shortcuts: AppShortcutView[] = [shortcutOf(notes, 'Notes'), tasks, journal]
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
    expect(result.kept).toEqual([{ shortcut: shortcutOf(notes, 'Notes'), launcherPath: '/Apps/Notes.app' }])
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
        return [shortcutOf(notes, 'Notes')]
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
