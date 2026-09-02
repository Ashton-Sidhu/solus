import type { HostRoute, UplinkStatus } from '@solus/contracts/uplink'

/** The one-word route badges a host row shows: `direct`, `tunnel`, or both. */
export function routeBadges(routes: HostRoute[]): string[] {
  const badges: string[] = []
  if (routes.some((route) => route.kind !== 'tunnel')) badges.push('direct')
  if (routes.some((route) => route.kind === 'tunnel')) badges.push('tunnel')
  return badges
}

/** The one line under the Solus cloud control on a host's Access tab. */
export function uplinkStatusDescription(status: UplinkStatus | undefined): string {
  if (!status) return 'Checking the link…'
  if (!status.linked) {
    return 'Reach this host from your other devices through your Solus account. It stays available on your local network either way.'
  }
  const { hostname } = status.link
  switch (status.state.observed) {
    case 'online': return `Reachable at ${hostname} · tunnel online`
    case 'offline': return `Reachable at ${hostname} · tunnel offline`
    case 'error': return `${hostname} · ${status.state.error ?? 'tunnel error'}`
  }
}
