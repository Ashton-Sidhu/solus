import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { MenuItemConstructorOptions } from 'electron'
import { parseAppDesktopCall, type AppDesktopEvent, type AppDesktopPermission, type AppDesktopResult, type AppDesktopValue } from '@solus/contracts/app-desktop'
import { parseAppCallName } from '@solus/contracts/apps'
import { AppDesktop, isNativeWayland, requestedAppPermissions, startedByOwnLoginItem, systemAudioSupported, systemMediaSettingsUrl, systemMediaStep, type AppDesktopPorts, type AppWindowHandle } from '@solus/desktop-main/app-shortcuts/app-desktop'
import { AppShortcutRecords } from '@solus/desktop-main/app-shortcuts/app-shortcut-records'
import { shortcutProblem } from '@solus/desktop-main/app-shortcuts/app-permission-text'
import { popoverPosition } from '@solus/desktop-main/app-shortcuts/window-bounds'

// The desktop capabilities of an app window (docs/plans/app-desktop-capabilities.md).
// The Electron parts are fakes, so these pin the permission model and what
// each capability holds on any machine: no answer means a question, a
// refusal is never asked again, a revoke takes the capability away at once,
// and nothing is kept for an app after it is deleted.

const notes = { host: '0123456789abcdef0123456789abcdef', appId: '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b' }
const tasks = { host: notes.host, appId: '11111111-2222-4333-8444-555555555555' }

class FakeWindow implements AppWindowHandle {
  isShown = true
  hasFocus = true
  isOnTop = false
  reloads = 0
  events: AppDesktopEvent[] = []
  constructor(public name: string) {}
  isVisible() { return this.isShown }
  isFocused() { return this.hasFocus }
  show() { this.isShown = true }
  hide() { this.isShown = false; this.hasFocus = false }
  reveal() { this.isShown = true; this.hasFocus = true }
  setAlwaysOnTop(isOn: boolean) { this.isOnTop = isOn }
  reload() { this.reloads += 1 }
  title() { return this.name }
  send(event: AppDesktopEvent) { this.events.push(event) }
}

