import type { UplinkStatus } from '@solus/contracts/uplink'

/** The host's page on the account website, where the owner shares it with a team. */
export function hostWebsiteUrl(directoryUrl: string, hostId: string): string {
  return `${directoryUrl.replace(/\/$/, '')}/hosts/${encodeURIComponent(hostId)}`
}

/**
 * The line under "Registered to your account" (docs/adr/0001-standard-authentication.md
 * §2.2 rule 8): whose account the host belongs to, or why it is not registered.
 */
export function registrationDescription(status: UplinkStatus | undefined): string {
  if (!status) return 'Checking the registration…'
  const { registration } = status
  if (!registration.registered) {
    return 'Signing in registers this host to your account, so your account and your organizations work here. It stays on your local network.'
  }
  const owner = registration.owner
  const account = owner ? owner.email ?? owner.name ?? 'your account' : 'your account'
  return `Registered to ${account}. Your devices reach it on your local network or by pairing.`
}

/** The line under "Reachable from the internet" (rule 9): the tunnel's state, and what turning it on does. */
export function linkDescription(status: UplinkStatus | undefined): string {
  const offMessage = 'Turn on to expose this host to the internet through a Cloudflare tunnel. Nothing else changes.'
  if (!status) return offMessage
  const { link } = status
  if (!link.linked) return link.error ? `${link.error} ${offMessage}` : offMessage
  const { hostname } = link.tunnel
  switch (link.state.observed) {
    case 'online': return `Reachable at ${hostname} through a Cloudflare tunnel.`
    case 'offline': return `${hostname} · tunnel offline. You can continue to use Solus locally.`
    case 'error': return `${hostname} · tunnel offline. ${link.state.error ?? 'The tunnel has an error.'} You can continue to use Solus locally.`
  }
}
