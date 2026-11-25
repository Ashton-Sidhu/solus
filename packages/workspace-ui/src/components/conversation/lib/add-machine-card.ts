import type { AddMachineWay } from '@solus/contracts/add-machine'
import type { HostPairRequest } from '@solus/contracts/host-pairing'
import type { HostRoute } from '@solus/contracts/host-routes'
import type { SshAddResult } from '@solus/contracts/remote-machines'
import type { AddMachineCandidate, ReachableMachine } from '@solus/client-core/add-machine-candidates'
import { classifyPairSecret, normalizeServerUrl, urlHost } from '@solus/client-core/pairing'
import type { HostOperatingSystem } from '@solus/contracts/types'
import { isMissingIdentityFile } from '../../servers/lib/add-over-ssh'

/**
 * The rules of the Add machine card (docs/plans/add-machine-card.md): the words
 * for each way, the request each way sends to the session host, and what an
 * answer means. The card keeps the typed values in its own state; this module
 * reads them and never keeps them.
 */

/** The row the card adds below the candidates: an address the person types. */
export const ANOTHER_ADDRESS_KEY = 'another-address'

/** The row above it: an SSH target the person types, which `~/.ssh/config` does not name. */
export const ANOTHER_SSH_KEY = 'another-ssh'

/** The way of a row, as words. */
export function wayLabel(candidate: Pick<AddMachineCandidate, 'way' | 'minted'>): string {
  if (candidate.minted) return 'From this device'
  switch (candidate.way) {
    case 'ssh': return 'Over SSH'
    case 'approve': return 'Ask it to approve'
    case 'code': return 'Needs a code'
  }
}

/** The field of the card that an attempt used, where its failure shows. */
export type CardField = 'code' | 'password' | 'address' | 'target' | 'identity' | 'general'

/** What the person picked, as the card sends it. `code` is a typed code; `address` is the "Another address…" row. */
export type CardAttempt =
  /** `identityFile`: a private key on the session host, as with `ssh -i`. Unset: its SSH keys and `~/.ssh/config`. */
  | { way: 'ssh'; sshTarget: string; identityFile?: string }
  | { way: 'approve'; url: string }
  | { way: 'minted'; url: string; serverId: string }
  | { way: 'code'; url: string; code: string }

/** The attempt, or the message the card shows at a field when it sends nothing. */
export type AttemptBuild = { attempt: CardAttempt } | { error: string; field: CardField }

const NOT_A_CODE = 'Enter the 6-digit code, or paste the pair link. A password does not go here.'
const NO_ADDRESS = 'Enter the address of the machine.'
const NO_SSH_TARGET = 'Enter the SSH target, such as ubuntu@3.91.20.4.'

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
 */
export function candidateAttempt(candidate: AddMachineCandidate, code: string, useCode: boolean, identityFile = ''): AttemptBuild {
  if (useCode || (candidate.way === 'code' && !candidate.minted)) return typedCodeAttempt(candidate.url, code)
  if (candidate.way === 'ssh') {
    return candidate.sshTarget ? sshTargetAttempt(candidate.sshTarget, identityFile) : { error: 'This machine has no SSH target.', field: 'general' }
  }
  if (!candidate.url) return { error: NO_ADDRESS, field: 'address' }
  if (candidate.minted && candidate.serverId) return { attempt: { way: 'minted', url: candidate.url, serverId: candidate.serverId } }
  return { attempt: { way: 'approve', url: candidate.url } }
}

/** The attempt for the "Another address…" row: an approval request, unless a code was typed or a pair link pasted. */
export function addressAttempt(address: string, code: string, useCode: boolean): AttemptBuild {
  const trimmed = address.trim()
  const secret = classifyPairSecret(trimmed)
  if (secret?.kind === 'link') return typedCodeAttempt(secret.url, trimmed)
  if (useCode) return typedCodeAttempt(trimmed ? normalizeServerUrl(trimmed) : undefined, code)
  if (!trimmed) return { error: NO_ADDRESS, field: 'address' }
  return { attempt: { way: 'approve', url: normalizeServerUrl(trimmed) } }
}

/** The field a failed attempt belongs to. A key the host does not have is the identity file's. */
export function attemptField(attempt: CardAttempt, isAddressRow: boolean, hasPassword: boolean, message = ''): CardField {
  if (attempt.way === 'code') return 'code'
  if (attempt.way === 'ssh') {
    if (attempt.identityFile && isMissingIdentityFile(message)) return 'identity'
    return hasPassword ? 'password' : 'general'
  }
  return isAddressRow ? 'address' : 'general'
}

/** The way the tool hears of. A minted code is the `code` way. */
export function outcomeWay(attempt: CardAttempt): AddMachineWay {
  return attempt.way === 'minted' ? 'code' : attempt.way
}

/** The `hostsPair` request of a pairing attempt. */
export function pairRequest(attempt: Extract<CardAttempt, { way: 'approve' | 'code' }>, checkCode: string): HostPairRequest {
  return attempt.way === 'approve' ? { url: attempt.url, checkCode } : { url: attempt.url, code: attempt.code }
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

/** The steps to get a code on the target. */
export function codeSteps(targetName: string): string {
  return `On ${targetName}, open Settings → Connections → This computer → Access → Generate code, or run \`solus pair\`.`
}

/** The line under the check code while the target's owner decides. */
export function approveSteps(targetName: string, checkCode: string): string {
  return `Approve it in Solus on ${targetName}, or run \`solus host approve ${checkCode}\` there.`
}

/** One part of a line of steps: the text between backticks is a command, which shows as code. */
export interface StepTextPart {
  text: string
  isCode: boolean
}

/** A line of steps in parts, so a command in backticks shows as code and not with its backticks. */
export function stepTextParts(text: string): StepTextPart[] {
  return text.split('`').map((part, index) => ({ text: part, isCode: index % 2 === 1 })).filter((part) => part.text)
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
