import { urlHost } from '@solus/client-core/pairing'
import type { EnvironmentMachineKind } from '../../../components/EnvironmentMachineSymbol'
import type { NativeHost } from '../../hosts/host-registry'

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
