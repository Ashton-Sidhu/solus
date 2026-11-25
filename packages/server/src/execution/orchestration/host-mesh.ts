import { HostIntroducer, type IntroducerHost } from '@solus/client-core/host-introducer'
import type { HostTarget, RemoteHost } from './remote-hosts'

/**
 * This host introduces the machines it holds to each other (docs/plans/host-reach.md
 * §4.4). A device introduces only the hosts it reaches itself; this host also
 * reaches a machine that no device of the person reaches. A pairing and an
 * introduction both admit this host there as the owner, so both count. An account
 * host needs no introduction: the account plane gives the reach (§3).
 */
export function hostMesh(deps: {
  /** This host, with its own introduction operations. */
  self: () => IntroducerHost
  /** The machines this host reaches as the owner; only those it holds a credential for are introduced. */
  targets: () => Promise<HostTarget[]>
  connect: (target: HostTarget) => RemoteHost | { error: string }
}): HostIntroducer {
  return new HostIntroducer(async () => {
    const targets = (await deps.targets()).filter((target) => target.source === 'paired' || target.source === 'introduced')
    const held = targets.flatMap((target): IntroducerHost[] => {
      const remote = deps.connect(target)
      if ('error' in remote) return []
      return [{
        installationId: target.installationId,
        label: target.label,
        api: {
          hostIntroductionsList: () => remote.call('its introductions', () => remote.api.hostIntroductionsList()),
          hostIntroductionIssue: (forHost) => remote.call('an introduction', () => remote.api.hostIntroductionIssue(forHost)),
          hostIntroductionAccept: (accepted) => remote.call('an introduction', () => remote.api.hostIntroductionAccept(accepted)),
        },
      }]
    })
    return [deps.self(), ...held]
  })
}
