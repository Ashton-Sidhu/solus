import type { AddMachineAsk, AddMachineWay } from '@solus/contracts/add-machine'
import type { SshTargetCandidate } from '@solus/contracts/remote-machines'
import type { HostOperatingSystem } from '@solus/contracts/types'

/**
 * The machines an Add machine card offers (docs/plans/add-machine-card.md), in
 * one order for desktop, web, and mobile. Each machine gets the way that needs
 * the least from the person: a code this client makes, then SSH, then an
 * approval request. A typed code is the card's fallback, not a candidate.
 */

/** A host this client reaches. The caller leaves out the session's own host. */
export interface ReachableMachine {
  serverId: string
  label: string
  /** The address this client dials it at; the session host pairs with it there. */
  url?: string
  /** This client may make a pairing code there (`connectionsGeneratePairToken`). */
  canMint: boolean
  /** The operating system the host reported, for the row's mark. */
  os?: HostOperatingSystem
}

/** A Solus server found on the network. */
export interface NearbyMachine {
  label: string
  url: string
}

export interface AddMachineSources {
  reachable: readonly ReachableMachine[]
  /** The session host's SSH targets (`hostsListSshConfigHosts`). */
  ssh: readonly SshTargetCandidate[]
  nearby: readonly NearbyMachine[]
}

export interface AddMachineCandidate {
  key: string
  label: string
  /** The address or the SSH target, as the row shows it. */
  detail: string
  way: AddMachineWay
  /** `code` way only: this client makes the code on `serverId`. */
  minted: boolean
  url?: string
  sshTarget?: string
  serverId?: string
  /** The candidate matches the agent's address or the person's words. */
  isMatch: boolean
  /** A host this client reaches: the operating system it reported. */
  os?: HostOperatingSystem
}

const WAY_ORDER = { minted: 0, ssh: 1, approve: 2, code: 3 } as const
// Words that name every machine and so match none.
const COMMON_WORDS = new Set(['my', 'the', 'machine', 'computer', 'host', 'server', 'box', 'pc', 'at', 'on', 'to', 'this', 'that', 'link', 'add', 'pair', 'connect', 'with'])

function hostOf(value: string | undefined): string | null {
  if (!value) return null
  try {
    return new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

function hintWords(hint: string | undefined): string[] {
  return (hint ?? '').toLowerCase().split(/[^a-z0-9.]+/).filter((word) => word.length >= 3 && !COMMON_WORDS.has(word))
}

function orderOf(candidate: AddMachineCandidate): number {
  return candidate.minted ? WAY_ORDER.minted : WAY_ORDER[candidate.way]
}

/** The candidates, best first. One row per machine: the same address keeps its best way. */
export function rankAddMachineCandidates(ask: AddMachineAsk, sources: AddMachineSources): AddMachineCandidate[] {
  const askHost = hostOf(ask.url)
  const words = hintWords(ask.hint)
  const all: AddMachineCandidate[] = []
  for (const machine of sources.reachable) {
    if (!machine.url) continue
    const row: AddMachineCandidate = { key: `host:${machine.serverId}`, label: machine.label, detail: machine.url, way: machine.canMint ? 'code' : 'approve', minted: machine.canMint, url: machine.url, serverId: machine.serverId, isMatch: false }
    if (machine.os) row.os = machine.os
    all.push(row)
  }
  for (const target of sources.ssh) {
    all.push({ key: `ssh:${target.target}`, label: target.label, detail: target.hostName ? `${target.target} · ${target.hostName}` : target.target, way: 'ssh', minted: false, sshTarget: target.target, isMatch: false })
  }
  for (const machine of sources.nearby) {
    all.push({ key: `nearby:${machine.url}`, label: machine.label, detail: machine.url, way: 'approve', minted: false, url: machine.url, isMatch: false })
  }

  const addressOf = (candidate: AddMachineCandidate): string | null => {
    if (candidate.url) return hostOf(candidate.url)
    const target = sources.ssh.find((entry) => entry.target === candidate.sshTarget)
    return hostOf(target?.hostName ?? target?.target.replace(/^[^@]*@/, ''))
  }
  const score = (candidate: AddMachineCandidate): number => {
    const address = addressOf(candidate)
    let total = askHost && address === askHost ? 100 : 0
    const text = `${candidate.label} ${candidate.detail}`.toLowerCase()
    for (const word of words) if (text.includes(word)) total += 10
    return total
  }

  // One row per address: the best way wins, and the row keeps the friendliest name.
  const byAddress = new Map<string, AddMachineCandidate>()
  const unaddressed: AddMachineCandidate[] = []
  for (const candidate of all) {
    const address = addressOf(candidate)
    if (!address) { unaddressed.push(candidate); continue }
    const held = byAddress.get(address)
    const best = !held || orderOf(candidate) < orderOf(held) ? candidate : held
    // An SSH row keeps a Solus address it shares, so the card can still ask for approval or a code there.
    const url = best.url ?? (best === candidate ? held?.url : candidate.url)
    byAddress.set(address, url ? { ...best, url } : best)
  }

  // The agent's address is always offered, also when no source knows it.
  if (ask.url && askHost) {
    const held = byAddress.get(askHost)
    if (!held) byAddress.set(askHost, { key: `ask:${ask.url}`, label: askHost, detail: ask.url, way: 'approve', minted: false, url: ask.url, isMatch: true })
    else if (!held.url) byAddress.set(askHost, { ...held, url: ask.url })
  }
  const rows = [...byAddress.values(), ...unaddressed]

  const scored = rows.map((row) => ({ row, score: row.key.startsWith('ask:') ? 100 : score(row) }))
  scored.sort((a, b) => b.score - a.score || orderOf(a.row) - orderOf(b.row) || a.row.label.localeCompare(b.row.label))
  return scored.map(({ row, score: value }) => ({ ...row, isMatch: value > 0 }))
}
