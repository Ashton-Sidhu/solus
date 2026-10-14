import type { HostApi } from './host-api'

/** One host this client is connected to as its local owner. */
export interface IntroducerHost {
  /** The installation id the host answers as on `/health`. */
  installationId: string
  label: string
  api: Pick<HostApi, 'hostIntroductionsList' | 'hostIntroductionIssue' | 'hostIntroductionAccept'>
}

/**
 * Runs `introduceHosts` over the hosts a client owns each time one of its connections
 * is accepted. One run at a time; a connection accepted during a run asks for one more.
 */
export class HostIntroducer {
  private running: Promise<void> | null = null
  private isWanted = false

  constructor(private readonly ownedHosts: () => Promise<IntroducerHost[]>) {}

  run(): void {
    if (this.running) {
      this.isWanted = true
      return
    }
    this.running = this.ownedHosts()
      .then(introduceHosts)
      .catch(() => undefined)
      .finally(() => {
        this.running = null
        if (!this.isWanted) return
        this.isWanted = false
        this.run()
      })
  }
}

/**
 * Introduces the hosts this client owns to each other (docs/plans/host-reach.md §4),
 * so a person's hosts reach each other with no account and no pairing step. For each
 * two hosts where either does not know the other, each issues a token for the other
 * and the client hands it over. A host that the person forgot on either side is left
 * alone. Desktop, web, and mobile call this when their set of owned hosts changes.
 */
export async function introduceHosts(hosts: readonly IntroducerHost[]): Promise<void> {
  if (hosts.length < 2) return
  const known = await Promise.all(hosts.map(async (host) => {
    try {
      const { hosts: introduced, refused } = await host.api.hostIntroductionsList()
      return { introduced: new Set(introduced.map((entry) => entry.installationId)), refused: new Set(refused.map((entry) => entry.installationId)) }
    } catch {
      // A host that cannot answer (an older host, or one that just dropped) is not introduced now.
      return null
    }
  }))
  for (let i = 0; i < hosts.length; i += 1) {
    for (let j = i + 1; j < hosts.length; j += 1) {
      const [a, b, knownA, knownB] = [hosts[i]!, hosts[j]!, known[i], known[j]]
      if (!knownA || !knownB || a.installationId === b.installationId) continue
      if (knownA.refused.has(b.installationId) || knownB.refused.has(a.installationId)) continue
      if (knownA.introduced.has(b.installationId) && knownB.introduced.has(a.installationId)) continue
      await introduce(a, b).catch(() => undefined)
    }
  }
}

async function introduce(a: IntroducerHost, b: IntroducerHost): Promise<void> {
  let fromA, fromB
  try {
    [fromA, fromB] = await Promise.all([
      a.api.hostIntroductionIssue({ installationId: b.installationId, label: b.label }),
      b.api.hostIntroductionIssue({ installationId: a.installationId, label: a.label }),
    ])
  } catch {
    return
  }
  // One side, then the other. A side that cannot reach the other revokes the device it
  // issued, so the second acceptance fails at that host too. A half left by a failure in
  // the second step is seen at the next run (one side does not know the other) and made again.
  try {
    await a.api.hostIntroductionAccept({ introduction: fromB, grantedDeviceId: fromA.deviceId })
  } finally {
    await b.api.hostIntroductionAccept({ introduction: fromA, grantedDeviceId: fromB.deviceId }).catch(() => undefined)
  }
}
