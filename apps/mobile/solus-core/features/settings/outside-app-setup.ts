import type { ConnectionsServerInfo, PairedDevice } from '@solus/contracts/host-api'
import { OUTSIDE_APP_GUIDES, OUTSIDE_APP_NAMES, type OutsideAppGuide } from '@solus/contracts/outside-apps'

/**
 * How a person connects an outside app to a host from the phone (plans/035 §10),
 * with the catalog that desktop and web use (`OUTSIDE_APP_GUIDES`).
 *
 * The phone offers the apps that run in a browser or a cloud service (Claude,
 * ChatGPT, Grok Bot, Poke): the phone can open their pages and paste in them.
 * Cursor, Claude Code, and Codex run on a computer: the phone cannot open them
 * or run their commands, so the person sets them up from Solus on that computer.
 */
export const PHONE_APP_GUIDES: readonly OutsideAppGuide[] = OUTSIDE_APP_GUIDES.filter((guide) => guide.needsPublicUrl)

/** The one action that hands the host's address to an app: copy a text, then open the first link that opens. */
export interface AppSetupAction {
  label: string
  /** What goes on the clipboard first; null when the link carries the address. */
  copyText: string | null
  /** The links to try in order: the app itself before its web page. */
  links: readonly string[]
}

export type AppSetup =
  | { kind: 'needs-public-url' }
  | { kind: 'ready'; action: AppSetupAction; /** The chat message to send, shown so the person sees it. */ message: string | null }

/** An app that needs a public address has no setup on a host without one. */
export function appSetup(guide: OutsideAppGuide, publicUrl: string | null): AppSetup {
  if (!publicUrl) return { kind: 'needs-public-url' }
  const handoff = guide.handoff
  switch (handoff.kind) {
    case 'open':
      return { kind: 'ready', message: null, action: { label: `Open ${guide.name}`, copyText: null, links: [handoff.link(publicUrl)] } }
    case 'copy-url':
      return { kind: 'ready', message: null, action: { label: `Copy address and open ${guide.name}`, copyText: publicUrl, links: [handoff.link] } }
    case 'copy-message': {
      const message = handoff.message(publicUrl)
      const links = handoff.appLink ? [handoff.appLink(message), handoff.link] : [handoff.link]
      return { kind: 'ready', message, action: { label: `Copy message and open ${guide.name}`, copyText: message, links } }
    }
    case 'commands':
      return { kind: 'ready', message: null, action: { label: 'Copy commands', copyText: handoff.commands(publicUrl).join('\n'), links: [] } }
  }
}

/** Opens the first link that opens: an app link fails when its app is not installed. Throws the last failure. */
export async function openFirstLink(links: readonly string[], open: (url: string) => Promise<void>): Promise<void> {
  let failure = new Error('No link to open.')
  for (const link of links) {
    try {
      await open(link)
      return
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw failure
}

/**
 * Any person who uses the host connects apps that act as them: its owner, or a
 * member of its organization (`connectionsCreateAppPairingCode` needs `host.use`).
 * A guest does not, and the organization's workspace service is not a machine.
 */
export function showsOutsideApps(info: Pick<ConnectionsServerInfo, 'principal' | 'hostKind'>): boolean {
  return info.hostKind !== 'api' && (info.principal === 'local-owner' || info.principal === 'remote-owner' || info.principal === 'org-member')
}

/** The name of the app a grant came from, to show beside its label; null when the label already says it or the host is older. */
export function connectedAppName(app: Pick<PairedDevice, 'deviceLabel' | 'app'>): string | null {
  if (!app.app) return null
  const name: string | undefined = OUTSIDE_APP_NAMES[app.app.appId]
  return name && name !== app.deviceLabel ? name : null
}
