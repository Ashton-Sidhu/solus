import type { HostEventMap, HostEventName } from '@solus/contracts/host-events'
import type { ForwardedHost, SshAddLink, SshAddProgress, SshAddResult, SshAddStep, SshTargetCandidate, SshAddRequest } from '@solus/contracts/remote-machines'
import type { HostApi } from '@solus/client-core/host-api'

/**
 * Adding a machine over SSH from the phone (docs/plans/host-routes.md D6, D7).
 * A phone cannot run `ssh`: it asks a connected host to do it. With a link, the
 * new machine joins the account and every device reaches it through its tunnel.
 * Without one, the host that ran SSH holds a forward to it, and only that host
 * can dial it.
 */

/** The narrow part of a host connection the add uses. */
export interface SshAddConnection {
  readonly api: Pick<HostApi, 'hostsAddOverSsh'>
  readonly events: { subscribe<K extends HostEventName>(type: K, listener: (payload: HostEventMap[K]) => void): () => void }
}

/** A connected host that can run SSH for the phone. */
export interface SshRunner {
  readonly hostId: string
  readonly label: string
  readonly lastConnected: number
}

/**
 * The hosts that can run SSH now: connected, and the phone may use their
 * local reach (`host.local.reach`). The first is the default: the route's
 * host when it qualifies, else the host this phone connected to last.
 */
export function sshRunnerChoices(
  hosts: readonly SshRunner[],
  canRun: (hostId: string) => boolean,
  preferredHostId?: string,
): SshRunner[] {
  const choices = hosts.filter((host) => canRun(host.hostId)).sort((a, b) => b.lastConnected - a.lastConnected)
  const preferred = choices.findIndex((host) => host.hostId === preferredHostId)
  if (preferred > 0) choices.unshift(...choices.splice(preferred, 1))
  return choices
}

export interface SshAddForm {
  readonly runnerHostId: string | null
  readonly sshTarget: string
  /** Link the new machine to the person's Solus account. Possible only while signed in. */
  readonly shouldLink: boolean
  /** A password or key passphrase, sent only with a link: a forward needs a key. */
  readonly authSecret: string
}

/** Why the form cannot be sent, or null when it can. */
export function sshAddFormIssue(form: SshAddForm): string | null {
  if (!form.runnerHostId) return 'Connect a computer running Solus first. It runs SSH for this phone.'
  if (!form.sshTarget.trim()) return 'Enter an SSH target, such as user@machine or an alias from ~/.ssh/config.'
  return null
}

/** The request one add sends. The secret goes only with a link, as the host requires. */
export function sshAddRequest(form: SshAddForm, requestId: string, deviceLabel: string, link: SshAddLink | null): SshAddRequest {
  const request: SshAddRequest = { sshTarget: form.sshTarget.trim(), requestId, deviceLabel }
  if (link) {
    request.link = link
    if (form.authSecret) request.authSecret = form.authSecret
  }
  return request
}

/**
 * Runs one add on the runner host. Progress for this request goes to
 * `onProgress`; the subscription ends with the call. A link asks the account
 * for a ticket first, so a phone that is signed out cannot link.
 */
export async function runSshAdd(
  connection: SshAddConnection,
  form: SshAddForm,
  options: {
    readonly requestId: string
    readonly deviceLabel: string
    readonly issueTicket: () => Promise<SshAddLink | null>
    readonly onProgress: (progress: SshAddProgress) => void
  },
): Promise<SshAddResult> {
  let link: SshAddLink | null = null
  if (form.shouldLink) {
    const ticket = await options.issueTicket()
    if (!ticket) throw new Error('Sign in to Solus Cloud to link this machine to your account.')
    link = { ticket: ticket.ticket, directoryUrl: ticket.directoryUrl }
  }
  const stop = connection.events.subscribe('host.sshProgress', (progress) => {
    if (progress.requestId === options.requestId) options.onProgress(progress)
  })
  try {
    return await connection.api.hostsAddOverSsh(sshAddRequest(form, options.requestId, options.deviceLabel, link))
  } finally {
    stop()
  }
}

/** What the screen shows after the runner host answered. */
export type SshAddOutcome =
  /** SSH refused the key. With a link a password can be given; a forward needs a key. */
  | { kind: 'ask-auth'; sshTarget: string; message: string; canUsePassword: boolean }
  | { kind: 'ask-target'; candidates: SshTargetCandidate[]; defaultTarget: string; message: string }
  | { kind: 'linked'; installationId: string; label: string; note: string }
  /** Only the runner host reaches it. The phone offers a link. */
  | { kind: 'forwarded'; host: ForwardedHost; note: string }
  /** The runner reached a server it found on its network. The phone did not ask for this. */
  | { kind: 'reached'; label: string; note: string }

export function sshAddOutcome(result: SshAddResult, runnerLabel: string, wasLinking: boolean): SshAddOutcome {
  switch (result.status) {
    case 'needs-auth':
      return {
        kind: 'ask-auth',
        sshTarget: result.sshTarget,
        canUsePassword: wasLinking,
        message: wasLinking
          ? `${result.message} Enter the password or key passphrase for ${result.sshTarget}.`
          : `${result.message} A machine that is not linked to your account needs an SSH key on ${runnerLabel}. Add a key, or link the machine to your account to use a password.`,
      }
    case 'needs-target':
      return { kind: 'ask-target', candidates: result.candidates, defaultTarget: result.defaultTarget, message: result.message }
    case 'linked':
      return {
        kind: 'linked',
        installationId: result.installationId,
        label: result.label,
        note: linkedNote(result.label),
      }
    case 'forwarded':
      return { kind: 'forwarded', host: result.host, note: forwardedReachNote(result.host.label, runnerLabel) }
    case 'session':
      return { kind: 'reached', label: result.label, note: `${runnerLabel} reached ${result.label} on its network. Pair this phone with ${result.label} to use it here.` }
  }
}

export function linkedNote(label: string): string {
  return `${label} is linked to your Solus account. It shows in your hosts, and this phone reaches it through your account.`
}

export function forwardedReachNote(label: string, runnerLabel: string): string {
  return `${label} is reachable only from ${runnerLabel}. Link it to your account to reach it from this phone.`
}

const STEP_LABELS = {
  connect: 'Connecting',
  check: 'Checking the machine',
  install: 'Installing Solus',
  start: 'Starting Solus',
  identity: 'Reading its identity',
  link: 'Linking to your account',
  forward: 'Opening the SSH forward',
} satisfies Record<SshAddStep, string>

/** One line per step, newest message last: a step that repeats shows only its latest message. */
export function sshProgressLines(progress: readonly SshAddProgress[]): { step: SshAddStep; title: string; message: string; isCurrent: boolean }[] {
  const lines: { step: SshAddStep; title: string; message: string; isCurrent: boolean }[] = []
  for (const event of progress) {
    const line = { step: event.step, title: STEP_LABELS[event.step], message: event.message, isCurrent: false }
    const index = lines.findIndex((existing) => existing.step === event.step)
    if (index >= 0) lines.splice(index, 1)
    lines.push(line)
  }
  if (lines.length > 0) lines[lines.length - 1]!.isCurrent = true
  return lines
}
