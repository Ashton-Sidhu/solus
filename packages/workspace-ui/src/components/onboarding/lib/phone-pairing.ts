import { pairLink, type PairEndpoint } from '@solus/client-core/pairing'

/**
 * The link the Your phone step puts in its QR code: the host's address on the
 * local network with a one-time pair token (decision 4, "pairs over your
 * Wi-Fi, nothing goes through the cloud"). A loopback address is no use to a
 * phone, so with no network address there is no link and the step says why.
 */
export function phonePairLink(endpoints: readonly PairEndpoint[], pairToken: string | null): string | null {
  if (!pairToken) return null
  const endpoint = endpoints.find((entry) => entry.kind === 'lan') ?? endpoints.find((entry) => entry.kind === 'tailnet')
  return endpoint ? pairLink(endpoint, pairToken) : null
}
