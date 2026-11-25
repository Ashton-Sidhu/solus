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
 * alone until the person introduces the two again (`introducePair`). Desktop, web, and
 * mobile call this when their set of owned hosts changes.
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

/** A host the person chose to introduce: choosing it again also clears a Forget. */
export interface ChosenIntroducerHost extends IntroducerHost {
  api: IntroducerHost['api'] & Pick<HostApi, 'hostIntroductionAllow'>
}

/**
 * Introduces two hosts that the person chose, for example by dragging one onto the
 * other on the host map. The automatic run above leaves a forgotten host alone; here
 * the person asks for the two again, so each side first allows the other. Unlike the
 * automatic run, a failure is the answer: the caller shows it.
 */
export async function introducePair(a: ChosenIntroducerHost, b: ChosenIntroducerHost): Promise<void> {
  if (a.installationId === b.installationId) throw new Error('A host cannot be introduced to itself.')
  const [knownA, knownB] = await Promise.all([a.api.hostIntroductionsList(), b.api.hostIntroductionsList()])
  const names = (list: ReadonlyArray<{ installationId: string }>) => new Set(list.map((entry) => entry.installationId))
  if (names(knownA.refused).has(b.installationId)) await a.api.hostIntroductionAllow({ installationId: b.installationId })
  if (names(knownB.refused).has(a.installationId)) await b.api.hostIntroductionAllow({ installationId: a.installationId })
  if (names(knownA.hosts).has(b.installationId) && names(knownB.hosts).has(a.installationId)) return
  await introduce(a, b)
}

async function introduce(a: IntroducerHost, b: IntroducerHost): Promise<void> {
  const [fromA, fromB] = await Promise.all([
    a.api.hostIntroductionIssue({ installationId: b.installationId, label: b.label }),
    b.api.hostIntroductionIssue({ installationId: a.installationId, label: a.label }),
  ])
  // One side, then the other, even when the first fails. A side that cannot reach the
  // other revokes the device it issued, so the second acceptance fails at that host too.
  // A half left by a failure is seen at the next run (one side does not know the other)
  // and made again. The first failure is the answer.
  const [first] = await Promise.allSettled([a.api.hostIntroductionAccept({ introduction: fromB, grantedDeviceId: fromA.deviceId })])
  const [second] = await Promise.allSettled([b.api.hostIntroductionAccept({ introduction: fromA, grantedDeviceId: fromB.deviceId })])
  const failed = [first, second].find((result) => result?.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
}
