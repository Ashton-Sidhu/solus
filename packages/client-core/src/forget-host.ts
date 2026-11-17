import type { HostApi } from './host-api'
import type { IntroducerHost } from './host-introducer'
import type { HostRoute } from '@solus/contracts/host-routes'

export interface HostConnectionOwner extends IntroducerHost {
  api: IntroducerHost['api'] & Pick<HostApi, 'hostListRemove'>
}

/** Forget on each connected owner before dropping the client's credential.
 * A required SSH holder must answer; otherwise the forward could keep running
 * after this client has lost the means to stop it. */
export async function forgetHostConnections(installationId: string, routes: readonly HostRoute[], owners: readonly HostConnectionOwner[]): Promise<void> {
  const holders = routes.filter((route) => route.kind === 'forwarded').map((route) => route.viaHostId)
  for (const holder of holders) {
    if (!holder || !owners.some((owner) => owner.installationId === holder)) {
      throw new Error('Connect to the machine that holds the SSH forward before forgetting this host.')
    }
  }
  const results = await Promise.allSettled(owners.filter((owner) => owner.installationId !== installationId)
    .map((owner) => owner.api.hostListRemove(installationId)))
  const failed = results.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw new Error('A connected machine could not forget this host. Try again.', { cause: failed.reason })
}
