import { urlHost } from '@solus/client-core/pairing'
import { routesFrom } from '@solus/contracts/host-routes'
import type { EnvironmentMachineKind } from '../../../components/EnvironmentMachineSymbol'
import type { NativeHost } from '../../hosts/host-registry'

/** The glyph a host wears in lists. Solus knows the operating system, not the machine. */
export function hostMachineKind(host: NativeHost): EnvironmentMachineKind {
  if (host.uplink?.kind === 'managed') return 'cloud'
  if (host.os === 'linux') return 'linux'
  return 'desktop'
}

/** The address a paired host was reached at, else one on a shared network; a host reached only through Solus Cloud has none to show. */
export function hostDisplayAddress(host: NativeHost): string | null {
  const address = routesFrom(host.routes, 'pairing')[0] ?? host.routes.find((route) => route.kind === 'lan' || route.kind === 'tailnet')
  return address ? urlHost(address.url) : null
}
