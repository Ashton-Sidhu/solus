import type { SshTargetCandidate, WslDistro } from '@solus/contracts/remote-machines'
import type { DiscoveredServer, HostOperatingSystem } from '@solus/contracts/types'
import type { FleetZoneId } from './fleet-model'

/**
 * Discover (docs/plans/host-fleet.md D7): what this device can see but has not
 * added, from four sources, as one list. Each found machine names its source,
 * the zone it would join, and the one action that adds it.
 */

export type FoundMachine =
  /** Runs Solus: pairs with the code it shows. */
  | { kind: 'server'; key: string; name: string; os?: HostOperatingSystem; source: 'lan' | 'tailnet'; detail: string; zone: FleetZoneId; server: DiscoveredServer }
  /** A distro of a Windows host: Solus installs itself there. */
  | { kind: 'wsl'; key: string; name: string; os: 'linux'; source: 'wsl'; detail: string; zone: FleetZoneId; windowsHostId: string; distro: string }
  /** Named in the SSH config: added over SSH. */
  | { kind: 'ssh'; key: string; name: string; os?: undefined; source: 'ssh-config'; detail: string; zone: FleetZoneId; sshTarget: string }

export interface FoundInput {
  nearby: readonly DiscoveredServer[]
  wsl: { windowsHostId: string; windowsHostName: string; distros: readonly WslDistro[] } | null
  sshConfig: readonly SshTargetCandidate[]
  /** Labels of saved hosts and targets of held forwards, so a machine already added is not found again. */
  knownNames: ReadonlySet<string>
}

export function foundMachines(input: FoundInput): FoundMachine[] {
  const found: FoundMachine[] = input.nearby.map((server) => ({
    kind: 'server',
    key: `server:${server.installationId}`,
    name: server.name || server.host,
    os: server.os,
    source: server.source,
    detail: `${server.host}:${server.port}`,
    zone: 'own',
    server,
  }))
  if (input.wsl) {
    for (const distro of input.wsl.distros) {
      found.push({
        kind: 'wsl',
        key: `wsl:${input.wsl.windowsHostId}:${distro.name}`,
        name: distro.name,
        os: 'linux',
        source: 'wsl',
        detail: `On ${input.wsl.windowsHostName}`,
        zone: 'own',
        windowsHostId: input.wsl.windowsHostId,
        distro: distro.name,
      })
    }
  }
  const known = new Set([...input.knownNames].map((name) => name.toLowerCase()))
  for (const candidate of input.sshConfig) {
    const names = sshCandidateNames(candidate)
    if (names.some((name) => known.has(name.toLowerCase()))) continue
    found.push({
      kind: 'ssh',
      key: `ssh:${candidate.target}`,
      name: names[0]!,
      source: 'ssh-config',
      detail: candidate.target,
      zone: 'own',
      sshTarget: candidate.target,
    })
  }
  return found
}

/**
 * The names a config entry may be saved under: its alias, its address, and its
 * full target. The label reads `alias -> hostname` when the entry names an address.
 */
export function sshCandidateNames(candidate: SshTargetCandidate): string[] {
  const [alias, hostname] = candidate.label.split(' -> ')
  return [alias!, ...(hostname ? [hostname] : []), candidate.target]
}
