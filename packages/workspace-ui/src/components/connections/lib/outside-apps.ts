import type { AppEndpoint } from '../../../contexts/connections/connections.store.svelte'
import type { WorkPolicy } from '@solus/contracts/host-policies'
import { OUTSIDE_APP_GUIDES, type OutsideAppGuide } from '@solus/contracts/outside-apps'

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

/** The Claude Code command that adds the host as an MCP server. It uses the public address when there is one, as it works from every computer. */
export function claudeMcpAddCommand(endpoint: AppEndpoint): string {
  return `claude mcp add --transport http solus ${endpoint.publicUrl ?? endpoint.localUrl}`
}

/** When a pairing code stops working: "Expires in 9:41", or "Expired". */
export function pairingCodeExpiry(expiresAt: number, now: number): string {
  const msLeft = expiresAt - now
  if (msLeft <= 0) return 'Expired'
  const totalSeconds = Math.ceil(msLeft / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `Expires in ${minutes}:${seconds.toString().padStart(2, '0')}`
}

/** The address an app gets: a cloud app only the public one, any other app the public one when there is one, as it works from every computer. Null when the app needs a public address and the host has none. */
export function outsideAppAddress(guide: Pick<OutsideAppGuide, 'needsPublicUrl'>, endpoint: AppEndpoint): string | null {
  return guide.needsPublicUrl ? endpoint.publicUrl : endpoint.publicUrl ?? endpoint.localUrl
}

/** The primary action of an app's setup, from its handoff, with the address filled in. */
export type OutsideAppAction =
  | {
    kind: 'open'
    label: string
    /** What is copied before the app opens, and the line that says so. */
    copy: { text: string; done: string } | null
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
      return { kind: 'open', label: `Copy address and open ${name}`, copy: { text: mcpUrl, done: 'The address is copied. Paste it in the form that opened.' }, link: handoff.link, appLink: null }
    case 'copy-message': {
      const message = handoff.message(mcpUrl)
      return { kind: 'open', label: `Copy message and open ${name}`, copy: { text: message, done: `The message is copied. Send it in ${name}.` }, link: handoff.link, appLink: handoff.appLink?.(message) ?? null }
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
 * The app's page, offered after the handoff when this client cannot know it
 * reached the app: a browser cannot tell whether an app link opened, and may
 * block an open that follows a copy. Null where the open is known.
 */
export function outsideAppFallbackLink(action: { link: string; appLink: string | null; copy: unknown }, isWeb: boolean): string | null {
  return isWeb && (action.appLink !== null || action.copy !== null) ? action.link : null
}
