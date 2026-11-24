import type { HostApi } from '@solus/client-core/host-api'
import type { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { classifyPairSecret, normalizeServerUrl } from '@solus/client-core/pairing'
import type { AddMachineCandidate, ReachableMachine } from '@solus/client-core/add-machine-candidates'
import { formatCheckCode, type AddMachineOutcome, type AddMachineWay } from '@solus/contracts/add-machine'
import type { HostRoute } from '@solus/contracts/host-routes'
import type { SshAddProgress } from '@solus/contracts/remote-machines'

/**
 * The rules of the phone's Add machine card (docs/plans/add-machine-card.md).
 * The card does the work with the session host's own RPCs (`hostsAddOverSsh`,
 * `hostsPair`), then answers the card with the outcome. A code or a password
 * goes only into the one RPC that uses it; nothing here keeps it.
 */

/** A host this phone knows, as the card reads it. */
export interface KnownMachine {
  hostId: string
  label: string
  routes: readonly HostRoute[]
  isConnected: boolean
  /** This phone holds `host.local.reach` there, so it may make a pairing code. */
  mayReach: boolean
}

// A tunnel has no `/pair`, and only the machine that holds a forward dials it.
const PAIRABLE_ROUTES: ReadonlySet<HostRoute['kind']> = new Set(['lan', 'tailnet', 'vpn', 'public'])

/** The address the session host pairs with: the first direct route. */
export function pairAddressOf(routes: readonly HostRoute[]): string | undefined {
  return routes.find((route) => PAIRABLE_ROUTES.has(route.kind))?.url
}

/** The hosts this phone knows, without the session's own host. */
export function reachableMachines(known: readonly KnownMachine[], sessionHostId: string): ReachableMachine[] {
  return known
    .filter((machine) => machine.hostId !== sessionHostId)
    .map((machine) => ({
      serverId: machine.hostId,
      label: machine.label,
      url: pairAddressOf(machine.routes),
      canMint: machine.isConnected && machine.mayReach,
    }))
}

/** The way a row offers, as the row shows it. */
export function wayLabel(candidate: Pick<AddMachineCandidate, 'way' | 'minted' | 'sshTarget'>): string {
  if (candidate.minted) return 'From this device'
  if (candidate.way === 'ssh') return `Over SSH · ${candidate.sshTarget ?? ''}`
  return candidate.way === 'approve' ? 'Ask it to approve' : 'Needs a code'
}

/** What one tap of Add does. `code` is a typed code; `mint` makes the code on a host this phone reaches. */
export type AddMachineStep =
  | { kind: 'ssh'; sshTarget: string; name: string }
  | { kind: 'mint'; serverId: string; url: string; name: string }
  | { kind: 'approve'; url: string; name: string }
  | { kind: 'code'; url: string; name: string }

/**
 * The step for the selected row. `candidate` null is "Another address…", with
 * the address the person typed. `useCode` is the person's choice to type a code
 * instead of asking for approval; `mintRefused` names the hosts that refused a
 * code from this phone, so the row asks for approval there instead.
 */
export function stepFor(
  candidate: AddMachineCandidate | null,
  options: { address: string; useCode: boolean; mintRefused: ReadonlySet<string> },
): AddMachineStep | null {
  if (!candidate) {
    const url = normalizeServerUrl(options.address)
    if (!url) return null
    const name = hostOf(url)
    return options.useCode ? { kind: 'code', url, name } : { kind: 'approve', url, name }
  }
  const name = candidate.label
  if (candidate.way === 'ssh' && candidate.sshTarget) {
    // An SSH row that shares a Solus address can still pair there with a code.
    return options.useCode && candidate.url ? { kind: 'code', url: candidate.url, name } : { kind: 'ssh', sshTarget: candidate.sshTarget, name }
  }
  if (!candidate.url) return null
  if (options.useCode) return { kind: 'code', url: candidate.url, name }
  if (candidate.minted && candidate.serverId && !options.mintRefused.has(candidate.serverId)) {
    return { kind: 'mint', serverId: candidate.serverId, url: candidate.url, name }
  }
  return { kind: 'approve', url: candidate.url, name }
}

/** The way an added machine took, for the card's answer. */
function wayOf(step: AddMachineStep): AddMachineWay {
  return step.kind === 'ssh' ? 'ssh' : step.kind === 'approve' ? 'approve' : 'code'
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Why a typed code cannot go to the host, or null when it can. Nothing is sent before this passes. */
export function typedCodeError(value: string): string | null {
  if (!value.trim()) return null
  return classifyPairSecret(value) ? null : 'Enter the 6-digit pairing code, or paste the pair link.'
}

/** The code as `hostsPair` takes it: 6 digits without spaces, or the pair link as pasted. Null when its shape is wrong. */
export function typedCodeValue(value: string): string | null {
  const secret = classifyPairSecret(value)
  if (!secret) return null
  return secret.kind === 'code' ? secret.code : value.trim()
}

/**
 * A fresh check code from a secure random source: the platform's on Hermes,
 * which has no Web Crypto, else Web Crypto. The alphabet has 32 letters, which
 * divide 256, so a byte modulo the alphabet has no bias.
 */
export function makeCheckCode(randomBytes?: (length: number) => Uint8Array): string {
  const bytes = randomBytes ? randomBytes(8) : globalThis.crypto.getRandomValues(new Uint8Array(8))
  let next = 0
  return formatCheckCode((n) => bytes[next++]! % n)
}

/** Where to get a code on the target. */
export function codeSteps(name: string): string {
  return `On ${name}, open Settings → Connections → This computer → Access → Generate code, or run \`solus pair\`.`
}

/** What the person does on the target while an approval request waits. */
export function approveInstructions(name: string, checkCode: string): string {
  return `Approve it in Solus on ${name}, or run \`solus host approve ${checkCode}\` there.`
}

/** The result of one tap of Add. A `failed` attempt keeps the card open. */
export type AddMachineAttempt =
  | { kind: 'added'; outcome: Extract<AddMachineOutcome, { status: 'added' }>; label: string }
  /** SSH refused the key: the card asks for a password or passphrase and tries again. */
  | { kind: 'needs-auth'; message: string }
  /** `mintRefused`: the target refused a code from this phone; the row asks for approval next. */
  | { kind: 'failed'; message: string; mintRefused?: string }

export interface AddMachineDeps {
  /** The session's host: it runs SSH and pairs. */
  session: Pick<HostApi, 'hostsAddOverSsh' | 'hostsPair'>
  /** A host this phone reaches, to make a code there; null when it is not connected. */
  target: (serverId: string) => Pick<HostApi, 'connectionsGeneratePairToken'> | null
  /** Names the session host's device on a machine added over SSH. */
  deviceLabel: string
}

/** The values one attempt sends. They are given for this attempt only and not kept. */
export interface AddMachineInput {
  /** `ssh`: matches the progress events of this attempt. */
  requestId?: string
  /** `ssh`: a password or key passphrase after `needs-auth`. */
  authSecret?: string
  /** `approve`: the check code the card already shows. */
  checkCode?: string
  /** `code`: the typed code, already checked with `typedCodeValue`. */
  code?: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs one step on the session host. Every refusal becomes a message on the card. */
export async function attemptAddMachine(deps: AddMachineDeps, step: AddMachineStep, input: AddMachineInput): Promise<AddMachineAttempt> {
  const added = (installationId: string, label: string): AddMachineAttempt => ({
    kind: 'added',
    outcome: { status: 'added', installationId, way: wayOf(step) },
    label,
  })
  try {
    switch (step.kind) {
      case 'ssh': {
        if (!input.requestId) return { kind: 'failed', message: 'The SSH add has no request id.' }
        const result = await deps.session.hostsAddOverSsh({
          sshTarget: step.sshTarget,
          requestId: input.requestId,
          deviceLabel: deps.deviceLabel,
          ...(input.authSecret ? { authSecret: input.authSecret } : {}),
        })
        if (result.status === 'needs-auth') return { kind: 'needs-auth', message: result.message }
        if (result.status === 'needs-target') return { kind: 'failed', message: result.message }
        if (result.status === 'forwarded') return added(result.host.installationId, result.host.label)
        return added(result.installationId, result.label)
      }
      case 'mint': {
        const target = deps.target(step.serverId)
        if (!target) return { kind: 'failed', message: `This device cannot reach ${step.name} now. Ask it to approve instead.`, mintRefused: step.serverId }
        let code: string
        try {
          code = (await target.connectionsGeneratePairToken()).code
        } catch (error) {
          return { kind: 'failed', message: `${step.name} did not make a code for this device: ${messageOf(error)}. Ask it to approve instead.`, mintRefused: step.serverId }
        }
        const listing = await deps.session.hostsPair({ url: step.url, code })
        return added(listing.installationId, listing.label)
      }
      case 'approve': {
        if (!input.checkCode) return { kind: 'failed', message: 'The approval request has no check code.' }
        const listing = await deps.session.hostsPair({ url: step.url, checkCode: input.checkCode })
        return added(listing.installationId, listing.label)
      }
      case 'code': {
        if (!input.code) return { kind: 'failed', message: 'Enter the 6-digit pairing code, or paste the pair link.' }
        const listing = await deps.session.hostsPair({ url: step.url, code: input.code })
        return added(listing.installationId, listing.label)
      }
    }
  } catch (error) {
    return { kind: 'failed', message: messageOf(error) }
  }
}

/** The steps of one SSH add, from the session host. */
export function watchSshProgress(events: HostEventSubscriber, requestId: string, listener: (progress: SshAddProgress) => void): () => void {
  return events.subscribe('host.sshProgress', (progress) => {
    if (progress.requestId === requestId) listener(progress)
  })
}
