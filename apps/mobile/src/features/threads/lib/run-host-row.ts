import { isSessionBusyStatus, type SessionStatus } from '@solus/contracts/types'

/**
 * The host control of a started session on the phone
 * (docs/plans/portable-sessions.md §10): which hosts can run the next prompt,
 * whether the choice is open now, and the state of the host with the newest
 * turn. Desktop and web draw the same rule as Run on under the composer.
 */

export interface RunHostChoice {
  hostId: string
  label: string
  /** Connected now: the host can take a sync and a prompt. */
  isReady: boolean
  /** Past its grace and not back: the host is offline. */
  isAway: boolean
}

export interface RunHostRowInput {
  runHostId: string
  /** The host knows the session: only a started session changes its host here. */
  isStarted: boolean
  mayDrive: boolean
  status: SessionStatus
  backgroundWorkRunning: boolean
  /** A prompt this device holds that the host has not taken yet. */
  hasUnsentPrompts: boolean
  /** Files uploaded to the run host, or uploading, for the next prompt. */
  hasAttachments: boolean
  hosts: readonly RunHostChoice[]
  /** The host with the newest turn, from the facts; null when none is known. */
  newestHostId: string | null
}

export interface RunHostRowView {
  /** Another host can be chosen. */
  isShown: boolean
  /** A turn runs, a prompt waits for its host, or files wait for the next prompt: the host stays. */
  isLocked: boolean
  runHostLabel: string
  /** The host with the newest turn is offline: "<host> is offline". */
  offlineHostLabel: string | null
  /** The run host is offline, and another host can take the session: the
   *  composer stays, so the person can type and choose that host. */
  keepsComposerWhileAway: boolean
  choices: readonly RunHostChoice[]
}

export function runHostRowView(input: RunHostRowInput): RunHostRowView {
  const runHost = input.hosts.find((host) => host.hostId === input.runHostId)
  const isShown = input.isStarted && input.mayDrive
    && input.hosts.some((host) => host.hostId !== input.runHostId && host.isReady)
  const isLocked = isSessionBusyStatus(input.status) || input.backgroundWorkRunning
    || input.hasUnsentPrompts || input.hasAttachments
  const newest = input.newestHostId ? input.hosts.find((host) => host.hostId === input.newestHostId) : undefined
  return {
    isShown,
    isLocked,
    runHostLabel: runHost?.label ?? 'This host',
    offlineHostLabel: newest?.isAway ? newest.label : null,
    keepsComposerWhileAway: isShown && runHost?.isAway === true && newest !== undefined,
    choices: input.hosts,
  }
}

/** What the composer row says beside the host control. */
export function runHostRowNote(view: RunHostRowView): string | null {
  return view.offlineHostLabel ? `${view.offlineHostLabel} is offline` : null
}
