import type { HostProvidersAsk } from '@solus/contracts/add-machine'
import type { SetupAgent } from '@solus/contracts/types'
import { SETUP_PROVIDERS } from '../../servers/lib/host-onboarding'

/** The provider's name, as the AI providers tab writes it. */
export function providerLabel(provider: SetupAgent): string {
  return SETUP_PROVIDERS.find((entry) => entry.id === provider)?.label ?? provider
}

/** What the Sign in card asks, in one line. */
export function hostProvidersTitle(ask: HostProvidersAsk): string {
  return `Sign in to ${providerLabel(ask.provider)} on ${ask.hostName}`
}

/**
 * The new host as this client lists it, found by the installation id that the
 * session host names it by. Null while this client does not know the host
 * yet: the host list follows a pairing a moment after the card shows.
 */
export function serverOfInstallation<Server extends { id: string; installationId?: string }>(servers: readonly Server[], installationId: string): Server | null {
  return servers.find((server) => server.id === installationId || server.installationId === installationId) ?? null
}
