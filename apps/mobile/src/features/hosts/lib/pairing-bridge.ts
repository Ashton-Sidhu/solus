import type { HostOperatingSystem } from '@solus/contracts/types'

/**
 * The pairing bridge between this device and the host, in the same phases as
 * the desktop and web pairing stage: no host yet, the host's `/health` read,
 * the host known, the `/pair` exchange, and its outcome.
 */
export type PairingPhase = 'empty' | 'looking' | 'found' | 'pairing' | 'paired' | 'error'

/** What the pairing screen is doing now, apart from which host it shows. */
export type PairingStep = 'idle' | 'looking' | 'pairing' | 'paired' | 'failed'

/** How long the paired state stays on screen before Home, so the person sees it land. */
export const PAIRED_HOLD_MS = 900

export function pairingPhase(step: PairingStep, hasHost: boolean): PairingPhase {
  if (!hasHost) return step === 'looking' ? 'looking' : 'empty'
  if (step === 'pairing') return 'pairing'
  if (step === 'paired') return 'paired'
  if (step === 'failed') return 'error'
  return 'found'
}

/** The screen's controls wait while a read or an exchange runs, and after success. */
export function isPairingBusy(step: PairingStep): boolean {
  return step === 'looking' || step === 'pairing' || step === 'paired'
}

/** With reduced motion there is nothing to watch, so Home opens at once. */
export function pairedHoldMs(reduceMotion: boolean): number {
  return reduceMotion ? 0 : PAIRED_HOLD_MS
}

/** The line under the bridge. The reason for a failure stays in the screen's error banner. */
export function pairingStatusLine(phase: PairingPhase, hostName: string | null): string | null {
  switch (phase) {
    case 'empty':
      return null
    case 'looking':
      return 'Looking up host…'
    case 'found':
      return 'Ready to pair'
    case 'pairing':
      return `Pairing with ${hostName ?? 'host'}…`
    case 'paired':
      return `Paired with ${hostName ?? 'host'}`
    case 'error':
      return "Couldn't pair"
  }
}

export const OS_LABELS = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
} satisfies Record<HostOperatingSystem, string>

export interface BridgeColumnLabel {
  readonly name: string
  /** Empty while unknown; the line keeps its height so both tiles stay level. */
  readonly sub: string
}

export function thisDeviceLabel(platform: 'ios' | 'android', isPad: boolean): BridgeColumnLabel {
  if (platform === 'android') return { name: 'This phone', sub: 'Android' }
  return { name: isPad ? 'This iPad' : 'This iPhone', sub: 'iOS' }
}

export function hostColumnLabel(host: { readonly name: string; readonly os?: HostOperatingSystem } | null): BridgeColumnLabel {
  if (!host) return { name: 'New host', sub: '' }
  return { name: host.name, sub: host.os ? OS_LABELS[host.os] : '' }
}
