import { randomUUID } from 'crypto'
import type { MenuItemConstructorOptions } from 'electron'
import {
  APP_SHORTCUTS_MAX,
  desktopPermissionDenied,
  desktopUnavailable,
  type AppDesktopCall,
  type AppDesktopEvent,
  type AppDesktopFailure,
  type AppDesktopPermission,
  type AppDesktopPermissionState,
  type AppDesktopResult,
  type AppDesktopValue,
  type AppPermissionChange,
  type AppPermissionsView,
  type DesktopOs,
} from '@solus/contracts/app-desktop'
import type { AppShortcutTarget } from '@solus/contracts/app-shortcuts'
import type { AppMenuBarPage } from '@solus/contracts/apps'
import type { AppShortcutRecords } from './app-shortcut-records'
import { appTrayMenuTemplate, appWindowMenuTemplate, type AppMenuModel } from './app-menus'
import { shortcutProblem } from './app-permission-text'
import { appShortcutId } from './launcher-files'

/** The window of one app, as the capabilities change it. */
export interface AppWindowHandle {
  isVisible(): boolean
  isFocused(): boolean
  show(): void
  hide(): void
  /** Shows the window and brings it in front of every other app's windows. */
  reveal(): void
  setAlwaysOnTop(isOn: boolean): void
  reload(): void
  /** The app's name as its page names the window. */
  title(): string
  send(event: AppDesktopEvent): void
}

export interface AppTrayHandle {
  /** The text in the menu bar on macOS; the tooltip elsewhere. */
  setTitle(text: string): void
  /**
   * The menu of the item. `hasPopover`: a click opens the app's menu-bar page,
   * so macOS shows the menu on a right click only.
   */
  setMenu(template: MenuItemConstructorOptions[], hasPopover: boolean): void
  destroy(): void
}

/** The Electron parts of the capabilities, so the rules run in a test with no operating system. */
export interface AppDesktopPorts {
  os: DesktopOs
  records: Pick<AppShortcutRecords, 'grantOf' | 'setGrant' | 'forgetGrants' | 'grantsList' | 'find' | 'loginItemForApps'>
  windowOf(target: AppShortcutTarget): AppWindowHandle | null
  openWindow(target: AppShortcutTarget, name: string, options: { isHidden: boolean }): void
  /** Closes the window of the app, even when it would hide. */
  closeWindow(target: AppShortcutTarget): void
  /** The native Allow / Don't Allow dialog, on the app's window when it shows. True is Allow. */
  ask(request: { target: AppShortcutTarget; name: string; permission: AppDesktopPermission; isOnWindow: boolean }): Promise<boolean>
  /** The operating system's own access for a device, after the app has the grant. */
  mediaAccess(permission: 'microphone' | 'camera'): Promise<boolean>
  /** This system can give an app what it plays (Windows, macOS 13 and later, Linux with PulseAudio or PipeWire). */
  systemAudioSupported: boolean
  /**
   * macOS: Solus may record the screen and system audio. When it may not, this
   * offers System Settings and answers false. True on Windows and Linux.
   */
  systemAudioAccess(): Promise<boolean>
  globalShortcuts: {
    isRegistered(accelerator: string): boolean
    /** False when another program holds it; throws for an accelerator Electron does not read. */
    register(accelerator: string, onPress: () => void): boolean
    unregister(accelerator: string): void
  }
  /** A click on the item: the popover of the menu-bar page, else the app's window (where a click opens anything). */
  createTray(target: AppShortcutTarget, onClick: () => void): AppTrayHandle
  /** Shows the popover of the app's menu-bar page under its item, or hides the one that shows. */
  togglePopover(target: AppShortcutTarget, name: string, page: AppMenuBarPage): void
  closePopover(target: AppShortcutTarget): void
  notify(notification: { title: string; body: string; onClick: () => void }): void
  readClipboard(): Promise<string>
  setOpenAtLogin(isOn: boolean): Promise<void>
  /**
   * The person made a login item of Solus themselves: Solus then does not
   * take it, so a start at login shows the workspace as they asked. Only
   * macOS has one login item for both; elsewhere Solus's own item carries an
   * argument of its own.
   */
  personOpensAtLogin(): boolean
  /** The menu of the app's window: the macOS menu bar while it has focus, the window's own menu bar elsewhere. */
  applyWindowMenu(target: AppShortcutTarget, template: MenuItemConstructorOptions[]): void
  /** Asks the person, then removes the app's shortcut. */
  removeShortcut(target: AppShortcutTarget, name: string): Promise<void>
  /** The count of one app changed; null is none. */
  badgeChanged(target: AppShortcutTarget, count: number | null): void
  /** A grant changed: Settings and every menu read again. */
  grantsChanged(): void
}

