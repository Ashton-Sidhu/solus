import type { IntroducedHostsSummary } from '@solus/contracts/host-api'
import type { HostPairingsSnapshot } from '@solus/contracts/host-pairing'
import { pairingHealthState, pairingHealthText, type PairingHealthState } from './paired-hosts'

/** One machine a host reaches as its owner, and how (docs/plans/host-reach.md). */
export interface ReachedMachine {
  installationId: string
  label: string
  way: 'paired' | 'introduced'
  /** A pairing's health; an introduction sends none. */
  health: PairingHealthState | null
}

/** Each machine once, by the way the host dials it first: a pairing before an introduction (§5). */
export function reachedMachines(pairings: HostPairingsSnapshot | null, introductions: IntroducedHostsSummary | null, now: number): ReachedMachine[] {
  const machines = new Map<string, ReachedMachine>()
  for (const pairing of pairings?.hosts ?? []) {
    const { installationId, label } = pairing.listing
    machines.set(installationId, { installationId, label, way: 'paired', health: pairingHealthState(pairing.health, now) })
  }
  for (const host of introductions?.hosts ?? []) {
    if (!machines.has(host.installationId)) machines.set(host.installationId, { installationId: host.installationId, label: host.label, way: 'introduced', health: null })
  }
  return [...machines.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/** "Paired · Working", or "Introduced". */
export function reachedMachineDetail(machine: ReachedMachine): string {
  if (machine.way === 'introduced') return 'Introduced'
  return machine.health ? `Paired · ${pairingHealthText(machine.health)}` : 'Paired'
}

/** A pairing that does not work, so the row says so in the error color. */
export function isReachFailing(machine: ReachedMachine): boolean {
  return machine.health?.kind === 'failing' || machine.health?.kind === 'expired'
}
