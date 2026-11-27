/**
 * App windows and app shortcuts on the desktop client (docs/app-shortcuts.md).
 *
 * An **app window** is a desktop window that shows one app without the
 * workspace. An **app shortcut** is the launcher that the operating system
 * shows for one app on this device. A shortcut opens the app link; the desktop
 * app opens the app window for it. Both are client shell state: no host keeps
 * them.
 */

/** One app on one host. `host` is the host's installation id, as a sidebar pin names it, so the name holds on every launch. */
export interface AppShortcutTarget {
  host: string
  appId: string
}

/** What the main process needs to open an app window before the host answers. */
export interface AppWindowRequest extends AppShortcutTarget {
  /** The app's name, for the title of the window until its page loads. */
  name: string
}

/** A new shortcut. `iconPng` is the app's tile as a square PNG; each operating system makes its own icon file from it. */
export interface AppShortcutRequest extends AppWindowRequest {
  iconPng: ArrayBuffer
}

const APP_LINK = /^solus:\/\/app\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/?$/

/** The link a shortcut opens. It names an app and grants nothing: the app window signs in as the desktop app does. */
export function appLinkOf(target: AppShortcutTarget): string {
  return `solus://app/${target.host}/${target.appId}`
}

/** Reads an app link strictly: any other part, as a query or a longer path, refuses the link. */
export function parseAppLink(value: string): AppShortcutTarget | null {
  const match = APP_LINK.exec(value)
  return match ? { host: match[1], appId: match[2] } : null
}

export function isAppShortcutTarget(target: AppShortcutTarget): boolean {
  return parseAppLink(appLinkOf(target)) !== null
}

export function isSameAppShortcutTarget(a: AppShortcutTarget, b: AppShortcutTarget): boolean {
  return a.host === b.host && a.appId === b.appId
}

/** A shortcut of this device, as its list names it. */
export interface AppShortcutView extends AppShortcutTarget {
  /** The name the launcher has. An app that was renamed since has another one. */
  name: string
}

/**
 * What became of the launcher when its shortcut was removed
 * (docs/app-shortcuts.md §4). The record goes in each case.
 */
export type AppShortcutRemoval =
  /** In the Trash (macOS) or the Recycle Bin (Windows): the person can take it back. */
  | { launcher: 'trashed' }
  /** No launcher of this app is left: it was deleted (Linux), or it was not there. */
  | { launcher: 'removed' }
  /** The Trash refused the launcher, so it stays at `launcherPath`. It still opens the app. */
  | { launcher: 'kept'; launcherPath: string }

const APP_WINDOW_HOST_PARAM = 'app-window-host'
const APP_WINDOW_APP_PARAM = 'app-window-app'
const APP_WINDOW_NAME_PARAM = 'app-window-name'

/** The search parameters that make the desktop renderer page an app window's page. */
export function appWindowSearch(request: AppWindowRequest): URLSearchParams {
  return new URLSearchParams([
    [APP_WINDOW_HOST_PARAM, request.host],
    [APP_WINDOW_APP_PARAM, request.appId],
    [APP_WINDOW_NAME_PARAM, request.name],
  ])
}

/** The app that an app window's page shows, from the page's address; null in the workspace window. */
export function appWindowRequestOf(search: string): AppWindowRequest | null {
  const params = new URLSearchParams(search)
  const host = params.get(APP_WINDOW_HOST_PARAM)
  const appId = params.get(APP_WINDOW_APP_PARAM)
  if (!host || !appId || !isAppShortcutTarget({ host, appId })) return null
  return { host, appId, name: params.get(APP_WINDOW_NAME_PARAM) ?? '' }
}