/** What one app holds while its window is open. */
interface RunningApp {
  target: AppShortcutTarget
  /** Accelerator by shortcut id. */
  shortcuts: Map<string, string>
  /** The text the page put in the menu bar; null shows the app's name. */
  menuBarTitle: string | null
  tray: AppTrayHandle | null
  /** The size of the app's menu-bar page, from its main page; null when the active version has none. */
  menuBarPage: AppMenuBarPage | null
  isFloating: boolean
  badge: number | null
}

/**
 * The permissions that a request of an app's page to Chromium needs, or null
 * when it is no app capability. A request for a device the app has no
 * permission for (audio and video and anything else) needs nothing it can have.
 */
export function requestedAppPermissions(permission: string, mediaTypes: readonly string[] | undefined): AppDesktopPermission[] | null {
  if (permission === 'notifications') return ['notifications']
  if (permission === 'clipboard-read') return ['clipboardRead']
  // `getDisplayMedia`: Electron 44 asks as `media` with no device type; later versions name it `display-capture`.
  if (permission === 'display-capture') return ['systemAudio']
  if (permission !== 'media') return null
  const types = mediaTypes ?? []
  if (types.length === 0) return ['systemAudio']
  const devices = types.flatMap((type): AppDesktopPermission[] => (type === 'audio' ? ['microphone'] : type === 'video' ? ['camera'] : []))
  return types.length > 0 && devices.length === types.length ? devices : []
}

/**
 * Solus's own login item started this run, for the apps that start at login:
 * the workspace window then stays hidden, as on every operating system.
 * Windows and Linux tell it by the argument of the item. macOS has no
 * arguments for a login item: it tells a start at login by the launch itself
 * (`wasOpenedAtLogin`), and the item is Solus's own only while Solus turned it
 * on for the apps.
 */
export function startedByOwnLoginItem(start: {
  os: DesktopOs
  argv: readonly string[]
  loginArgument: string
  wasOpenedAtLogin: boolean
  loginItemForApps: boolean
}): boolean {
  if (!start.loginItemForApps) return false
  return start.os === 'darwin' ? start.wasOpenedAtLogin : start.argv.includes(start.loginArgument)
}

/** The operating system's privacy status of a device, as Electron reads it (macOS and Windows). */
export type SystemMediaStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

/**
 * What Solus does for a device of an app that has its grant: the system has
 * its own switch for Solus on macOS and Windows. `ask` shows the system
 * question (macOS); `settings` offers the system's privacy settings, because a
 * refusal there is one for every app of Solus. Linux has no such switch for a
 * desktop program.
 */
/**
 * Where an app can capture what this computer plays (Executor's
 * `systemAudioSupported`, with Linux): Windows; macOS 13 (Darwin 22) and
 * later, through ScreenCaptureKit; Linux, through the monitor of the default
 * PulseAudio sink, which PipeWire gives too (Chromium's
 * `PulseaudioLoopbackForScreenShare`, which Solus turns on).
 */
export function systemAudioSupported(os: DesktopOs, darwinMajor: number): boolean {
  return os !== 'darwin' || darwinMajor >= 22
}

export function systemMediaStep(os: DesktopOs, status: SystemMediaStatus): 'allowed' | 'ask' | 'settings' {
  if (os === 'linux' || status === 'granted') return 'allowed'
  if (os === 'darwin') return status === 'not-determined' ? 'ask' : 'settings'
  return status === 'denied' ? 'settings' : 'allowed'
}

