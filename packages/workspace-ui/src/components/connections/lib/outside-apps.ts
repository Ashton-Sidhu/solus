import type { AppEndpoint } from '../../../contexts/connections/connections.store.svelte'
import type { AppAccess, AppAddress } from '@solus/contracts/host-api'
import type { WorkPolicy } from '@solus/contracts/host-policies'
import { OUTSIDE_APP_GUIDES, type OutsideAppGuide } from '@solus/contracts/outside-apps'
import { preferredAppAddress } from './app-addresses'
import { appAccessLabel } from './paired-devices'

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
 * Which address an app gets (plans/035 §0.8, §10):
 * - `internet`: a cloud app needs an address on the internet (Solus Cloud, Tailscale Funnel, or the person's own).
 * - `internet-or-tailnet`: an app on another computer than the host can also use Tailscale Serve on the tailnet.
 * - `local`: an app on the host's own computer uses the local address. It needs no other address, and there the owner can approve it in Solus.
 * - `any-or-local`: "Something else…" on the host's computer may be either kind, so it gets another address when there is one, else the local one.
 */
export type OutsideAppAddressKind = 'internet' | 'internet-or-tailnet' | 'local' | 'any-or-local'

/** `guide` is null for "Something else…". `onHostComputer`: this client runs on the host's computer. */
export function outsideAppAddressKind(guide: Pick<OutsideAppGuide, 'needsPublicUrl'> | null, onHostComputer: boolean): OutsideAppAddressKind {
  if (guide?.needsPublicUrl) return 'internet'
  if (!onHostComputer) return 'internet-or-tailnet'
  return guide ? 'local' : 'any-or-local'
}

/** The address an app uses, and which of the host's addresses it is (null: the local one). */
export interface ChosenAppAddress {
  url: string
  address: AppAddress | null
}

/** The address of that kind, in the order of preference; null when the host has none that the app reaches. */
export function outsideAppAddress(kind: OutsideAppAddressKind, endpoint: AppEndpoint): ChosenAppAddress | null {
  const local: ChosenAppAddress = { url: endpoint.localUrl, address: null }
  const chosen = (address: AppAddress | null): ChosenAppAddress | null => (address ? { url: address.url, address } : null)
  switch (kind) {
    case 'local': return local
    case 'internet': return chosen(preferredAppAddress(endpoint.addresses, 'internet'))
    case 'internet-or-tailnet': return chosen(preferredAppAddress(endpoint.addresses, 'internet-or-tailnet'))
    case 'any-or-local': return chosen(preferredAppAddress(endpoint.addresses, 'internet-or-tailnet')) ?? local
  }
}

/** The address "Copy MCP address" copies: the local one on the host's computer, else one another computer reaches; null when there is none. */
export function copiedMcpAddress(endpoint: AppEndpoint, onHostComputer: boolean): string | null {
  return outsideAppAddress(onHostComputer ? 'local' : 'internet-or-tailnet', endpoint)?.url ?? null
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
