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
  /** A shortcut link opened the window: it asks the person to add the shortcut (docs/app-shortcuts.md §5). */
  offer?: AppShortcutOffer
}

/**
 * What a shortcut link carries besides the app: what the client that made it
 * knew of the host. Both are hints for a computer that does not know the host
 * yet, and neither grants anything.
 */
export interface AppShortcutOffer {
  /** The `http:` or `https:` origin at which that client reached the host. Null when it had none. */
  address: string | null
  /** The subject of the account that client was signed in to. Null when it was signed out. */
  account: string | null
}

/** A new shortcut. `iconPng` is the app's tile as a square PNG; each operating system makes its own icon file from it. */
export interface AppShortcutRequest extends AppWindowRequest {
  iconPng: ArrayBuffer
}

const APP_LINK = /^solus:\/\/app\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/?$/
const ACCOUNT_SUBJECT = /^[A-Za-z0-9._:@|+=-]{1,255}$/

/** The subject of an account, as a shortcut link names it: one word of a small set of characters. */
export function isAccountSubject(value: string): boolean {
  return ACCOUNT_SUBJECT.test(value)
}

/** The link a shortcut opens. It names an app and grants nothing: the app window signs in as the desktop app does. */
export function appLinkOf(target: AppShortcutTarget): string {
  return `solus://app/${target.host}/${target.appId}`
}

/** Reads an app link strictly: any other part, as a query or a longer path, refuses the link. */
export function parseAppLink(value: string): AppShortcutTarget | null {
  const match = APP_LINK.exec(value)
  return match ? { host: match[1], appId: match[2] } : null
}

/** The `http:` or `https:` origin that `value` is, exactly: no user, path, query, or fragment. Null for any other value. */
export function hostAddressOf(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.origin === value ? value : null
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

const APP_WINDOW_HOST_PARAM = 'app-window-host'
const APP_WINDOW_APP_PARAM = 'app-window-app'
const APP_WINDOW_NAME_PARAM = 'app-window-name'
const APP_WINDOW_OFFER_PARAM = 'app-window-offer'
const APP_WINDOW_ADDRESS_PARAM = 'app-window-address'
const APP_WINDOW_ACCOUNT_PARAM = 'app-window-account'

/** The search parameters that make the desktop renderer page an app window's page. */
export function appWindowSearch(request: AppWindowRequest): URLSearchParams {
  const search = new URLSearchParams([
    [APP_WINDOW_HOST_PARAM, request.host],
    [APP_WINDOW_APP_PARAM, request.appId],
    [APP_WINDOW_NAME_PARAM, request.name],
  ])
  if (request.offer) {
    search.set(APP_WINDOW_OFFER_PARAM, '1')
    if (request.offer.address) search.set(APP_WINDOW_ADDRESS_PARAM, request.offer.address)
    if (request.offer.account) search.set(APP_WINDOW_ACCOUNT_PARAM, request.offer.account)
  }
  return search
}

/** The app that an app window's page shows, from the page's address; null in the workspace window. */
export function appWindowRequestOf(search: string): AppWindowRequest | null {
  const params = new URLSearchParams(search)
  const host = params.get(APP_WINDOW_HOST_PARAM)
  const appId = params.get(APP_WINDOW_APP_PARAM)
  if (!host || !appId || !isAppShortcutTarget({ host, appId })) return null
  const request: AppWindowRequest = { host, appId, name: params.get(APP_WINDOW_NAME_PARAM) ?? '' }
  if (params.get(APP_WINDOW_OFFER_PARAM) === '1') {
    const address = params.get(APP_WINDOW_ADDRESS_PARAM)
    const account = params.get(APP_WINDOW_ACCOUNT_PARAM)
    request.offer = {
      address: address ? hostAddressOf(address) : null,
      account: account && isAccountSubject(account) ? account : null,
    }
  }
  return request
}

/** What an app window asks of the workspace window when this computer does not know the app's host (§5). */
export type AppWindowWorkspaceRequest =
  /** The Add host dialog, at the address of the shortcut link when it had one. */
  | { kind: 'add-host'; address: string | null }
  /** The account settings, to sign in or to change the account. */
  | { kind: 'account' }