/** The privacy page of the system for a device. */
export function systemMediaSettingsUrl(os: 'darwin' | 'win32', device: 'microphone' | 'camera'): string {
  if (os === 'win32') return device === 'microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:privacy-webcam'
  return `x-apple.systempreferences:com.apple.preference.security?${device === 'microphone' ? 'Privacy_Microphone' : 'Privacy_Camera'}`
}

/** `toggle` hides a window that shows and has focus, and shows and focuses any other. */
function windowAction(window: AppWindowHandle, action: 'show' | 'hide' | 'focus' | 'toggle'): null {
  if (action === 'show') window.show()
  else if (action === 'hide') window.hide()
  else if (action === 'focus' || !(window.isVisible() && window.isFocused())) window.reveal()
  else window.hide()
  return null
}

class DesktopFailure extends Error {
  constructor(readonly failure: AppDesktopFailure) {
    super(failure.message)
  }
}

function invalidInput(message: string): DesktopFailure {
  return new DesktopFailure({ code: 'DesktopInvalidInput', message })
}

/**
 * The desktop capabilities of the apps in their app windows
 * (docs/plans/app-desktop-capabilities.md). It names an app from its window,
 * keeps the person's answers in the records of this device, asks with a
 * native dialog one question at a time, and keeps what each open app holds:
 * its shortcuts, its menu-bar item, its badge, and its window above others.
 */
export class AppDesktop {
  private readonly running = new Map<string, RunningApp>()
  /** One permission dialog at a time, for every app. */
  private asking: Promise<unknown> = Promise.resolve()

  constructor(private readonly ports: AppDesktopPorts) {}

  // ─── Permissions ───

  permissionState(target: AppShortcutTarget, permission: AppDesktopPermission): AppDesktopPermissionState {
    if (permission === 'systemAudio' && !this.ports.systemAudioSupported) return 'unavailable'
    return this.ports.records.grantOf(target, permission) ?? 'prompt'
  }

  private permissionsOf(target: AppShortcutTarget): AppPermissionsView['permissions'] {
    const state = (permission: AppDesktopPermission) => this.permissionState(target, permission)
    return {
      menuBar: state('menuBar'),
      shortcuts: state('shortcuts'),
      floating: state('floating'),
      startAtLogin: state('startAtLogin'),
      microphone: state('microphone'),
      camera: state('camera'),
      systemAudio: state('systemAudio'),
      clipboardRead: state('clipboardRead'),
      notifications: state('notifications'),
    }
  }

  /** Asks the person when they have not answered, and gives the state after. */
  private async request(target: AppShortcutTarget, permission: AppDesktopPermission): Promise<AppDesktopPermissionState> {
    const turn = this.asking.then(async () => {
      if (this.permissionState(target, permission) !== 'prompt') return
      const name = this.nameOf(target)
      const isAllowed = await this.ports.ask({ target, name, permission, isOnWindow: this.ports.windowOf(target)?.isVisible() ?? false })
      // The window may have closed while the dialog was open: the answer still counts.
      this.ports.records.setGrant(target, name, permission, isAllowed ? 'granted' : 'denied')
      await this.applied(target, permission, 'prompt')
    })
    this.asking = turn.catch(() => undefined)
    await turn
    return this.permissionState(target, permission)
  }

  /** Resolves when the app has the permission; asks first when the person has not answered. */
  private async ensure(target: AppShortcutTarget, permission: AppDesktopPermission): Promise<void> {
    if (await this.request(target, permission) !== 'granted') throw new DesktopFailure(desktopPermissionDenied(permission))
  }

  /**
   * Whether the app may have what a request of its page asks for: the grant of
   * each permission, asked for when needed, and for a device the operating
   * system's access too. The permission handler of the session calls it for an
   * app window's `getUserMedia`.
   */
  async allows(target: AppShortcutTarget, permissions: readonly AppDesktopPermission[]): Promise<boolean> {
    for (const permission of permissions) {
      if (await this.request(target, permission) !== 'granted') return false
      if ((permission === 'microphone' || permission === 'camera') && !await this.ports.mediaAccess(permission)) return false
    }
    return permissions.length > 0
  }

