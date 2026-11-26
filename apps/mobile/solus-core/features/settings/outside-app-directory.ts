import type { AppAccess } from '@solus/contracts/host-api'
import type { OutsideAppGuide } from '@solus/contracts/outside-apps'
import { relativeTime } from '../../lib/time'
import type { ConnectedApp, HostAppPairCode } from './host-access'
import { appAccessLabel, PHONE_APP_GUIDES } from './outside-app-setup'

/**
 * The directory of outside apps on the phone's Sharing & access page (plans/035
 * §10): each cloud app with its logo, a short line, and what a tap does. A
 * connected app opens its facts and Disconnect; the others open the Connect
 * sheet, or the ways to give the host an internet address when it has none.
 */

/** The short line under each cloud app, by guide id. */
const APP_LINES = new Map([
  ['claude', 'Anthropic'],
  ['chatgpt', 'OpenAI'],
  ['grok-bot', 'xAI'],
  ['poke', 'Text messages'],
  ['muse', 'Meta'],
  ['instinct', 'Personal assistant'],
])

/** Who makes a cloud app, or what it is: the line under its name. */
export function appMakerLine(guideId: string): string {
  return APP_LINES.get(guideId) ?? ''
}

export type OutsideAppRowStatus = 'connect' | 'needs-address' | 'connected'

export interface OutsideAppRow {
  key: string
  name: string
  /** The line under the name: who makes the app, or "Connected". */
  line: string
  /** The id the logo is kept by; null for an app the phone has no logo for. */
  logoId: string | null
  /** The guide that connects the app; null for an app connected from a computer. */
  guide: OutsideAppGuide | null
  status: OutsideAppRowStatus
  /** The grants that Disconnect revokes, newest use first. Empty unless connected. */
  grants: ConnectedApp[]
}

/**
 * One row for each cloud app, then one for each other app that is still
 * connected (such as Cursor or Claude Code, connected from a computer), so the
 * owner can see and disconnect it here too. `apps` is null when the person may
 * not read the grants. `hasInternetAddress` is null until the host told its addresses.
 */
export function outsideAppDirectory(input: {
  apps: readonly ConnectedApp[] | null
  hasInternetAddress: boolean | null
}): OutsideAppRow[] {
  const apps = [...(input.apps ?? [])].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  const guideRows = PHONE_APP_GUIDES.map((guide): OutsideAppRow => {
    const grants = apps.filter((app) => app.app.appId === guide.app)
    const status: OutsideAppRowStatus = grants.length > 0 ? 'connected' : input.hasInternetAddress === false ? 'needs-address' : 'connect'
    return {
      key: guide.id,
      name: guide.name,
      line: status === 'connected' ? 'Connected' : appMakerLine(guide.id),
      logoId: guide.id,
      guide,
      status,
      grants,
    }
  })
  const guideApps = new Set(PHONE_APP_GUIDES.map((guide) => guide.app))
  const otherRows = apps
    .filter((app) => !guideApps.has(app.app.appId))
    .map((app): OutsideAppRow => ({
      key: app.deviceId,
      name: app.deviceLabel,
      line: 'Connected',
      logoId: null,
      guide: null,
      status: 'connected',
      grants: [app],
    }))
  return [...guideRows, ...otherRows]
}

export interface ConnectedAppFact {
  label: string
  value: string
}

/**
 * What the manage sheet says about a connected app: when it first signed in,
 * when it last used the host, and what it can do. With several sign-ins, the
 * newest use speaks for the app. The host writes `lastSeenAt` at most once a
 * minute, so an app that has not come back since its approval still has the
 * time of its approval there.
 */
export function connectedAppFacts(grants: readonly ConnectedApp[], now: number): ConnectedAppFact[] {
  const latest = grants.reduce<ConnectedApp | null>((newest, app) => (newest === null || app.lastSeenAt > newest.lastSeenAt ? app : newest), null)
  if (latest === null) return []
  const first = Math.min(...grants.map((app) => app.pairedAt))
  return [
    { label: 'Connected', value: dayOf(first) },
    {
      label: 'Last used',
      value: latest.lastSeenAt > latest.pairedAt ? `${relativeTime(new Date(latest.lastSeenAt).toISOString(), now)} ago` : 'Not yet',
    },
    { label: 'Can', value: appAccessLabel(latest.app.access) },
  ]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "12 Nov", in the phone's time zone. */
function dayOf(time: number): string {
  const date = new Date(time)
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
}

/** The question before Disconnect. */
export function disconnectQuestion(name: string, grantCount: number) {
  return {
    title: `Disconnect ${name}?`,
    message: grantCount > 1
      ? `Each of its ${grantCount} sign-ins loses access to this host at once. ${name} must sign in again to use it.`
      : `It loses access to this host at once. ${name} must sign in again to use it.`,
  }
}

/** The code on the Connect sheet. */
export type ConnectCode =
  | { kind: 'none' }
  | { kind: 'live'; code: string; timeLeft: string }
  | { kind: 'expired' }

/**
 * The code the Connect sheet shows: only a code made after the sheet opened
 * (`before` is the code the host had then), for the access now chosen, and not
 * while a new one is made.
 */
export function connectCode(input: {
  current: HostAppPairCode | null
  before: HostAppPairCode | null
  access: AppAccess
  isBusy: boolean
  now: number
}): ConnectCode {
  const { current } = input
  if (input.isBusy || current === null || current === input.before || current.access !== input.access) return { kind: 'none' }
  const timeLeft = appCodeTimeLeft(current.expiresAt, input.now)
  return timeLeft === null ? { kind: 'expired' } : { kind: 'live', code: current.code, timeLeft }
}

/** "9:12 left", or null once the code expired. */
export function appCodeTimeLeft(expiresAt: number, now: number): string | null {
  const seconds = Math.ceil((expiresAt - now) / 1000)
  if (seconds <= 0) return null
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`
}

/**
 * The sign-in of this app that came after the Connect sheet opened, once the host
 * lists it. `known` holds the grants the host listed then; the host's clock and
 * the phone's may differ, so times are not compared.
 */
export function newSignInOf(apps: readonly ConnectedApp[], guide: OutsideAppGuide, known: ReadonlySet<string>): ConnectedApp | null {
  return apps.find((app) => app.app.appId === guide.app && !known.has(app.deviceId)) ?? null
}
