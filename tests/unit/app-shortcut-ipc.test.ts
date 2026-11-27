import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppShortcutRemoval, AppShortcutTarget } from '@solus/contracts/app-shortcuts'
import type { AppLaunchers } from '@solus/desktop-main/app-shortcuts/launchers'

// The remove command of the app shortcuts (docs/app-shortcuts.md §4). What
// matters: the person asked for no shortcut, so the record goes even when the
// Trash refuses the launcher, and the answer says where the launcher stays.

type Handler = (event: null, request: AppShortcutTarget) => Promise<AppShortcutRemoval>
const handlers = new Map<string, Handler>()
mock.module('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  nativeImage: {},
}))

const { forgetApp, registerAppShortcutIpc } = await import('@solus/desktop-main/app-shortcuts/ipc')
const { AppShortcutRecords } = await import('@solus/desktop-main/app-shortcuts/app-shortcut-records')

const notes = { host: '0123456789abcdef0123456789abcdef', appId: '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b' }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'solus-app-shortcut-ipc-'))
  handlers.clear()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function register(removal: AppShortcutRemoval) {
  const records = new AppShortcutRecords(join(dir, 'app-shortcuts.json'))
  records.save({ ...notes, name: 'Notes', launcherPath: '/Users/sam/Applications/Solus Apps/Notes.app' })
  const removed: string[] = []
  const launchers: AppLaunchers = {
    write: async () => '',
    remove: async (_target, path) => {
      removed.push(path)
      return removal
    },
    forget: async () => {},
    windowIdentity: () => ({ iconPath: null, taskbar: null }),
  }
  registerAppShortcutIpc({ records, launchers, windows: { open: () => {} } as never })
  const remove = handlers.get('solus:app-shortcut-remove')
  if (!remove) throw new Error('the remove command did not register')
  return { records, removed, remove: (target: AppShortcutTarget) => remove(null, target) }
}

describe('the remove command', () => {
  test('the launcher of the record goes to the adapter, and the record goes', async () => {
    const { records, removed, remove } = register({ launcher: 'trashed' })
    expect(await remove(notes)).toEqual({ launcher: 'trashed' })
    expect(removed).toEqual(['/Users/sam/Applications/Solus Apps/Notes.app'])
    expect(records.find(notes)).toBeNull()
  })

  test('a Trash that refuses the launcher does not keep the record, and the answer names the launcher', async () => {
    const { records, remove } = register({ launcher: 'kept', launcherPath: '/Users/sam/Applications/Solus Apps/Notes.app' })
    expect(await remove(notes)).toEqual({ launcher: 'kept', launcherPath: '/Users/sam/Applications/Solus Apps/Notes.app' })
    expect(records.find(notes)).toBeNull()
  })

  test('an app with no shortcut has nothing to remove', async () => {
    const { removed, remove } = register({ launcher: 'trashed' })
    expect(await remove({ ...notes, appId: '11111111-2222-4333-8444-555555555555' })).toEqual({ launcher: 'removed' })
    expect(removed).toEqual([])
  })
})

describe('a deleted app', () => {
  // WHY: a delete from any client must leave nothing of the app on this computer: no launcher, no window place, no permission answer.
  test('loses its shortcut, the files its launcher keeps, its window place, and its answers', async () => {
    const records = new AppShortcutRecords(join(dir, 'app-shortcut-records.json'))
    records.save({ ...notes, name: 'Notes', launcherPath: '/Users/sam/Applications/Solus Apps/Notes.app', iconKey: '', launcherFormat: 1 })
    records.saveWindowBounds(notes, { x: 0, y: 0, width: 800, height: 600 })
    records.setGrant(notes, 'Notes', 'camera', 'granted')
    const removed: string[] = []
    const forgotten: string[] = []
    let changes = 0
    const launchers: AppLaunchers = {
      write: async () => '',
      remove: async (_target, path) => {
        removed.push(path)
        return { launcher: 'trashed' }
      },
      forget: async (target) => { forgotten.push(target.appId) },
      windowIdentity: () => ({ iconPath: null, taskbar: null }),
    }
    await forgetApp({
      records,
      launchers,
      forgetAnswers: async (target) => records.forgetGrants(target),
      shortcutsChanged: () => { changes += 1 },
    }, notes)
    expect(removed).toEqual(['/Users/sam/Applications/Solus Apps/Notes.app'])
    expect(forgotten).toEqual([notes.appId])
    expect(records.find(notes)).toBeNull()
    expect(records.windowBounds(notes)).toBeNull()
    expect(records.grantOf(notes, 'camera')).toBeNull()
    expect(changes).toBe(1)
    // A second delete event finds nothing and tells no list.
    await forgetApp({ records, launchers, forgetAnswers: async () => {}, shortcutsChanged: () => { changes += 1 } }, notes)
    expect(changes).toBe(1)
  })
})
