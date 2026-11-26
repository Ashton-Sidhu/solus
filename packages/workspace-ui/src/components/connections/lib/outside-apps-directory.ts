import type { AppAddress, PairedDevice } from '@solus/contracts/host-api'
import { OUTSIDE_APP_GUIDES, type OutsideAppGuide } from '@solus/contracts/outside-apps'
import { matchesSearch } from '../../../lib/search-match'
import { relativeTime } from '../../../lib/relative-time'
import { preferredAppAddress } from './app-addresses'
import { appAccessLabel, hasAppConnected } from './paired-devices'

/**
 * The directory of "Use Solus from your other apps" on Settings › Sharing &
 * access (plans/035 §10): every app of the catalog in two columns, with what
 * each row shows, and the apps that already signed in ("grants").
 */

/** The short line under each app's name. */
const APP_LINES = {
  claude: 'Anthropic · web, desktop, phone',
  chatgpt: 'OpenAI · custom connector',
  'grok-bot': 'xAI · on your phone',
  poke: 'Assistant over text messages',
  muse: 'Meta’s personal agent',
  instinct: 'Personal assistant',
  cursor: 'Editor · installs in one click',
} satisfies Partial<Record<string, string>>

const hasLine = (guideId: string): guideId is keyof typeof APP_LINES => Object.hasOwn(APP_LINES, guideId)

/** The line of "Another MCP app", the last row: an app with no guide. */
export const OTHER_APP_LINE = 'Anything that adds a remote MCP server'

export function outsideAppLine(guide: Pick<OutsideAppGuide, 'id' | 'app'>): string {
  if (hasLine(guide.id)) return APP_LINES[guide.id]
  return guide.app === 'local' ? 'Terminal agent' : 'MCP app'
}

/** The two columns: cloud apps (they need an internet address) on the left, apps on a computer on the right. */
export interface DirectoryColumns {
  cloud: OutsideAppGuide[]
  computer: OutsideAppGuide[]
}

export function directoryColumns(guides: readonly OutsideAppGuide[] = OUTSIDE_APP_GUIDES): DirectoryColumns {
  return {
    cloud: guides.filter((guide) => guide.needsPublicUrl),
    computer: guides.filter((guide) => !guide.needsPublicUrl),
  }
}

/** The search field finds an app by its name or its line. */
export function guideMatchesSearch(guide: Pick<OutsideAppGuide, 'id' | 'app' | 'name'>, search: string): boolean {
  return matchesSearch(`${guide.name} ${outsideAppLine(guide)}`, search)
}

/** An outside app that signed in to the host and still has access. */
export type AppGrant = PairedDevice & { app: NonNullable<PairedDevice['app']> }

/** The grants among the host's paired devices: apps only, revoked ones left out. */
export function activeGrants(devices: readonly PairedDevice[]): AppGrant[] {
  return devices.filter((device): device is AppGrant => !!device.app && device.revokedAt === null)
}

/** The grants of each guide, newest first, and the grants that match no guide. */
export interface GrantMatch {
  byGuide: Map<string, AppGrant[]>
  unmatched: AppGrant[]
}

const searchKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Which guide a grant belongs to. A cloud app and Cursor have their own app id.
 * Claude Code, Codex, OpenClaw, and Hermes Agent all sign in as `local`: the
 * grant goes to the guide whose name its label holds (whole name first, then
 * the first word), else to the first `local` guide. An app Solus cannot name
 * (`other`) matches no guide.
 */
export function matchGrants(grants: readonly AppGrant[], guides: readonly OutsideAppGuide[] = OUTSIDE_APP_GUIDES): GrantMatch {
  const byGuide = new Map<string, AppGrant[]>()
  const unmatched: AppGrant[] = []
  const localGuides = guides.filter((guide) => guide.app === 'local')
  for (const grant of [...grants].sort((a, b) => b.pairedAt - a.pairedAt)) {
    const guide = grant.app.appId === 'local' ? localGuideOf(grant.deviceLabel, localGuides) : guides.find((candidate) => candidate.app === grant.app.appId)
    if (!guide) {
      unmatched.push(grant)
      continue
    }
    const list = byGuide.get(guide.id)
    if (list) list.push(grant)
    else byGuide.set(guide.id, [grant])
  }
  return { byGuide, unmatched }
}

function localGuideOf(label: string, localGuides: readonly OutsideAppGuide[]): OutsideAppGuide | undefined {
  const key = searchKey(label)
  return localGuides.find((guide) => key.includes(searchKey(guide.name)))
    ?? localGuides.find((guide) => key.includes(searchKey(guide.name.split(' ')[0] ?? '')))
    ?? localGuides[0]
}

/** True when the host has an address on the internet; null until its addresses are read. */
export function hasInternetAddress(endpoint: { addresses: readonly AppAddress[] } | null): boolean | null {
  return endpoint ? preferredAppAddress(endpoint.addresses, 'internet') !== null : null
}

/**
 * What the right side of a row shows:
 * - `connect`: the Connect button ("Set up" for Another MCP app);
 * - `connected`: the app signed in and reaches the host;
 * - `needs-address`: a cloud app, and the host has no internet address;
 * - `cant-reach`: a cloud app signed in, and the host has no internet address now;
 * - `not-allowed`: the person's organization does not allow the app.
 */
export type AppRowState = 'connect' | 'connected' | 'needs-address' | 'cant-reach' | 'not-allowed'

export function appRowState(input: { needsPublicUrl: boolean; hasGrant: boolean; hasInternetAddress: boolean | null; isDenied: boolean }): AppRowState {
  const isCut = input.needsPublicUrl && input.hasInternetAddress === false
  if (input.hasGrant) return isCut ? 'cant-reach' : 'connected'
  if (input.isDenied) return 'not-allowed'
  return isCut ? 'needs-address' : 'connect'
}

/** The facts card of a connected app. The host does not record who approved a sign-in, so it is not shown. */
export interface GrantFacts {
  connected: string
  lastUsed: string
  access: string
}

export function grantFacts(grant: AppGrant, now = Date.now()): GrantFacts {
  return {
    connected: new Date(grant.pairedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    lastUsed: hasAppConnected(grant) ? relativeTime(grant.lastSeenAt, now) : 'Not used yet',
    access: appAccessLabel(grant.app.access),
  }
}

/** A grant that came after the row opened: the app signed in. */
export function hasNewGrant(grantIdsAtOpen: ReadonlySet<string>, grants: readonly AppGrant[]): boolean {
  return grants.some((grant) => !grantIdsAtOpen.has(grant.deviceId))
}

/** "Copy commands" copies them one to a line. */
export function commandsText(commands: readonly string[]): string {
  return commands.join('\n')
}