  /** The apps with an answer on this device, for Settings. */
  list(): AppPermissionsView[] {
    return this.ports.records.grantsList().map(({ host, appId, name }) => ({
      host,
      appId,
      name: this.runningName({ host, appId }) ?? name,
      permissions: this.permissionsOf({ host, appId }),
    }))
  }

  /** A change from Settings or a menu. It applies at once. */
  async change({ host, appId, permission, state }: AppPermissionChange): Promise<void> {
    const target = { host, appId }
    const before = this.permissionState(target, permission)
    this.ports.records.setGrant(target, this.nameOf(target), permission, state === 'prompt' ? null : state)
    await this.applied(target, permission, before)
  }

  /** A deleted app keeps nothing on this device: no answer, no shortcut it holds, no menu-bar item. */
  async forget(target: AppShortcutTarget): Promise<void> {
    const hadStartAtLogin = this.permissionState(target, 'startAtLogin') === 'granted'
    this.ports.records.forgetGrants(target)
    const running = this.running.get(appShortcutId(target))
    if (running) {
      this.releaseShortcuts(running)
      this.setFloating(running, false)
      this.removeTray(running)
      this.refreshMenus(running)
    }
    if (hadStartAtLogin) await this.syncLoginItem()
    this.ports.grantsChanged()
  }

  /** What a change of one grant does to an open app. `before`: the state the change came from. */
  private async applied(target: AppShortcutTarget, permission: AppDesktopPermission, before: AppDesktopPermissionState): Promise<void> {
    const running = this.running.get(appShortcutId(target))
    const isGranted = this.permissionState(target, permission) === 'granted'
    if (permission === 'startAtLogin') await this.syncLoginItem()
    if (running && !isGranted) {
      if (permission === 'menuBar') this.removeTray(running)
      if (permission === 'shortcuts') this.releaseShortcuts(running)
      if (permission === 'floating') this.setFloating(running, false)
      // A capture that runs keeps running until the page stops it: a reload stops it. A first answer of
      // Don't Allow started no capture, and a reload then would only lose what the page holds.
      const isDevice = permission === 'microphone' || permission === 'camera' || permission === 'systemAudio'
      if (isDevice && before === 'granted') this.ports.windowOf(target)?.reload()
    }
    if (running) this.refreshMenus(running)
    this.ports.grantsChanged()
  }

  // ─── Start at login ───

  /** The apps that open with no window each time Solus starts. */
  appsThatStartAtLogin(): { target: AppShortcutTarget; name: string }[] {
    return this.ports.records.grantsList()
      .filter((record) => record.grants.startAtLogin === 'granted')
      .map(({ host, appId, name }) => ({ target: { host, appId }, name }))
  }

  /**
   * Solus opens at login while an app needs it. Solus turns its login item
   * off only when it turned it on, so a login item the person made stays.
   */
  private async syncLoginItem(): Promise<void> {
    const isWanted = this.appsThatStartAtLogin().length > 0
    const records = this.ports.records
    if (isWanted === records.loginItemForApps) return
    // The person's own login item already opens Solus at login, and the apps open with it.
    if (isWanted && this.ports.personOpensAtLogin()) return
    await this.ports.setOpenAtLogin(isWanted)
    records.loginItemForApps = isWanted
  }

  // ─── The calls of an app's page ───

