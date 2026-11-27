import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AppPermissionChange, AppPermissionsView } from '@solus/contracts/app-desktop'
import { appPermissionRows, appPermissionsSummary } from '@solus/workspace-ui/components/settings/lib/app-permissions'

// The renderer's mirror of the answers of this device for the desktop
// capabilities of each app (docs/plans/app-desktop-capabilities.md §2). What
// matters: web and mobile show no section, a change from an app window's menu
// reaches Settings, and an older read never puts back an older list.

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

const prompts: AppPermissionsView['permissions'] = {
  menuBar: 'prompt', shortcuts: 'prompt', floating: 'prompt', startAtLogin: 'prompt',
  microphone: 'prompt', camera: 'prompt', clipboardRead: 'prompt', notifications: 'prompt',
}
const notes: AppPermissionsView = { host: '0123456789abcdef0123456789abcdef', appId: '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b', name: 'Notes', permissions: { ...prompts, shortcuts: 'granted', camera: 'denied' } }

describe('the app permissions store', () => {
  test('a client with no desktop app has no section', async () => {
    const { AppPermissionsStore } = await import('@solus/workspace-ui/contexts/apps/app-permissions.store.svelte')
    expect(new AppPermissionsStore({}).isAvailable).toBe(false)
  })

  test('follows a change from elsewhere, and keeps only the newest read', async () => {
    const { AppPermissionsStore } = await import('@solus/workspace-ui/contexts/apps/app-permissions.store.svelte')
    let onChanged = () => {}
    const reads: ((apps: AppPermissionsView[]) => void)[] = []
    const changes: AppPermissionChange[] = []
    const store = new AppPermissionsStore({
      appPermissions: () => new Promise((resolve) => reads.push(resolve)),
      setAppPermission: async (change) => { changes.push(change) },
      onAppPermissionsChanged: (callback) => { onChanged = callback; return () => {} },
    })
    store.start()
    onChanged()
    // The second read answers first; the first, older one answers last.
    reads[1]([notes])
    await Bun.sleep(0)
    reads[0]([])
    await Bun.sleep(0)
    expect(store.apps).toEqual([notes])

    const change = store.change({ host: notes.host, appId: notes.appId, permission: 'camera', state: 'prompt' })
    await Bun.sleep(0)
    reads[2]([])
    await change
    expect(changes).toEqual([{ host: notes.host, appId: notes.appId, permission: 'camera', state: 'prompt' }])
    expect(store.apps).toEqual([])
  })
})

describe('the rows of one app in Settings', () => {
  test('name each permission for the operating system, with its answer', () => {
    const rows = appPermissionRows(notes, 'win32')
    expect(rows[0]).toEqual({ permission: 'menuBar', label: 'Tray icon', choice: 'prompt' })
    expect(appPermissionRows(notes, 'darwin')[0].label).toBe('Menu bar item')
    expect(appPermissionsSummary(notes, 'darwin')).toBe('Keyboard shortcuts')
    expect(appPermissionsSummary({ ...notes, permissions: prompts }, 'darwin')).toBe('Nothing allowed')
  })
})
