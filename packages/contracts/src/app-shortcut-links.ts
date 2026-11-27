import { hostAddressOf, isAccountSubject, parseAppLink, type AppShortcutOffer, type AppShortcutTarget } from './app-shortcuts'

/**
 * The links that the desktop app takes from outside (docs/app-shortcuts.md
 * §5): the app link of a launcher and the shortcut link of the web client.
 * Apart from `app-shortcuts.ts`, so the first screen of the desktop renderer
 * does not load the parsers that only the main process and a dialog use.
 */

/** The query of a shortcut link has no `#`: a fragment refuses the link. */
const APP_SHORTCUT_LINK = /^solus:\/\/app-shortcut\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})(?:\?([^#]*))?$/
/** A name that labels a prompt: no control, format, or line characters. */
const LINK_LABEL = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,80}$/u
const SHORTCUT_LINK_PARAMS = new Set(['address', 'account', 'name'])
const MAX_LINK_LENGTH = 2048

/**
 * A shortcut link: what another client (the web client) opens to add an app
 * shortcut on this computer (docs/app-shortcuts.md §5). Any website can open
 * such a link, so it carries no credential and grants nothing.
 */
export interface AppShortcutLink {
  target: AppShortcutTarget
  /** The app's name as that client showed it. Any page can write it, so it only labels the window until the host answers. */
  name: string | null
  offer: AppShortcutOffer
}

/**
 * `solus://app-shortcut/<host>/<app id>?address=…&account=…&name=…`; each
 * parameter only when the client knows it. Null when a part would not read back.
 */
export function appShortcutLinkOf(link: AppShortcutLink): string | null {
  const query = new URLSearchParams()
  if (link.offer.address) query.set('address', link.offer.address)
  if (link.offer.account) query.set('account', link.offer.account)
  if (link.name && LINK_LABEL.test(link.name)) query.set('name', link.name)
  const search = query.toString()
  const value = `solus://app-shortcut/${link.target.host}/${link.target.appId}${search ? `?${search}` : ''}`
  return parseAppShortcutLink(value) ? value : null
}

/**
 * Reads a shortcut link strictly. Each part has one form: an unknown or
 * repeated parameter, an address that is not a bare `http:`/`https:` origin,
 * an id of another shape, or a fragment refuses the link.
 */
export function parseAppShortcutLink(value: string): AppShortcutLink | null {
  if (value.length > MAX_LINK_LENGTH) return null
  const match = APP_SHORTCUT_LINK.exec(value)
  if (!match) return null
  const query = new URLSearchParams(match[3] ?? '')
  const keys = [...query.keys()]
  if (keys.some((key) => !SHORTCUT_LINK_PARAMS.has(key)) || new Set(keys).size !== keys.length) return null
  const rawAddress = query.get('address')
  const account = query.get('account')
  const name = query.get('name')
  const address = rawAddress === null ? null : hostAddressOf(rawAddress)
  if (rawAddress !== null && !address) return null
  if (account !== null && !isAccountSubject(account)) return null
  if (name !== null && !LINK_LABEL.test(name)) return null
  return { target: { host: match[1], appId: match[2] }, name, offer: { address, account } }
}

/** A link the desktop app acts on: it opens an app, or it opens an app and asks to add its shortcut. Nothing else. */
export type AppLinkAction =
  | { kind: 'open'; target: AppShortcutTarget }
  | ({ kind: 'add-shortcut' } & AppShortcutLink)

export function parseAppLinkAction(value: string): AppLinkAction | null {
  const target = parseAppLink(value)
  if (target) return { kind: 'open', target }
  const link = parseAppShortcutLink(value)
  return link ? { kind: 'add-shortcut', ...link } : null
}