interface Harness {
  desktop: AppDesktop
  records: AppShortcutRecords
  windows: Map<string, FakeWindow>
  answers: boolean[]
  asked: AppDesktopPermission[]
  held: Map<string, () => void>
  takenByOthers: Set<string>
  trays: { title: string; isDestroyed: boolean; menu: MenuItemConstructorOptions[]; hasPopover: boolean; click: () => void }[]
  popovers: { appId: string; width: number; height: number }[]
  closedPopovers: string[]
  notifications: { title: string; onClick: () => void }[]
  loginItem: boolean[]
  badges: (number | null)[]
  menus: MenuItemConstructorOptions[][]
  opened: string[]
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'solus-app-desktop-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/**
 * `personLoginItem`: the person made a login item of Solus themselves (macOS).
 * `audio`: whether this system can give system audio, and whether macOS lets Solus record it.
 * `floating`: whether a window can stay above others (not on native Wayland).
 */
function harness(os: 'darwin' | 'win32' | 'linux' = 'darwin', { personLoginItem = false, audio = { supported: true, access: true }, floating = true } = {}): Harness {
  const records = new AppShortcutRecords(join(dir, 'app-shortcuts.json'))
  const h: Omit<Harness, 'desktop'> = {
    records,
    windows: new Map([[notes.appId, new FakeWindow('Notes')]]),
    answers: [],
    asked: [],
    held: new Map(),
    takenByOthers: new Set(),
    trays: [],
    popovers: [],
    closedPopovers: [],
    notifications: [],
    loginItem: [],
    badges: [],
    menus: [],
    opened: [],
  }
  const ports: AppDesktopPorts = {
    os,
    records,
    windowOf: (target) => h.windows.get(target.appId) ?? null,
    openWindow: (target) => { h.opened.push(target.appId) },
    closeWindow: (target) => { h.windows.delete(target.appId); desktop.ended(target) },
    async ask({ permission }) {
      h.asked.push(permission)
      return h.answers.shift() ?? false
    },
    mediaAccess: async () => true,
    systemAudioSupported: audio.supported,
    floatingSupported: floating,
    systemAudioAccess: async () => audio.access,
    globalShortcuts: {
      isRegistered: (accelerator) => h.held.has(accelerator) || h.takenByOthers.has(accelerator),
      register(accelerator, onPress) {
        if (accelerator === 'Ctrl+Alt+Nope') throw new Error('conversion failure')
        h.held.set(accelerator, onPress)
        return true
      },
      unregister: (accelerator) => { h.held.delete(accelerator) },
    },
    createTray(_target, onClick) {
      const tray = { title: '', isDestroyed: false, menu: [] as MenuItemConstructorOptions[], hasPopover: false, click: onClick }
      h.trays.push(tray)
      return {
        setTitle: (text) => { tray.title = text },
        setMenu: (template, hasPopover) => {
          tray.menu = template
          tray.hasPopover = hasPopover
        },
        destroy: () => { tray.isDestroyed = true },
      }
    },
    togglePopover: (target, _name, page) => { h.popovers.push({ appId: target.appId, ...page }) },
    closePopover: (target) => { h.closedPopovers.push(target.appId) },
    notify: (notification) => { h.notifications.push(notification) },
    readClipboard: async () => 'copied text',
    setOpenAtLogin: async (isOn) => { h.loginItem.push(isOn) },
    personOpensAtLogin: () => personLoginItem,
    applyWindowMenu: (_target, template) => { h.menus.push(template) },
    removeShortcut: async () => {},
    badgeChanged: (_target, count) => { h.badges.push(count) },
    grantsChanged: () => {},
  }
  const desktop = new AppDesktop(ports)
  desktop.opened(notes)
  return { ...h, desktop }
}

/** A call as the IPC edge reads it: a call outside the contract never reaches the runtime. */
async function call(h: Harness, operation: string, args: AppDesktopValue = {}, target = notes): Promise<AppDesktopResult> {
  const parsed = parseAppDesktopCall(operation, args)
  return parsed.ok ? h.desktop.call(target, parsed.call) : parsed
}

function labels(items: MenuItemConstructorOptions[]): string[] {
  return items.map((item) => item.label ?? item.role ?? item.type ?? '')
}

function submenu(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  const found = items.find((item) => item.label === label)?.submenu
  return Array.isArray(found) ? found : []
}

describe('the call names', () => {
  test('a desktop call is the client\'s own and names a known operation', () => {
    expect(parseAppCallName('@desktop/shortcut-register')).toEqual({ kind: 'desktop', operation: 'shortcut-register' })
    expect(parseAppCallName('@desktop/open-terminal')).toBeNull()
  })
})

describe('the permission model', () => {
  test('a new app has no grants, and a call asks once', async () => {
    const h = harness()
    expect(await call(h, 'permission', { name: 'floating' })).toEqual({ ok: true, value: 'prompt' })
    h.answers.push(true)
    expect(await call(h, 'floating', { on: true })).toEqual({ ok: true, value: null })
    expect(await call(h, 'floating', { on: false })).toEqual({ ok: true, value: null })
    expect(await call(h, 'floating', { on: true })).toEqual({ ok: true, value: null })
    expect(h.asked).toEqual(['floating'])
    expect(h.windows.get(notes.appId)?.isOnTop).toBe(true)
  })

  test('a refusal fails with DesktopPermissionDenied and is never asked again', async () => {
    const h = harness()
    h.answers.push(false)
    const first = await call(h, 'notify', { title: 'Ready' })
    expect(first).toMatchObject({ ok: false, failure: { code: 'DesktopPermissionDenied', permission: 'notifications' } })
    await call(h, 'notify', { title: 'Ready' })
    expect(h.asked).toEqual(['notifications'])
    expect(h.notifications).toHaveLength(0)
  })

  test('requestPermission resolves the answer, and a refusal resolves denied, not a failure', async () => {
    const h = harness()
    h.answers.push(false)
    expect(await call(h, 'request-permission', { name: 'clipboardRead' })).toEqual({ ok: true, value: 'denied' })
  })

  test('two questions at once show one dialog after the other', async () => {
    const h = harness()
    h.answers.push(true, true)
    const both = await Promise.all([call(h, 'request-permission', { name: 'floating' }), call(h, 'request-permission', { name: 'floating' })])
    expect(both).toEqual([{ ok: true, value: 'granted' }, { ok: true, value: 'granted' }])
    expect(h.asked).toEqual(['floating'])
  })

  test('the answers stay on this device, by app, and a file of an older version still reads', async () => {
    const h = harness()
    h.answers.push(true)
    await call(h, 'request-permission', { name: 'shortcuts' })
    const again = new AppShortcutRecords(join(dir, 'app-shortcuts.json'))
    expect(again.grantOf(notes, 'shortcuts')).toBe('granted')
    expect(again.grantOf(tasks, 'shortcuts')).toBeNull()

    const older = join(dir, 'older.json')
    writeFileSync(older, JSON.stringify({ version: 1, shortcuts: [], windowBounds: {} }))
    expect(new AppShortcutRecords(older).grantsList()).toEqual([])
  })

  test('a call from no app window is unavailable', async () => {
    const h = harness()
    expect(await call(h, 'badge', { count: 2 }, tasks)).toMatchObject({ ok: false, failure: { code: 'DesktopUnavailable' } })
  })

  test('input outside the contract fails with DesktopInvalidInput', async () => {
    const h = harness()
    expect(await call(h, 'menu-bar-title', { text: 'x'.repeat(25) })).toMatchObject({ ok: false, failure: { code: 'DesktopInvalidInput' } })
    expect(await call(h, 'badge', { count: 1.5 })).toMatchObject({ ok: false, failure: { code: 'DesktopInvalidInput' } })
    expect(await call(h, 'notify', { title: 'Ready', route: '/reports' })).toMatchObject({ ok: false, failure: { code: 'DesktopInvalidInput' } })
    expect(await call(h, 'eject-disk')).toMatchObject({ ok: false, failure: { code: 'DesktopInvalidInput' } })
    expect(h.asked).toEqual([])
  })
})

describe('global shortcuts', () => {
  test('a press reaches the page of the app that holds it', async () => {
    const h = harness()
    h.answers.push(true)
    const result = await call(h, 'shortcut-register', { accelerator: 'CommandOrControl+Shift+K' })
    if (!result.ok) throw new Error(result.failure.message)
    h.held.get('CommandOrControl+Shift+K')?.()
    expect(h.windows.get(notes.appId)?.events).toEqual([{ event: 'desktop-shortcut', detail: result.value as { id: string } }])
  })

  test('keys another program holds fail with ShortcutTaken', async () => {
    const h = harness()
    h.answers.push(true)
    h.takenByOthers.add('Alt+Space')
    expect(await call(h, 'shortcut-register', { accelerator: 'Alt+Space' })).toMatchObject({ ok: false, failure: { code: 'ShortcutTaken', accelerator: 'Alt+Space' } })
    expect(await call(h, 'shortcut-register', { accelerator: 'Ctrl+Alt+Nope' })).toMatchObject({ ok: false, failure: { code: 'DesktopInvalidInput' } })
  })

  test('a shortcut must not take a key from typing in other apps', () => {
    expect(shortcutProblem('Shift+K')).toContain('Shift alone')
    expect(shortcutProblem('K')).toContain('takes a key')
    expect(shortcutProblem('CommandOrControl+')).toContain('not a keyboard shortcut')
    expect(shortcutProblem('F13')).toBeNull()
    expect(shortcutProblem('Alt+Shift+Space')).toBeNull()
  })

  test('an app holds at most eight', async () => {
    const h = harness()
    h.answers.push(true)
    for (let index = 1; index <= 8; index += 1) expect((await call(h, 'shortcut-register', { accelerator: `Alt+F${index}` })).ok).toBe(true)
    expect(await call(h, 'shortcut-register', { accelerator: 'Alt+F9' })).toMatchObject({ ok: false, failure: { code: 'DesktopInvalidInput' } })
  })

  test('a page that loads again takes the shortcuts of its app', async () => {
    const h = harness()
    h.answers.push(true)
    await call(h, 'shortcut-register', { accelerator: 'Alt+K' })
    expect((await call(h, 'shortcut-register', { accelerator: 'Alt+K' })).ok).toBe(true)
  })

  test('a revoke, a reload, and a close each release them', async () => {
    const h = harness()
    h.answers.push(true)
    await call(h, 'shortcut-register', { accelerator: 'Alt+K' })
    await h.desktop.change({ ...notes, permission: 'shortcuts', state: 'denied' })
    expect(h.held.size).toBe(0)

    await h.desktop.change({ ...notes, permission: 'shortcuts', state: 'granted' })
    await call(h, 'shortcut-register', { accelerator: 'Alt+K' })
    h.desktop.reloaded(notes)
    expect(h.held.size).toBe(0)

    await call(h, 'shortcut-register', { accelerator: 'Alt+K' })
    h.desktop.ended(notes)
    expect(h.held.size).toBe(0)
  })
})

describe('the menu-bar item', () => {
  test('it shows the title, keeps the window running on close, and a revoke removes it', async () => {
    const h = harness()
    h.answers.push(true)
    await call(h, 'menu-bar-title', { text: '3 unread' })
    expect(h.trays).toHaveLength(1)
    expect(h.trays[0].title).toBe('3 unread')
    expect(h.desktop.keepsRunning(notes)).toBe(true)
    expect(labels(h.trays[0].menu)).toEqual(['Open Notes', 'Reload', 'Permissions', 'Remove from menu bar', 'separator', 'Quit Notes'])

    await call(h, 'menu-bar-title', { text: null })
    expect(h.trays[0].title).toBe('Notes')

    h.windows.get(notes.appId)?.hide()
    await h.desktop.change({ ...notes, permission: 'menuBar', state: 'denied' })
    expect(h.trays[0].isDestroyed).toBe(true)
    // A hidden window with no item is out of reach, so it ends.
    expect(h.windows.has(notes.appId)).toBe(false)
  })

  test('Quit closes the window and removes the item', async () => {
    const h = harness()
    h.answers.push(true)
    await call(h, 'menu-bar-title', { text: 'Live' })
    h.desktop.quit(notes)
    expect(h.trays[0].isDestroyed).toBe(true)
    expect(h.windows.has(notes.appId)).toBe(false)
  })
})

describe('notifications, the clipboard, the badge, and the window', () => {
  test('a click on a notification brings the window to the front at its route', async () => {
    const h = harness()
    h.answers.push(true)
    await call(h, 'notify', { title: 'Report ready', route: '#/reports/42' })
    const window = h.windows.get(notes.appId)!
    window.hide()
    h.notifications[0].onClick()
    expect(window.isShown).toBe(true)
    expect(window.events).toEqual([{ event: 'open-route', detail: { route: '#/reports/42' } }])
  })

  test('the clipboard is read only with the grant', async () => {
    const h = harness()
    h.answers.push(true)
    expect(await call(h, 'clipboard-read')).toEqual({ ok: true, value: 'copied text' })
  })

  test('a badge needs no grant, and the counts of the apps add up', async () => {
    const h = harness()
    h.windows.set(tasks.appId, new FakeWindow('Tasks'))
    await call(h, 'badge', { count: 3 })
    await call(h, 'badge', { count: 4 }, tasks)
    expect(h.desktop.badgeTotal()).toBe(7)
    await call(h, 'badge', { count: 0 })
    expect(h.desktop.badgeTotal()).toBe(4)
    h.desktop.ended(tasks)
    expect(h.desktop.badgeTotal()).toBe(0)
    expect(h.asked).toEqual([])
  })

  test('toggle hides a window that has focus, and shows one that does not', async () => {
    const h = harness()
    const window = h.windows.get(notes.appId)!
    await call(h, 'window', { action: 'toggle' })
    expect(window.isShown).toBe(false)
    await call(h, 'window', { action: 'toggle' })
    expect(window.isShown && window.hasFocus).toBe(true)
  })

  test('focus and blur reach the page', () => {
    const h = harness()
    h.desktop.focusChanged(notes, 'blur')
    expect(h.windows.get(notes.appId)?.events).toEqual([{ event: 'desktop-window', detail: { type: 'blur' } }])
  })

  test('a revoke of the microphone reloads the window, so a capture that runs stops', async () => {
    const h = harness()
    h.answers.push(true)
    expect(await h.desktop.allows(notes, ['microphone'])).toBe(true)
    await h.desktop.change({ ...notes, permission: 'microphone', state: 'denied' })
    expect(h.windows.get(notes.appId)?.reloads).toBe(1)
    expect(await h.desktop.allows(notes, ['microphone'])).toBe(false)
  })
})

describe('a request of the page to Chromium', () => {
  test('maps to the permissions it needs, and an unknown device needs one the app cannot have', () => {
    expect(requestedAppPermissions('media', ['audio', 'video'])).toEqual(['microphone', 'camera'])
    expect(requestedAppPermissions('media', ['audio', 'screen'])).toEqual([])
    // getDisplayMedia: Electron 44 asks as media with no device type, later versions as display-capture.
    expect(requestedAppPermissions('media', [])).toEqual(['systemAudio'])
    expect(requestedAppPermissions('display-capture', undefined)).toEqual(['systemAudio'])
    expect(requestedAppPermissions('clipboard-read', undefined)).toEqual(['clipboardRead'])
    expect(requestedAppPermissions('geolocation', undefined)).toBeNull()
  })

  test('no permission asked is no capture', async () => {
    const h = harness()
    expect(await h.desktop.allows(notes, [])).toBe(false)
  })
})

describe('the menu-bar page', () => {
  const PAGE = { width: 360, height: 240 }

  // WHY: Executor's rule. An app that ships a menu-bar page asks for its item when it opens, and a click on the item opens the page.
  test('an app with a menu-bar page asks for its item, and a click opens the page in a popover', async () => {
    const h = harness('darwin')
    h.answers.push(true)
    await h.desktop.menuBarPageChanged(notes, PAGE)
    expect(h.asked).toEqual(['menuBar'])
    expect(h.trays).toHaveLength(1)
    expect(h.trays[0].title).toBe('Notes')
    expect(h.trays[0].hasPopover).toBe(true)
    h.trays[0].click()
    expect(h.popovers).toEqual([{ appId: notes.appId, ...PAGE }])
    // A close of the window keeps the page running, as for a title in the item.
    expect(h.desktop.keepsRunning(notes)).toBe(true)
  })

  test('a refusal shows no item, and the next open does not ask again', async () => {
    const h = harness()
    h.answers.push(false)
    await h.desktop.menuBarPageChanged(notes, PAGE)
    await h.desktop.menuBarPageChanged(notes, PAGE)
    expect(h.asked).toEqual(['menuBar'])
    expect(h.trays).toHaveLength(0)
  })

  test('a version with no menu-bar page closes the popover and removes the item it made', async () => {
    const h = harness()
    h.answers.push(true)
    await h.desktop.menuBarPageChanged(notes, PAGE)
    await h.desktop.menuBarPageChanged(notes, null)
    expect(h.closedPopovers).toContain(notes.appId)
    expect(h.trays[0].isDestroyed).toBe(true)
  })

  test('a revoke of the item closes the popover', async () => {
    const h = harness()
    h.answers.push(true)
    await h.desktop.menuBarPageChanged(notes, PAGE)
    await h.desktop.change({ ...notes, permission: 'menuBar', state: 'denied' })
    expect(h.closedPopovers).toContain(notes.appId)
    expect(h.trays[0].isDestroyed).toBe(true)
  })

  // WHY: parity. A Linux tray icon gives Solus no click, so its menu must open the page that a click opens elsewhere.
  test('on Linux the tray menu opens the page; on macOS and Windows a click does', async () => {
    for (const os of ['linux', 'darwin', 'win32'] as const) {
      const h = harness(os)
      h.answers.push(true)
      await h.desktop.menuBarPageChanged(notes, PAGE)
      const first = h.trays[0].menu[0]
      if (os === 'linux') {
        expect(first.label).toBe('Show Notes Popover')
        first.click?.({} as never, undefined, {} as never)
        expect(h.popovers).toHaveLength(1)
      } else {
        expect(first.label).toBe('Open Notes')
      }
    }
  })

  // WHY: parity. Windows and Linux show no text beside a tray icon, so the title the app set is the first line of its menu there.
  test('the title is in the menu bar on macOS, and the first line of the tray menu elsewhere', async () => {
    for (const os of ['darwin', 'win32', 'linux'] as const) {
      const h = harness(os)
      h.answers.push(true)
      await call(h, 'menu-bar-title', { text: '3 unread' })
      expect(h.trays[0].title).toBe('3 unread')
      const first = h.trays[0].menu[0]
      if (os === 'darwin') expect(first.label).toBe('Open Notes')
      else expect(first).toMatchObject({ label: '3 unread', enabled: false })
    }
  })

  test('the popover opens under an item at the top and above one at the bottom, inside the work area', () => {
    const area = { x: 0, y: 25, width: 1440, height: 875 }
    expect(popoverPosition(PAGE, { x: 1400, y: 0, width: 24, height: 24 }, area)).toEqual({ x: 1080, y: 28 })
    expect(popoverPosition(PAGE, { x: 700, y: 870, width: 24, height: 30 }, area)).toEqual({ x: 532, y: 626 })
    // Linux: the pointer is the anchor.
    expect(popoverPosition(PAGE, { x: 10, y: 5, width: 0, height: 0 }, area)).toEqual({ x: 0, y: 25 })
  })
})

describe('system audio', () => {
  // WHY: desktop.audio.system() readies the capture: the grant once, then getDisplayMedia, which the display-media handler answers from the grant only.
  test('a first call asks, and a capture is allowed only with the grant', async () => {
    const h = harness('win32')
    expect(h.desktop.allowsSystemAudio(notes)).toBe(false)
    h.answers.push(true)
    expect(await call(h, 'system-audio')).toEqual({ ok: true, value: null })
    expect(h.asked).toEqual(['systemAudio'])
    expect(h.desktop.allowsSystemAudio(notes)).toBe(true)
    expect(h.desktop.allowsSystemAudio(tasks)).toBe(false)
  })

  // WHY: a first Don't Allow started no capture; a reload then would only lose what the page holds. A revoke of a grant must stop a capture that runs.
  test('a refusal fails with DesktopPermissionDenied and keeps the page; a revoke stops a capture by a reload', async () => {
    const h = harness('linux')
    h.answers.push(false)
    expect(await call(h, 'system-audio')).toMatchObject({ ok: false, failure: { code: 'DesktopPermissionDenied', permission: 'systemAudio' } })
    expect(h.windows.get(notes.appId)?.reloads).toBe(0)
    await h.desktop.change({ ...notes, permission: 'systemAudio', state: 'granted' })
    await h.desktop.change({ ...notes, permission: 'systemAudio', state: 'denied' })
    expect(h.windows.get(notes.appId)?.reloads).toBe(1)
  })

  test('macOS without Screen & System Audio Recording fails with SystemAudioBlocked', async () => {
    const h = harness('darwin', { audio: { supported: true, access: false } })
    h.answers.push(true)
    expect(await call(h, 'system-audio')).toMatchObject({ ok: false, failure: { code: 'SystemAudioBlocked' } })
  })

  test('a system that cannot give it shows the permission as unavailable and fails with DesktopUnavailable', async () => {
    const h = harness('darwin', { audio: { supported: false, access: true } })
    expect(await call(h, 'permission', { name: 'systemAudio' })).toEqual({ ok: true, value: 'unavailable' })
    expect(await call(h, 'system-audio')).toMatchObject({ ok: false, failure: { code: 'DesktopUnavailable' } })
    expect(h.asked).toEqual([])
  })

  test('Windows, Linux, and macOS 13 and later can give it', () => {
    expect(systemAudioSupported('win32', 0)).toBe(true)
    expect(systemAudioSupported('linux', 0)).toBe(true)
    expect(systemAudioSupported('darwin', 22)).toBe(true)
    expect(systemAudioSupported('darwin', 21)).toBe(false)
  })
})

describe('keep above other windows on Wayland', () => {
  // WHY: the Wayland protocol gives a program no keep-on-top. An app must see "unavailable", not a grant that does nothing.
  test('a native Wayland session shows it as unavailable and asks nothing', async () => {
    const h = harness('linux', { floating: false })
    expect(await call(h, 'permission', { name: 'floating' })).toEqual({ ok: true, value: 'unavailable' })
    expect(await call(h, 'floating', { on: true })).toMatchObject({ ok: false, failure: { code: 'DesktopUnavailable' } })
    expect(h.asked).toEqual([])
    expect(isNativeWayland('linux', { WAYLAND_DISPLAY: 'wayland-0' }, '')).toBe(true)
    expect(isNativeWayland('linux', { WAYLAND_DISPLAY: 'wayland-0' }, 'x11')).toBe(false)
    expect(isNativeWayland('linux', { XDG_SESSION_TYPE: 'x11' }, '')).toBe(false)
    expect(isNativeWayland('darwin', { WAYLAND_DISPLAY: 'wayland-0' }, '')).toBe(false)
  })
})

describe('the system switch for a device', () => {
  // WHY: parity. macOS and Windows each have a privacy switch for Solus; a refusal there must lead the person to it, not fail without a word.
  test('macOS asks once and then offers System Settings; Windows offers Settings when it refuses; Linux has no switch', () => {
    expect(systemMediaStep('darwin', 'not-determined')).toBe('ask')
    expect(systemMediaStep('darwin', 'denied')).toBe('settings')
    expect(systemMediaStep('darwin', 'restricted')).toBe('settings')
    expect(systemMediaStep('darwin', 'granted')).toBe('allowed')
    expect(systemMediaStep('win32', 'denied')).toBe('settings')
    expect(systemMediaStep('win32', 'unknown')).toBe('allowed')
    expect(systemMediaStep('linux', 'denied')).toBe('allowed')
    expect(systemMediaSettingsUrl('win32', 'camera')).toBe('ms-settings:privacy-webcam')
    expect(systemMediaSettingsUrl('darwin', 'microphone')).toContain('Privacy_Microphone')
  })
})

describe('start at login', () => {
  test('Solus turns its login item on for the first app and off after the last, never one it did not turn on', async () => {
    const h = harness()
    h.answers.push(true)
    await call(h, 'request-permission', { name: 'startAtLogin' })
    await h.desktop.change({ ...tasks, permission: 'startAtLogin', state: 'granted' })
    expect(h.desktop.appsThatStartAtLogin().map((app) => app.target.appId)).toEqual([notes.appId, tasks.appId])
    await h.desktop.change({ ...notes, permission: 'startAtLogin', state: 'denied' })
    await h.desktop.forget(tasks)
    expect(h.loginItem).toEqual([true, false])

    // With no app that starts at login, a revoke changes nothing of the person's own login item.
    await h.desktop.change({ ...notes, permission: 'startAtLogin', state: 'prompt' })
    expect(h.loginItem).toEqual([true, false])
  })

  // WHY: on macOS Solus has one login item. When the person made it, it is theirs: Solus must not turn it off later, and a start by it must show the workspace.
  test('a login item the person made stays theirs', async () => {
    const h = harness('darwin', { personLoginItem: true })
    await h.desktop.change({ ...notes, permission: 'startAtLogin', state: 'granted' })
    await h.desktop.change({ ...notes, permission: 'startAtLogin', state: 'denied' })
    expect(h.loginItem).toEqual([])
    expect(h.records.loginItemForApps).toBe(false)
  })

  // WHY: parity (docs/plans/app-desktop-capabilities.md §6). A start by Solus's own login item opens the apps with no workspace window on every system.
  test('a start by Solus\'s own login item keeps the workspace hidden on each system', () => {
    const start = { argv: ['/Applications/Solus.app/Contents/MacOS/Solus'], loginArgument: '--solus-login', wasOpenedAtLogin: false, loginItemForApps: true }
    expect(startedByOwnLoginItem({ ...start, os: 'darwin', wasOpenedAtLogin: true })).toBe(true)
    expect(startedByOwnLoginItem({ ...start, os: 'darwin' })).toBe(false)
    expect(startedByOwnLoginItem({ ...start, os: 'win32', argv: ['C:\\Solus\\Solus.exe', '--solus-login'] })).toBe(true)
    expect(startedByOwnLoginItem({ ...start, os: 'linux', argv: ['/opt/Solus/solus', '--solus-login'] })).toBe(true)
    expect(startedByOwnLoginItem({ ...start, os: 'linux' })).toBe(false)
    // The person's own login item of Solus (macOS): Solus did not turn one on for the apps.
    expect(startedByOwnLoginItem({ ...start, os: 'darwin', wasOpenedAtLogin: true, loginItemForApps: false })).toBe(false)
  })
})

describe('the menus', () => {
  test('the app menu lists each permission with its state, and its items change the grant', async () => {
    const h = harness('darwin')
    h.answers.push(true)
    await call(h, 'floating', { on: true })
    const menu = h.menus.at(-1)!
    expect(labels(menu)).toEqual(['appMenu', 'Notes', 'editMenu', 'windowMenu'])
    const appItems = submenu(menu, 'Notes')
    expect(labels(appItems)).toEqual(['Reload', 'Permissions', 'separator', 'Close Window', 'Quit Notes'])
    const permissions = submenu(appItems, 'Permissions')
    const floating = permissions.find((item) => item.label === 'Keep above other windows')!
    expect(floating.checked).toBe(true)
    expect(permissions.find((item) => item.label === 'Camera')?.checked).toBe(false)
    floating.click?.({} as never, undefined, {} as never)
    await Bun.sleep(0)
    expect(h.records.grantOf(notes, 'floating')).toBe('denied')
    expect(h.windows.get(notes.appId)?.isOnTop).toBe(false)
  })

  test('Windows and Linux get the app menu in the window, with Edit, and a shortcut adds its Remove item', () => {
    const h = harness('win32')
    h.records.save({ ...notes, name: 'Notes', launcherPath: join(dir, 'Notes.lnk') })
    h.desktop.refresh(notes)
    const menu = h.menus.at(-1)!
    expect(labels(menu)).toEqual(['Notes', 'editMenu'])
    expect(labels(submenu(menu, 'Notes'))).toContain('Remove Notes shortcut…')
  })
})

describe('a deleted app', () => {
  test('keeps no answer and holds nothing', async () => {
    const h = harness()
    h.answers.push(true, true)
    await call(h, 'shortcut-register', { accelerator: 'Alt+K' })
    await call(h, 'menu-bar-title', { text: 'Live' })
    await h.desktop.forget(notes)
    expect(h.records.grantsList()).toEqual([])
    expect(h.held.size).toBe(0)
    expect(h.trays[0].isDestroyed).toBe(true)
  })
})
