import type { AddMachineWay } from '@solus/contracts/add-machine'
import type { HostPairRequest } from '@solus/contracts/host-pairing'
import type { HostRoute } from '@solus/contracts/host-routes'
import type { SshAddResult } from '@solus/contracts/remote-machines'
import { otherMachineWay, type AddMachineCandidate, type ReachableMachine } from '@solus/client-core/add-machine-candidates'
import { classifyPairSecret, normalizeServerUrl, urlHost } from '@solus/client-core/pairing'
import type { HostOperatingSystem } from '@solus/contracts/types'
import { isMissingIdentityFile } from '../../servers/lib/add-over-ssh'

/**
 * The rules of the Add machine card (docs/plans/add-machine-card.md): the words
 * for each way, the request each way sends to the session host, and what an
 * answer means. The card keeps the typed values in its own state; this module
 * reads them and never keeps them.
 */

/** The row the card adds below the candidates: an SSH target or an address the person types (`otherMachineWay`). */
export const OTHER_MACHINE_KEY = 'other-machine'

/** The way of a row, as words. */
export function wayLabel(candidate: Pick<AddMachineCandidate, 'way' | 'minted'>): string {
  if (candidate.minted) return 'From this device'
  switch (candidate.way) {
    case 'ssh': return 'SSH'
    case 'approve': return 'Needs approval'
    // The add first joins with no code; the machine asks for one only when its network does not trust the host.
    case 'code': return 'Code if it asks'
  }
}

/** The field of the card that an attempt used, where its failure shows. */
export type CardField = 'code' | 'password' | 'address' | 'target' | 'identity' | 'general'

/** What the person picked, as the card sends it. `code` is a typed code. */
export type CardAttempt =
  /** `identityFile`: a private key on the session host, as with `ssh -i`. Unset: its SSH keys and `~/.ssh/config`. */
  | { way: 'ssh'; sshTarget: string; identityFile?: string }
  | { way: 'approve'; url: string }
  | { way: 'minted'; url: string; serverId: string }
  | { way: 'code'; url: string; code: string }
  /** No code: the session host joins as a device that the target's network trusts. */
  | { way: 'network'; url: string }

/** The attempt, or the message the card shows at a field when it sends nothing. */
export type AttemptBuild = { attempt: CardAttempt } | { error: string; field: CardField }

const NOT_A_CODE = 'Enter the 6-digit code, or paste the pair link. A password does not go here.'
const NO_ADDRESS = 'Enter the address of the machine.'
const NO_SSH_TARGET = 'Enter the SSH target, such as ubuntu@3.91.20.4.'
const NO_OTHER_MACHINE = 'Enter an SSH target, such as ubuntu@3.91.20.4, or an address, such as http://10.10.1.10:4317.'

/** The URL of a typed address, or of the pair link pasted there. Empty when nothing is typed. */
export function typedAddressUrl(address: string): string {
  const secret = classifyPairSecret(address)
  return secret?.kind === 'link' ? secret.url : normalizeServerUrl(address)
}

/**
 * A typed code as an attempt. Rule 1: a value that is not 6 digits or a pair
 * link goes nowhere. A pair link carries its own address.
 */
export function typedCodeAttempt(url: string | undefined, code: string): AttemptBuild {
  const secret = classifyPairSecret(code)
  if (!secret) return { error: NOT_A_CODE, field: 'code' }
  if (secret.kind === 'link') return { attempt: { way: 'code', url: secret.url, code: code.trim() } }
  if (!url) return { error: NO_ADDRESS, field: 'address' }
  return { attempt: { way: 'code', url, code: secret.code } }
}

/**
 * A code row's attempt: the typed code, or with none, a join that needs nobody at
 * the target. Only when the target refuses does the card ask for its code.
 */
function codeOrNetworkAttempt(url: string | undefined, code: string): AttemptBuild {
  if (!code.trim() && url) return { attempt: { way: 'network', url } }
  return typedCodeAttempt(url, code)
}

/** An SSH attempt with the key the person named, if any. */
export function sshTargetAttempt(sshTarget: string, identityFile: string): AttemptBuild {
  const target = sshTarget.trim()
  if (!target) return { error: NO_SSH_TARGET, field: 'target' }
  const key = identityFile.trim()
  return { attempt: key ? { way: 'ssh', sshTarget: target, identityFile: key } : { way: 'ssh', sshTarget: target } }
}

/**
 * The attempt for a candidate row. `useCode`: the person chose to type a code.
 * `identityFile`: the key the person named for an SSH row; empty for its config's key.
 * `useApproval`: the person chose to ask the target's owner, the one way that
 * needs somebody at the target, so the card never chooses it alone.
 */
export function candidateAttempt(candidate: AddMachineCandidate, code: string, useCode: boolean, identityFile = '', useApproval = false): AttemptBuild {
  if (useApproval && candidate.url) return { attempt: { way: 'approve', url: candidate.url } }
  if (useCode || (candidate.way === 'code' && !candidate.minted)) return codeOrNetworkAttempt(candidate.url, code)
  if (candidate.way === 'ssh') {
    return candidate.sshTarget ? sshTargetAttempt(candidate.sshTarget, identityFile) : { error: 'This machine has no SSH target.', field: 'general' }
  }
  if (!candidate.url) return { error: NO_ADDRESS, field: 'address' }
  if (candidate.minted && candidate.serverId) return { attempt: { way: 'minted', url: candidate.url, serverId: candidate.serverId } }
  return codeOrNetworkAttempt(candidate.url, code)
}

/**
 * The attempt for a typed address: its code or pair link when one was given,
 * else a join with no code; an approval request only when the person chose it.
 */
