import type { AppAddress, AppAddressSource } from '@solus/contracts/host-api'
import { HOST_CONFIG_FIELDS } from '@solus/contracts/host-config'
import type { HostAppEndpoint } from './host-access'

/**
 * The addresses at which an outside app reaches a host's `/mcp` (plans/035 §0.8).
 * A host does not have to be linked to a Solus account: Tailscale Funnel, Tailscale
 * Serve, or the person's own ingress serves `/mcp` too.
 */

/** A cloud app uses the first of these that the host lists. Tailscale Serve reaches only the tailnet. */
const CLOUD_APP_SOURCES: readonly AppAddressSource[] = ['solus', 'tailscale-funnel', 'custom']

/** Every address the host lists. An older host lists none; its public tunnel address is then the Solus one. */
export function appAddressesOf(endpoint: HostAppEndpoint): AppAddress[] {
  // SAFETY: an older host answers without `addresses`, whatever the contract says; the check below covers both.
  const listed = endpoint.addresses as AppAddress[] | undefined
  if (listed) return listed
  return endpoint.publicUrl ? [{ source: 'solus', url: endpoint.publicUrl, reach: 'internet' }] : []
}

/** The address a cloud app uses: one the internet reaches, from the Solus tunnel first, then Funnel, then the person's own. */
export function cloudAppAddress(addresses: readonly AppAddress[]): AppAddress | null {
  for (const source of CLOUD_APP_SOURCES) {
    const address = addresses.find((entry) => entry.source === source && entry.reach === 'internet')
    if (address) return address
  }
  return null
}

/**
 * Where apps reach the host, as Sharing & access shows it: anywhere (the address a
 * cloud app uses), and on the person's own devices (a tailnet address). An address
 * the internet reaches also reaches the person's devices, so `devices` is only a
 * tailnet address.
 */
/**
 * The two addresses the section shows. An internet address serves your
 * devices too, so the tailnet one shows only while there is no internet one,
 * as on desktop and web (docs/outside-apps.md).
 */
export function appReachOf(addresses: readonly AppAddress[]) {
  const anywhere = cloudAppAddress(addresses)
  return {
    anywhere,
    devices: anywhere ? null : addresses.find((entry) => entry.reach === 'tailnet') ?? null,
  }
}

/** The address as a row shows it, without `https://`. Copy gives the whole address. */
export function shortAppAddress(url: string): string {
  return url.replace(/^https?:\/\//, '')
}

export function appAddressSourceLabel(source: AppAddressSource): string {
  switch (source) {
    case 'solus': return 'Solus account'
    case 'tailscale-funnel': return 'Tailscale Funnel'
    case 'tailscale-serve': return 'Tailscale Serve'
    case 'custom': return 'Your own address'
  }
}

export function appAddressReachLabel(reach: AppAddress['reach']): string {
  return reach === 'internet' ? 'Internet' : 'Your tailnet only'
}

/**
 * What the person typed for their own address, as the host keeps it: an https
 * origin, or empty for none. The host checks it again with the same rule.
 */
export function publicAddressInput(text: string): { ok: true; value: string } | { ok: false; message: string } {
  const parsed = HOST_CONFIG_FIELDS.publicAddress.patch.safeParse(text.trim())
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, message: 'Enter an https address, such as https://solus.example.com.' }
}
