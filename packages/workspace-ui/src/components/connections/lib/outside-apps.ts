import type { AppEndpoint } from '../../../contexts/connections/connections.store.svelte'
import type { AppAccess } from '@solus/contracts/host-api'
import type { WorkPolicy } from '@solus/contracts/host-policies'
import { OUTSIDE_APP_GUIDES, type OutsideAppGuide } from '@solus/contracts/outside-apps'
import { appAccessLabel } from './paired-devices'

/** One address of a host's MCP endpoint, and where it works. */
export interface AppEndpointAddress {
  kind: 'local' | 'public'
  label: string
  url: string
}

/** The addresses an outside app can use: always the one on the host's machine, and the public tunnel address when the host has one. */
export function appEndpointAddresses(endpoint: AppEndpoint): AppEndpointAddress[] {
  const local: AppEndpointAddress = { kind: 'local', label: "On the host's computer", url: endpoint.localUrl }
  if (!endpoint.publicUrl) return [local]
  return [local, { kind: 'public', label: 'From anywhere', url: endpoint.publicUrl }]
}

/** The example in the "MCP address copied" toast: the Claude Code command that adds the host with this address. */
export function claudeMcpAddCommand(address: string): string {
  return `claude mcp add --transport http solus ${address}`
}

/** The countdown of a pairing code: "Expires 9:41 · one use". Null once it expired. */
export function pairingCodeCountdown(expiresAt: number, now: number): string | null {
  const msLeft = expiresAt - now
  if (msLeft <= 0) return null
  const totalSeconds = Math.ceil(msLeft / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `Expires ${minutes}:${seconds.toString().padStart(2, '0')} · one use`
}

/**
 * Which address an app gets (plans/035 §10). A cloud app, and every app on
 * another computer than the host, needs the public address. An app on the
 * host's own computer uses the local address: it needs no tunnel, and there the
 * owner can approve it in Solus. "Something else…" on the host's computer may be
 * either kind, so it gets the public address when there is one.
 */
export type OutsideAppAddressKind = 'public' | 'local' | 'public-or-local'

/** `guide` is null for "Something else…". `onHostComputer`: this client runs on the host's computer. */
export function outsideAppAddressKind(guide: Pick<OutsideAppGuide, 'needsPublicUrl'> | null, onHostComputer: boolean): OutsideAppAddressKind {
  if (!onHostComputer || guide?.needsPublicUrl) return 'public'
  return guide ? 'local' : 'public-or-local'
}

/** The address of that kind; null when it is the public one and the host has none. */
export function outsideAppAddress(kind: OutsideAppAddressKind, endpoint: AppEndpoint): string | null {
  switch (kind) {
    case 'public': return endpoint.publicUrl
    case 'local': return endpoint.localUrl
    case 'public-or-local': return endpoint.publicUrl ?? endpoint.localUrl
  }
}

/** The address "Copy MCP address" copies: the local one on the host's computer, else the public one; null when that is missing. */
export function copiedMcpAddress(endpoint: AppEndpoint, onHostComputer: boolean): string | null {
  return outsideAppAddress(onHostComputer ? 'local' : 'public', endpoint)
}

/** One access level a person can give an app, with what it lets the app do (docs/outside-apps.md, Access). */
export interface OutsideAppAccessLevel {
  access: AppAccess
  label: string
  effect: string
}

export const OUTSIDE_APP_ACCESS_LEVELS: readonly OutsideAppAccessLevel[] = [
  { access: 'read', label: appAccessLabel('read'), effect: 'Reads works, projects, tasks, automations, sessions, and pull requests. Changes nothing.' },
  { access: 'write', label: appAccessLabel('write'), effect: 'Also creates and changes records, starts, messages, and stops sessions, and reruns checks.' },
  { access: 'full', label: appAccessLabel('full'), effect: 'Also uses tools that ask for approval in Solus, such as running an automation or merging a pull request.' },
]

/** The level the Access step starts at. */
export const DEFAULT_OUTSIDE_APP_ACCESS: AppAccess = 'write'

/** The primary action of an app's setup, from its handoff, with the address filled in. */
export type OutsideAppAction =
  | {
    kind: 'open'
    label: string
    /** What is copied before the app opens, and the toast that says so. */
    copy: { text: string; title: string } | null
    /** The web page or app page the action opens. */
    link: string
    /** The app's own link, tried first. The page `link` is the way when nothing opens it. */
    appLink: string | null
  }
  | { kind: 'commands'; commands: readonly string[] }

export function outsideAppAction(guide: Pick<OutsideAppGuide, 'name' | 'handoff'>, mcpUrl: string): OutsideAppAction {
  const { handoff, name } = guide
  switch (handoff.kind) {
    case 'open':
      return { kind: 'open', label: `Add to ${name}`, copy: null, link: handoff.link(mcpUrl), appLink: null }
    case 'copy-url':
      return { kind: 'open', label: `Copy address and open ${name}`, copy: { text: mcpUrl, title: 'Address copied' }, link: handoff.link, appLink: null }
    case 'copy-message': {
      const message = handoff.message(mcpUrl)
      return { kind: 'open', label: `Copy message and open ${name}`, copy: { text: message, title: 'Message copied' }, link: handoff.link, appLink: handoff.appLink?.(message) ?? null }
    }
    case 'commands':
      return { kind: 'commands', commands: handoff.commands(mcpUrl) }
  }
}

/** One app in the picker, and why the person's organization does not allow it (null when it does). */
export interface OutsideAppChoice {
  guide: OutsideAppGuide
  denial: string | null
}

/** The apps a person picks from. A policy that names allowed apps marks the others; with no such rule every app is allowed. */
export function outsideAppChoices(policy: Pick<WorkPolicy, 'appDenial'>, guides: readonly OutsideAppGuide[] = OUTSIDE_APP_GUIDES): OutsideAppChoice[] {
  return guides.map((guide) => ({ guide, denial: policy.appDenial(guide.app)?.message ?? null }))
}

/** What opens a link: this client's `openExternal`, and on the web the page's own navigation. */
export interface LinkOpener {
  isWeb: boolean
  openExternal(url: string): Promise<boolean>
  /** Goes to an app link in this page; a new tab for it would stay blank. */
  assign(url: string): void
}

const WEB_PAGE = /^https?:\/\//i

/**
 * Opens an app's setup: its app link first, then its page. The desktop app
 * reports a link that nothing opens and falls back to the page. A browser
 * cannot tell, so it goes to the app link in place and the caller keeps the
 * page within reach. True when something opened, as far as this client knows.
 */
export async function openOutsideApp(action: { link: string; appLink: string | null }, opener: LinkOpener): Promise<boolean> {
  for (const url of action.appLink ? [action.appLink, action.link] : [action.link]) {
    if (opener.isWeb && !WEB_PAGE.test(url)) {
      opener.assign(url)
      return true
    }
    if (await opener.openExternal(url).catch(() => false)) return true
  }
  return false
}

/**
 * The toast action after a copy: the app's page, when this client cannot know
 * the app opened. A browser may block an open that follows a copy, and no
 * platform reliably reports an app link that nothing handles. Null on the
 * desktop app for a plain page, which it opens itself, and with no copy.
 */
export function outsideAppFallback(action: { link: string; appLink: string | null; copy: unknown }, name: string, isWeb: boolean): { label: string; link: string } | null {
  if (action.copy === null || (!isWeb && action.appLink === null)) return null
  return { label: action.appLink === null ? `Open ${name}` : `Get ${name}`, link: action.link }
}

/** What finds "Use Solus in other apps" in the palette: MCP words, and the name of each app it sets up. */
export function outsideAppsKeywords(guides: readonly OutsideAppGuide[] = OUTSIDE_APP_GUIDES): string[] {
  return ['mcp', 'connector', 'another app', 'outside app', 'connect app', 'pairing code', ...guides.map((guide) => guide.name.toLowerCase())]
}