export function addressAttempt(address: string, code: string, useCode: boolean, useApproval = false): AttemptBuild {
  const trimmed = address.trim()
  const secret = classifyPairSecret(trimmed)
  if (secret?.kind === 'link') return typedCodeAttempt(secret.url, trimmed)
  if (useCode && code.trim()) return typedCodeAttempt(trimmed ? normalizeServerUrl(trimmed) : undefined, code)
  if (!trimmed) return { error: NO_ADDRESS, field: 'address' }
  if (useApproval) return { attempt: { way: 'approve', url: normalizeServerUrl(trimmed) } }
  return codeOrNetworkAttempt(normalizeServerUrl(trimmed), code)
}

/** The attempt for the "Other machine…" row: an SSH add for an SSH target, else the address's attempt. */
export function otherMachineAttempt(typed: string, code: string, useCode: boolean, identityFile: string, useApproval = false): AttemptBuild {
  if (!typed.trim()) return { error: NO_OTHER_MACHINE, field: 'target' }
  return otherMachineWay(typed) === 'ssh' ? sshTargetAttempt(typed, identityFile) : addressAttempt(typed, code, useCode, useApproval)
}

/** The field a failed attempt belongs to. A key the host does not have is the identity file's. */
export function attemptField(attempt: CardAttempt, isAddressRow: boolean, hasPassword: boolean, message = ''): CardField {
  // A refused join with no code asks for the code, so its message is at the code field.
  if (attempt.way === 'code' || attempt.way === 'network') return 'code'
  if (attempt.way === 'ssh') {
    if (attempt.identityFile && isMissingIdentityFile(message)) return 'identity'
    return hasPassword ? 'password' : 'general'
  }
  return isAddressRow ? 'address' : 'general'
}

/**
 * The way the tool hears of. A minted code and a join with no code are the `code`
 * way: a host of an older Solus reads no other value.
 */
export function outcomeWay(attempt: CardAttempt): AddMachineWay {
  return attempt.way === 'minted' || attempt.way === 'network' ? 'code' : attempt.way
}

/** The `hostsPair` request of a pairing attempt. A join with no code sends neither a code nor a check code. */
export function pairRequest(attempt: Extract<CardAttempt, { way: 'approve' | 'code' | 'network' }>, checkCode: string): HostPairRequest {
  switch (attempt.way) {
    case 'approve': return { url: attempt.url, checkCode }
    case 'code': return { url: attempt.url, code: attempt.code }
    case 'network': return { url: attempt.url }
  }
}

/** What one `hostsAddOverSsh` answer means for the card. The card never links to the account. */
export type SshCardOutcome =
  | { kind: 'added'; installationId: string; label: string }
  | { kind: 'ask-password'; message: string }
  /** Other users can read the key, so SSH refuses it; nothing was sent. The card offers Fix permissions. */
  | { kind: 'key-permissions'; identityFile: string; message: string }
  | { kind: 'failed'; message: string }

export function sshCardOutcome(result: SshAddResult): SshCardOutcome {
  switch (result.status) {
    case 'forwarded':
      return { kind: 'added', installationId: result.host.installationId, label: result.host.label }
    case 'linked':
    case 'session':
      return { kind: 'added', installationId: result.installationId, label: result.label }
    case 'needs-auth':
      return { kind: 'ask-password', message: `${result.message} Enter the password for ${result.sshTarget}.` }
    case 'key-permissions':
      return { kind: 'key-permissions', identityFile: result.identityFile, message: result.message }
    case 'needs-target':
      return { kind: 'failed', message: result.message }
  }
}

const LOOPBACK = /^(127\.|localhost$|\[?::1\]?$)/i

/**
 * The address the session host can dial a machine at. A forward is held open on
 * one machine, so it counts only when the session host holds it; loopback only
 * reaches the machine it is typed on.
 */
export function sessionHostDialUrl(routes: readonly HostRoute[], sessionHostId: string): string | undefined {
  for (const route of routes) {
    if (route.kind === 'forwarded') {
      if (route.viaHostId === sessionHostId) return route.url
      continue
    }
    try {
      if (!LOOPBACK.test(new URL(route.url).hostname)) return route.url
    } catch {
      continue
    }
  }
  return undefined
}

/** One host this client knows, as the card reads it. */
export interface KnownMachine {
  id: string
  label: string
  routes: readonly HostRoute[]
  /** How the host admitted this client; undefined until it answers. */
  principal?: string
  os?: HostOperatingSystem
}

/** This client's hosts as Add machine sources. The session's own host is left out. */
export function reachableMachines(machines: readonly KnownMachine[], sessionHostId: string): ReachableMachine[] {
  return machines
    .filter((machine) => machine.id !== sessionHostId)
    .map((machine) => {
      const reachable: ReachableMachine = {
        serverId: machine.id,
        label: machine.label,
        url: sessionHostDialUrl(machine.routes, sessionHostId),
        canMint: machine.principal === 'local-owner' || machine.principal === 'remote-owner',
      }
      if (machine.os) reachable.os = machine.os
      return reachable
    })
}

/** The line under the check code while the target's owner decides. */
export function approveSteps(targetName: string, checkCode: string): string {
  return `Approve it in Solus on ${targetName}, or run \`solus host approve ${checkCode}\` there.`
}

/** The name the card uses for a target: its row's name, or the host of its address. */
export function targetName(candidate: Pick<AddMachineCandidate, 'label'> | null, address: string): string {
  if (candidate) return candidate.label
  const url = typedAddressUrl(address)
  return url ? urlHost(url) : 'the other machine'
}

/** The next row for an arrow key, wrapping at both ends. */
export function nextIndex(current: number, count: number, key: 'ArrowUp' | 'ArrowDown'): number {
  if (count === 0) return 0
  return key === 'ArrowDown' ? (current + 1) % count : (current - 1 + count) % count
}
