import { readHostHealth } from '@solus/client-core/host-link'
import { urlHost } from '@solus/client-core/pairing'
import type { HostOperatingSystem } from '@solus/contracts/types'

/**
 * The pairing bridge: this device and the host it is pairing with, joined by a
 * line that shows how far the pairing has come. Every pairing surface (Add
 * server, the web setup surface, host onboarding) draws the same one.
 *
 * - `empty`: no host named yet.
 * - `looking`: the host's `/health` is being read.
 * - `found`: the host is known; nothing is running.
 * - `pairing`: the `/pair` exchange is running.
 * - `paired` and `error`: how it ended.
 */
export type PairingPhase = 'empty' | 'looking' | 'found' | 'pairing' | 'paired' | 'error'

export interface BridgeMachine {
  name: string
  /** Absent when the machine did not say: the bridge draws a globe. */
  os?: HostOperatingSystem
}

const OS_NAMES = { macos: 'macOS', windows: 'Windows', linux: 'Linux' } satisfies Record<HostOperatingSystem, string>

export function operatingSystemName(os: HostOperatingSystem | undefined): string {
  return os ? OS_NAMES[os] : ''
}

/** The one line under the bridge. An error's reason is the surface's to show. */
export function pairingStatusLine(phase: PairingPhase, hostName: string): string {
  switch (phase) {
    case 'looking': return 'Looking up host…'
    case 'found': return 'Ready to pair'
    case 'pairing': return `Pairing with ${hostName}…`
    case 'paired': return `Paired with ${hostName}`
    case 'error': return 'Couldn’t pair'
    default: return ''
  }
}

const DESKTOP_OS = new Map<string, HostOperatingSystem>([['darwin', 'macos'], ['win32', 'windows'], ['linux', 'linux']])

/**
 * This device, as the left side of the bridge. The desktop app reports its
 * platform; a browser is read from its user agent.
 */
export function thisDevice(platform: string, userAgent: string): BridgeMachine {
  const os = platform === 'web' ? browserOs(userAgent) : DESKTOP_OS.get(platform)
  if (/iPhone/.test(userAgent)) return { name: 'This iPhone', os }
  if (/iPad/.test(userAgent)) return { name: 'This iPad', os }
  return { name: os === 'macos' ? 'This Mac' : platform === 'web' ? 'This browser' : 'This PC', os }
}

function browserOs(userAgent: string): HostOperatingSystem | undefined {
  if (/Android/.test(userAgent)) return undefined
  if (/Mac OS|iPhone|iPad/.test(userAgent)) return 'macos'
  if (/Windows/.test(userAgent)) return 'windows'
  if (/Linux/.test(userAgent)) return 'linux'
  return undefined
}

const LOOKUP_TIMEOUT_MS = 3_000

/**
 * The host behind an address, from one `/health` read. A host reached through
 * its tunnel keeps its name and OS to itself, and an address that does not
 * answer says nothing: both fall back to the address, and pairing says the rest.
 */
export async function lookUpHost(url: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<BridgeMachine> {
  const health = await readHostHealth(fetchImpl, url, AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]))
  // A reply through a tunnel leaves the name out: the address stands in for it.
  return health ? { name: health.name || urlHost(url), os: health.os } : { name: urlHost(url) }
}

/** Where a pairing surface stands, from what it knows. */
export function pairingPhase(state: {
  targetUrl: string
  host: BridgeMachine | null
  isPairing: boolean
  isPaired: boolean
  /** The address the last attempt failed on; a new address clears the failure. */
  failedUrl: string | null
}): PairingPhase {
  if (state.isPaired) return 'paired'
  if (state.isPairing) return 'pairing'
  if (state.failedUrl !== null && state.failedUrl === state.targetUrl) return 'error'
  if (!state.targetUrl) return 'empty'
  return state.host ? 'found' : 'looking'
}

/**
 * How long a surface that leaves on success holds the paired bridge, so the
 * person sees it land. Reduced motion has nothing to watch.
 */
export function pairedHoldMs(): number {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 900
}
