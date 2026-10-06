import { urlHost } from '@solus/client-core/pairing'
import type { EnvironmentMachineKind } from '../../../components/EnvironmentMachineSymbol'
import type { HostConnectionState } from '../../hosts/host-connections'
import type { NativeHost } from '../../hosts/host-registry'

/**
 * Solus host connection state in the shape T3 Code's connection rows read
 * (`features/connection`, MIT, see UPSTREAM.md): the dot's state, the status
 * line under the label, and whether that line is a failure.
 */

/** T3's `RemoteClientConnectionState`. */
export type ConnectionStatusDotState =
  | 'available'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
  | 'offline'
  | 'error'
  | 'unsupported'

export interface HostConnectionStatus {
  dot: ConnectionStatusDotState
  text: string
  failed: boolean
  retrying: boolean
  /** Dialing again now can help: the host is not connected and is not refused or stopped. */
  retryable?: boolean
}

export function hostConnectionStatus(host: NativeHost, state: HostConnectionState | null): HostConnectionStatus {
  if (!state) return { dot: 'available', text: 'Not connected', failed: false, retrying: false, retryable: true }
  switch (state.phase) {
    case 'connected': return { dot: 'connected', text: 'Connected', failed: false, retrying: false }
    case 'connecting': return { dot: 'connecting', text: 'Connecting…', failed: false, retrying: true }
    case 'reconnecting': return { dot: 'reconnecting', text: 'Reconnecting…', failed: false, retrying: true }
    case 'offline': return { dot: 'offline', text: 'Offline. Solus keeps trying.', failed: true, retrying: false, retryable: true }
    case 'waiting-for-compute': return { dot: 'available', text: 'Host is not running', failed: false, retrying: false }
    case 'no-route': return { dot: 'available', text: 'No address yet', failed: false, retrying: false }
    case 'blocked':
      return {
        dot: 'error',
        text: state.blockedReason === 'identity-mismatch'
          ? 'A different machine answered at this address'
          : host.paired ? 'Access ended. Pair again.' : 'Access refused',
        failed: true,
        retrying: false,
      }
  }
}

/** The glyph a host wears in lists. Solus knows the operating system, not the machine. */
export function hostMachineKind(host: NativeHost): EnvironmentMachineKind {
  if (host.uplink?.kind === 'managed') return 'cloud'
  if (host.os === 'linux') return 'linux'
  return 'desktop'
}

/** The address a paired host was reached at; a Solus Cloud host has none to show. */
export function hostDisplayAddress(host: NativeHost): string | null {
  const direct = host.routes.find((route) => route.kind === 'direct')
  return direct ? urlHost(direct.url) : null
}
