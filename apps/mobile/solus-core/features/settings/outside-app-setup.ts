import type { AppAccess, ConnectionsServerInfo } from '@solus/contracts/host-api'
import { OUTSIDE_APP_GUIDES, type OutsideAppGuide } from '@solus/contracts/outside-apps'

/**
 * How a person connects an outside app to a host from the phone (plans/035 §10),
 * with the catalog that desktop and web use (`OUTSIDE_APP_GUIDES`).
 *
 * The phone offers the apps that run in a browser or a cloud service (each guide
 * with `needsPublicUrl`): the phone can open their pages and paste in them. Apps
 * that run on a computer (Cursor, Claude Code, Codex, and the others) need that
 * computer: the phone cannot open them or run their commands, so the person sets
 * them up from Solus there.
 */
export const PHONE_APP_GUIDES: readonly OutsideAppGuide[] = OUTSIDE_APP_GUIDES.filter((guide) => guide.needsPublicUrl)

/** What a pairing code lets the app do, as `docs/outside-apps.md` (Access) says. Read and write is the default. */
export const APP_ACCESS_OPTIONS: readonly { access: AppAccess; label: string; phrase: string }[] = [
  { access: 'read', label: 'Read', phrase: 'read' },
  { access: 'write', label: 'Read and write', phrase: 'read and write' },
  { access: 'full', label: 'Full', phrase: 'do everything you can' },
]

/** The level as the access sentence says it: "Claude can <phrase> on Build Mac". */
export function appAccessPhrase(access: AppAccess): string {
  return APP_ACCESS_OPTIONS.find((option) => option.access === access)?.phrase ?? access
}
export const DEFAULT_APP_ACCESS: AppAccess = 'write'

export function appAccessLabel(access: AppAccess): string {
  return APP_ACCESS_OPTIONS.find((option) => option.access === access)?.label ?? access
}

/** The one line under the access switch of the Connect sheet: what this app can and cannot do. */
export function appAccessLine(access: AppAccess, appName: string): string {
  switch (access) {
    case 'read': return `${appName} can read sessions, works, and tasks. It can’t change anything.`
    case 'write': return `${appName} can start and message sessions. It can’t merge or change settings.`
    case 'full': return `${appName} can also change works, run automations, and merge pull requests.`
  }
}

/** The one action that hands the host's address to an app: copy a text, then open the first link that opens. */
export interface AppSetupAction {
  label: string
  /** What goes on the clipboard first; null when the link carries the address. */
  copyText: string | null
  /** What the notice says once the copy landed; null when nothing is copied. */
  copiedNotice: string | null
  /** The links to try in order: the app itself before its web page. */
  links: readonly string[]
  /** The app's web page: the way through when its own link opens nothing. Null for commands. */
  page: string | null
}

export type AppSetup =
  | { kind: 'needs-public-url' }
  | { kind: 'ready'; action: AppSetupAction; /** The chat message to send, shown so the person sees it. */ message: string | null }

/** An app that needs a public address has no setup on a host without one. */
export function appSetup(guide: OutsideAppGuide, publicUrl: string | null): AppSetup {
  if (!publicUrl) return { kind: 'needs-public-url' }
  const handoff = guide.handoff
  switch (handoff.kind) {
    case 'open': {
      const link = handoff.link(publicUrl)
      return { kind: 'ready', message: null, action: { label: `Add to ${guide.name}`, copyText: null, copiedNotice: null, links: [link], page: link } }
    }
    case 'copy-url':
      return { kind: 'ready', message: null, action: { label: `Copy address and open ${guide.name}`, copyText: publicUrl, copiedNotice: 'Address copied', links: [handoff.link], page: handoff.link } }
    case 'copy-message': {
      const message = handoff.message(publicUrl)
      const links = handoff.appLink ? [handoff.appLink(message), handoff.link] : [handoff.link]
      return { kind: 'ready', message, action: { label: `Copy message and open ${guide.name}`, copyText: message, copiedNotice: 'Message copied', links, page: handoff.link } }
    }
    case 'commands':
      return { kind: 'ready', message: null, action: { label: 'Copy commands', copyText: handoff.commands(publicUrl).join('\n'), copiedNotice: 'Commands copied', links: [], page: null } }
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