  /** One `@desktop/<operation>` call from the page of the app's window, read at the IPC edge. Never throws: a failure is the answer. */
  async call(target: AppShortcutTarget, request: AppDesktopCall): Promise<AppDesktopResult> {
    try {
      return { ok: true, value: await this.run(target, request) }
    } catch (error) {
      if (error instanceof DesktopFailure) return { ok: false, failure: error.failure }
      return { ok: false, failure: { code: 'DesktopInvalidInput', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  private run(target: AppShortcutTarget, request: AppDesktopCall): Promise<AppDesktopValue> {
    const window = this.ports.windowOf(target)
    if (!window) throw new DesktopFailure(desktopUnavailable())
    const running = this.runningOf(target)
    switch (request.operation) {
      case 'permission': return Promise.resolve(this.permissionState(target, request.args.name))
      case 'request-permission': return this.allows(target, [request.args.name]).then(() => this.permissionState(target, request.args.name))
      case 'menu-bar-title': return this.setMenuBarTitle(running, request.args.text)
      case 'shortcut-register': return this.registerShortcut(running, request.args.accelerator).then((id) => ({ id }))
      case 'shortcut-unregister': return Promise.resolve(this.unregisterShortcut(running, request.args.id))
      case 'floating': return this.floating(running, request.args.on)
      case 'window': return Promise.resolve(windowAction(window, request.args.action))
      case 'badge': return Promise.resolve(this.setBadge(running, request.args.count))
      case 'notify': return this.notify(target, request.args)
      case 'clipboard-read': return this.ensure(target, 'clipboardRead').then(() => this.ports.readClipboard())
      case 'system-audio': return this.systemAudio(target)
    }
  }

  /**
   * Readies a capture of what this computer plays (Executor's `systemAudio`):
   * the grant, asked for once, and on macOS the system's access. The page then
   * calls `getDisplayMedia`, which `allowsSystemAudio` answers.
   */
  private async systemAudio(target: AppShortcutTarget): Promise<null> {
    if (!this.ports.systemAudioSupported) throw new DesktopFailure(desktopUnavailable())
    await this.ensure(target, 'systemAudio')
    if (!await this.ports.systemAudioAccess()) {
      throw new DesktopFailure({ code: 'SystemAudioBlocked', message: 'macOS has not allowed Solus to record system audio. Turn on Solus in System Settings > Privacy & Security > Screen & System Audio Recording, then try again.' })
    }
    return null
  }

  /** Whether a `getDisplayMedia` call of the app's page gets the system's audio: the grant only, never a question. */
  allowsSystemAudio(target: AppShortcutTarget): boolean {
    return this.ports.systemAudioSupported && this.permissionState(target, 'systemAudio') === 'granted'
  }

  private async setMenuBarTitle(running: RunningApp, text: string | null): Promise<null> {
    await this.ensure(running.target, 'menuBar')
    running.menuBarTitle = text
    this.showTray(running)
    return null
  }

  private unregisterShortcut(running: RunningApp, id: string): null {
    const accelerator = running.shortcuts.get(id)
    if (accelerator === undefined) return null
    running.shortcuts.delete(id)
    if (![...running.shortcuts.values()].includes(accelerator)) this.ports.globalShortcuts.unregister(accelerator)
    this.refreshMenus(running)
    return null
  }

  private async floating(running: RunningApp, isOn: boolean): Promise<null> {
    if (isOn) await this.ensure(running.target, 'floating')
    this.setFloating(running, isOn)
    return null
  }

  private setBadge(running: RunningApp, count: number | null): null {
    running.badge = count === 0 ? null : count
    this.ports.badgeChanged(running.target, running.badge)
    return null
  }

  private async notify(target: AppShortcutTarget, { title, body, route }: { title: string; body: string; route: string | null }): Promise<null> {
    await this.ensure(target, 'notifications')
    this.ports.notify({ title, body, onClick: () => this.openAt(target, route) })
    return null
  }

  private async registerShortcut(running: RunningApp, accelerator: string): Promise<string> {
    const problem = shortcutProblem(accelerator)
    if (problem) throw invalidInput(problem)
    const name = this.nameOf(running.target)
    const tooMany = () => invalidInput(`${name} already has ${APP_SHORTCUTS_MAX} keyboard shortcuts. Remove one before you add another.`)
    const holdsIt = () => [...running.shortcuts.values()].includes(accelerator)
    if (!holdsIt() && new Set(running.shortcuts.values()).size >= APP_SHORTCUTS_MAX) throw tooMany()
    await this.ensure(running.target, 'shortcuts')
    const id = randomUUID()
    // The app holds it already: a page that loaded again registers its shortcuts again, and takes them.
    if (holdsIt()) {
      for (const [heldId, held] of running.shortcuts) if (held === accelerator) running.shortcuts.delete(heldId)
      running.shortcuts.set(id, accelerator)
      this.refreshMenus(running)
      return id
    }
    if (new Set(running.shortcuts.values()).size >= APP_SHORTCUTS_MAX) throw tooMany()
    const shortcuts = this.ports.globalShortcuts
    if (shortcuts.isRegistered(accelerator)) throw new DesktopFailure({ code: 'ShortcutTaken', accelerator, message: `${accelerator} is in use by another app or by Solus.` })
    let isRegistered: boolean
    try {
      isRegistered = shortcuts.register(accelerator, () => this.pressed(running, accelerator))
    } catch {
      throw invalidInput(`${accelerator} is not a keyboard shortcut that the desktop app can use.`)
    }
    if (!isRegistered) throw new DesktopFailure({ code: 'ShortcutTaken', accelerator, message: `${accelerator} is in use by another program.` })
    running.shortcuts.set(id, accelerator)
    this.refreshMenus(running)
    return id
  }

  private pressed(running: RunningApp, accelerator: string): void {
    const window = this.ports.windowOf(running.target)
    for (const [id, held] of running.shortcuts) if (held === accelerator) window?.send({ event: 'desktop-shortcut', detail: { id } })
  }

  private releaseShortcuts(running: RunningApp): void {
    for (const accelerator of new Set(running.shortcuts.values())) this.ports.globalShortcuts.unregister(accelerator)
    running.shortcuts.clear()
  }

  private setFloating(running: RunningApp, isOn: boolean): void {
    running.isFloating = isOn
    this.ports.windowOf(running.target)?.setAlwaysOnTop(isOn)
  }

  /** A click on a notification: the window in front, at the route. */
  private openAt(target: AppShortcutTarget, route: string | null): void {
    const window = this.ports.windowOf(target)
    if (!window) {
      this.ports.openWindow(target, this.nameOf(target), { isHidden: false })
      return
    }
    window.reveal()
    if (route) window.send({ event: 'open-route', detail: { route } })
  }

  // ─── The menu-bar item ───

  private showTray(running: RunningApp): void {
    if (this.permissionState(running.target, 'menuBar') !== 'granted') return
    running.tray ??= this.ports.createTray(running.target, () => this.trayClicked(running))
    running.tray.setTitle(running.menuBarTitle ?? this.nameOf(running.target))
    this.refreshMenus(running)
  }

  private trayClicked(running: RunningApp): void {
    if (running.menuBarPage) this.ports.togglePopover(running.target, this.nameOf(running.target), running.menuBarPage)
    else this.open(running.target)
  }

  /**
   * The app's main page says whether its version has a menu-bar page
   * (docs/plans/app-desktop-capabilities.md §9). An app with one asks for
   * the menu-bar item when it opens, as Executor does, and a click on the
   * item opens the page. A new version with no such page closes it; the
   * item stays only while the page shows a title in it.
   */
  async menuBarPageChanged(target: AppShortcutTarget, page: AppMenuBarPage | null): Promise<void> {
    const running = this.running.get(appShortcutId(target))
    if (!running) return
    const hadPage = running.menuBarPage !== null
    running.menuBarPage = page
    if (!page) {
      this.ports.closePopover(target)
      if (hadPage && running.menuBarTitle === null) this.removeTray(running)
      else this.refreshMenus(running)
      return
    }
    await this.request(target, 'menuBar')
    if (this.running.get(appShortcutId(target)) === running) this.showTray(running)
  }

  private removeTray(running: RunningApp): void {
    if (!running.tray) return
    this.ports.closePopover(running.target)
    running.tray.destroy()
    running.tray = null
    // A hidden window with no item is out of reach: it ends.
    const window = this.ports.windowOf(running.target)
    if (window && !window.isVisible()) this.ports.closeWindow(running.target)
  }

  private open(target: AppShortcutTarget): void {
    const window = this.ports.windowOf(target)
    if (window) window.reveal()
    else this.ports.openWindow(target, this.nameOf(target), { isHidden: false })
  }

  // ─── The menus ───

  private refreshMenus(running: RunningApp): void {
    const target = running.target
    const model: AppMenuModel = {
      os: this.ports.os,
      name: this.nameOf(target),
      permissions: this.permissionsOf(target),
      shortcuts: [...new Set(running.shortcuts.values())],
      hasMenuBarItem: running.tray !== null,
      hasPopover: running.menuBarPage !== null,
      showPopover: () => this.trayClicked(running),
      hasShortcut: this.ports.records.find(target) !== null,
      open: () => this.open(target),
      reload: () => this.ports.windowOf(target)?.reload(),
      setGranted: (permission, isGranted) => void this.change({ ...target, permission, state: isGranted ? 'granted' : 'denied' }),
      removeShortcut: () => void this.ports.removeShortcut(target, this.nameOf(target)).then(() => this.refreshMenus(running)),
      quit: () => this.quit(target),
    }
    this.ports.applyWindowMenu(target, appWindowMenuTemplate(model))
    running.tray?.setMenu(appTrayMenuTemplate(model), model.hasPopover)
  }

  /** The shortcuts or the name changed outside a call, such as a removed launcher. */
  refresh(target: AppShortcutTarget): void {
    const running = this.running.get(appShortcutId(target))
    if (running) this.refreshMenus(running)
  }

  // ─── The life of an app window ───

  private runningOf(target: AppShortcutTarget): RunningApp {
    const key = appShortcutId(target)
    let running = this.running.get(key)
    if (!running) {
      running = { target, shortcuts: new Map(), menuBarTitle: null, tray: null, menuBarPage: null, isFloating: false, badge: null }
      this.running.set(key, running)
    }
    return running
  }

  private nameOf(target: AppShortcutTarget): string {
    return this.runningName(target) || this.ports.records.grantsList().find((record) => record.host === target.host && record.appId === target.appId)?.name || 'This app'
  }

  private runningName(target: AppShortcutTarget): string | null {
    return this.ports.windowOf(target)?.title() || null
  }

  /** The window of the app opened. */
  opened(target: AppShortcutTarget): void {
    this.refreshMenus(this.runningOf(target))
  }

  /** The window's page loaded again: what the old page held is gone with it. */
  reloaded(target: AppShortcutTarget): void {
    const running = this.running.get(appShortcutId(target))
    if (!running) return
    this.releaseShortcuts(running)
    running.menuBarTitle = null
    if (running.tray) running.tray.setTitle(this.nameOf(target))
    this.refreshMenus(running)
  }

  /** The page's title changed: the menus and the item show the new name. */
  renamed(target: AppShortcutTarget): void {
    const running = this.running.get(appShortcutId(target))
    if (!running) return
    if (running.tray && running.menuBarTitle === null) running.tray.setTitle(this.nameOf(target))
    this.refreshMenus(running)
  }

  /** A close hides the window of an app with a menu-bar item: its page keeps running. */
  keepsRunning(target: AppShortcutTarget): boolean {
    return this.running.get(appShortcutId(target))?.tray != null
  }

  focusChanged(target: AppShortcutTarget, type: 'focus' | 'blur'): void {
    this.ports.windowOf(target)?.send({ event: 'desktop-window', detail: { type } })
    const running = this.running.get(appShortcutId(target))
    if (type === 'focus' && running) this.refreshMenus(running)
  }

  /** Quit <App>: the window closes, and what the app held goes. */
  quit(target: AppShortcutTarget): void {
    this.ended(target)
    this.ports.closeWindow(target)
  }

  /** The window closed for good. */
  ended(target: AppShortcutTarget): void {
    const key = appShortcutId(target)
    const running = this.running.get(key)
    if (!running) return
    this.running.delete(key)
    this.releaseShortcuts(running)
    this.ports.closePopover(target)
    running.tray?.destroy()
    if (running.badge !== null) this.ports.badgeChanged(target, null)
  }

  /** The sum of every app's badge, for the Dock or launcher count. */
  badgeTotal(): number {
    let total = 0
    for (const running of this.running.values()) total += running.badge ?? 0
    return total
  }
}
